"""HiveWorker — abstract base. Subclasses register handler fns keyed by template name."""
from __future__ import annotations
import asyncio
import json
import signal
import socket
import traceback
import uuid
from abc import ABC, abstractmethod
from typing import Any, Awaitable, Callable, Optional
import redis.asyncio as redis_async
import structlog
from .settings import Settings, load_settings
from .logging import configure_logging
from .joblog import JobLogger
from . import db as dbmod
from .heartbeat import Heartbeat

log = structlog.get_logger()

Handler = Callable[[dict[str, Any], JobLogger], Awaitable[Any]]


DLQ_STREAM = "hive:dlq"


def drain_key(worker_id: str) -> str:
    return f"hive:worker:{worker_id}:drain"


class HiveWorker(ABC):
    pool_type: str = ""
    capacity: int = 4
    max_attempts: int = 3
    # Phase 4c — pools that share a single hardware resource (mouse/keyboard,
    # GPU, etc.) set this True. The API rejects parallel dispatch with 429 when
    # any worker in the pool is singleton + busy.
    singleton: bool = False

    def __init__(self, settings: Optional[Settings] = None) -> None:
        self.settings = settings or load_settings()
        self.worker_id = f"{self.pool_type}-{socket.gethostname()}-{uuid.uuid4().hex[:8]}"
        self._handlers: dict[str, Handler] = {}
        self._active_jobs = 0
        self._sem = asyncio.Semaphore(self.capacity)
        self._redis_main: Optional[redis_async.Redis] = None
        self._redis_block: Optional[redis_async.Redis] = None
        self._heartbeat: Optional[Heartbeat] = None
        self._status: str = "online"  # online | draining
        self._should_exit = False
        self._in_flight_jobs: set[str] = set()

    def register(self, template_name: str, handler: Handler) -> None:
        self._handlers[template_name] = handler

    @abstractmethod
    async def setup(self) -> None:
        """Subclasses register their handlers here."""
        ...

    @property
    def stream(self) -> str:
        return f"hive:pool:{self.pool_type}"

    @property
    def group(self) -> str:
        return f"hive:pool:{self.pool_type}:workers"

    async def _ensure_group(self) -> None:
        assert self._redis_main is not None
        try:
            await self._redis_main.xgroup_create(self.stream, self.group, id="$", mkstream=True)
            log.info("worker.group_created", group=self.group, stream=self.stream)
        except Exception as e:
            if "BUSYGROUP" in str(e):
                log.info("worker.group_exists", group=self.group)
            else:
                raise

    async def _process(self, data: dict[str, str]) -> None:
        job_id = data.get("jobId", "")
        bot_id = data.get("botId", "")
        template_name = data.get("templateName", "")
        config_raw = data.get("config", "{}")
        try:
            config = json.loads(config_raw)
        except Exception:
            config = {}

        joblog = JobLogger(
            job_id=job_id,
            redis_client=self._redis_main,  # type: ignore[arg-type]
            dsn=self.settings.DATABASE_URL,
        )

        handler = self._handlers.get(template_name)
        if handler is None:
            await joblog.error("unknown_template", template=template_name)
            await dbmod.mark_failed(self.settings.DATABASE_URL, job_id, f"no handler for template '{template_name}'")
            await joblog.flush()
            await joblog.signal_terminal("failed")
            return

        await dbmod.mark_running(self.settings.DATABASE_URL, job_id)
        await joblog.info("job.start", template=template_name, worker=self.worker_id)

        last_err: Optional[str] = None
        result: Any = None
        succeeded = False

        for attempt in range(1, self.max_attempts + 1):
            await dbmod.increment_attempts(self.settings.DATABASE_URL, job_id)
            if attempt > 1:
                await joblog.warn("job.retrying", attempt=attempt)
            try:
                result = await handler(config, joblog)
                succeeded = True
                last_err = None
                break
            except Exception as e:
                last_err = f"{type(e).__name__}: {e}"
                tb = traceback.format_exc(limit=8)
                await joblog.error("job.error", attempt=attempt, error=last_err, traceback=tb)

        if succeeded:
            await dbmod.mark_succeeded(self.settings.DATABASE_URL, job_id, result)
            await joblog.info("job.succeeded")
            terminal_status = "succeeded"
        else:
            await dbmod.mark_failed(self.settings.DATABASE_URL, job_id, last_err or "unknown error")
            await joblog.error("job.dead_letter", maxAttempts=self.max_attempts)
            try:
                from datetime import datetime, timezone
                assert self._redis_main is not None
                await self._redis_main.xadd(
                    DLQ_STREAM,
                    {
                        "jobId": job_id,
                        "botId": bot_id,
                        "pool": self.pool_type,
                        "templateName": template_name,
                        "config": config_raw,
                        "error": last_err or "unknown error",
                        "failedAt": datetime.now(timezone.utc).isoformat(),
                        "workerId": self.worker_id,
                    },
                )
            except Exception as e:
                log.error("dlq_xadd_failed", err=str(e), job_id=job_id)
            terminal_status = "failed"

        await joblog.flush()
        await joblog.signal_terminal(terminal_status)

    async def _consume_one(self, entry_id: str, fields_map: dict[str, str]) -> None:
        async with self._sem:
            self._active_jobs += 1
            job_id = fields_map.get("jobId", "")
            if job_id:
                self._in_flight_jobs.add(job_id)
            try:
                await self._process(fields_map)
            finally:
                if job_id:
                    self._in_flight_jobs.discard(job_id)
                self._active_jobs -= 1
                try:
                    assert self._redis_main is not None
                    await self._redis_main.xack(self.stream, self.group, entry_id)
                except Exception as e:
                    log.error("worker.xack_failed", err=str(e), entry_id=entry_id)

    async def _graceful_shutdown(self, sig: str) -> None:
        log.info("worker.signal", sig=sig, in_flight=len(self._in_flight_jobs))
        self._should_exit = True
        # Wait up to 5s for in-flight to settle naturally.
        for _ in range(50):
            if not self._in_flight_jobs:
                break
            await asyncio.sleep(0.1)
        # Anything still in-flight on shutdown gets marked failed so the UI doesn't
        # show forever-"running" jobs (e.g. long-lived Discord slash listeners).
        for jid in list(self._in_flight_jobs):
            try:
                await dbmod.mark_failed(
                    self.settings.DATABASE_URL, jid, "worker_killed (graceful shutdown)"
                )
            except Exception as e:
                log.error("worker.mark_failed_on_shutdown_err", err=str(e), job_id=jid)

    async def _check_drain(self) -> bool:
        try:
            assert self._redis_main is not None
            val = await self._redis_main.get(drain_key(self.worker_id))
            return val == "1"
        except Exception:
            return False

    async def _consume_loop(self) -> None:
        assert self._redis_block is not None
        consumer_name = self.worker_id
        log.info("worker.consume_loop.start", stream=self.stream, consumer=consumer_name)
        while not self._should_exit:
            if await self._check_drain():
                if self._status != "draining":
                    self._status = "draining"
                    log.info("worker.draining", worker_id=self.worker_id)
                if self._active_jobs == 0:
                    log.info("worker.drained_exit", worker_id=self.worker_id)
                    return
                await asyncio.sleep(1.0)
                continue
            res = await self._redis_block.xreadgroup(
                self.group,
                consumer_name,
                {self.stream: ">"},
                count=self.capacity,
                block=5000,
            )
            if not res:
                continue
            for _stream_name, entries in res:
                for entry_id, fields_map in entries:
                    asyncio.create_task(self._consume_one(entry_id, fields_map))

    async def run(self) -> None:
        configure_logging(
            level=self.settings.LOG_LEVEL,
            service=f"worker-{self.pool_type}",
            dev=self.settings.NODE_ENV == "development",
        )
        await self.setup()
        if not self._handlers:
            raise RuntimeError(f"{self.__class__.__name__}.setup() did not register any handlers")

        self._redis_main = redis_async.from_url(self.settings.REDIS_URL, decode_responses=True)
        self._redis_block = redis_async.from_url(
            self.settings.REDIS_URL,
            decode_responses=True,
            socket_keepalive=True,
        )
        await self._ensure_group()

        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(
                    sig,
                    lambda s=sig: asyncio.create_task(self._graceful_shutdown(s.name)),
                )
            except (NotImplementedError, RuntimeError):
                # Windows / non-main-thread: fall back to default handlers.
                pass

        self._heartbeat = Heartbeat(
            worker_id=self.worker_id,
            pool_type=self.pool_type,
            capacity=self.capacity,
            api_base_url=self.settings.API_BASE_URL,
            auth_token=self.settings.WORKER_AUTH_TOKEN,
            get_active_jobs=lambda: self._active_jobs,
            get_status=lambda: self._status,
            extra_metadata={"singleton": True} if self.singleton else None,
        )
        self._heartbeat.start()

        log.info("worker.start", pool=self.pool_type, worker_id=self.worker_id, capacity=self.capacity)
        try:
            await self._consume_loop()
        finally:
            if self._heartbeat:
                await self._heartbeat.stop()
            if self._redis_main:
                await self._redis_main.aclose()
            if self._redis_block:
                await self._redis_block.aclose()
