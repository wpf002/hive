"""Per-job logger: publishes live to Redis pub/sub + buffers for batched Postgres inserts."""
from __future__ import annotations
import asyncio
import json
from datetime import datetime, timezone
from typing import Any, Optional
import redis.asyncio as redis_async
from . import db as dbmod

FLUSH_BATCH = 50


class JobLogger:
    """One JobLogger per job. Use .info()/.warn()/.error()/.debug() then .flush() at end."""

    def __init__(
        self,
        *,
        job_id: str,
        redis_client: redis_async.Redis,
        dsn: str,
        batch_size: int = FLUSH_BATCH,
    ) -> None:
        self.job_id = job_id
        self._redis = redis_client
        self._dsn = dsn
        self._batch_size = batch_size
        self._buffer: list[dict[str, Any]] = []
        self._lock = asyncio.Lock()
        self._channel = f"hive:logs:{job_id}"

    async def _emit(self, level: str, message: str, meta: Optional[dict[str, Any]] = None) -> None:
        ts = datetime.now(timezone.utc)
        payload = {
            "ts": ts.isoformat(),
            "level": level,
            "message": message,
            "meta": meta,
        }
        # Live publish.
        try:
            await self._redis.publish(self._channel, json.dumps(payload, default=str))
        except Exception:
            # Logging must never crash the job; swallow.
            pass
        # Buffer for Postgres.
        row = {
            "id": dbmod.cuid_like(),
            "jobId": self.job_id,
            "level": level,
            "message": message,
            "meta": meta,
            "timestamp": ts,
        }
        async with self._lock:
            self._buffer.append(row)
            if len(self._buffer) >= self._batch_size:
                await self._flush_locked()

    async def _flush_locked(self) -> None:
        if not self._buffer:
            return
        rows = self._buffer
        self._buffer = []
        try:
            await dbmod.insert_logs(self._dsn, rows)
        except Exception:
            # Don't lose them — put them back at the head; but cap to avoid runaway.
            self._buffer = (rows + self._buffer)[:1000]

    async def flush(self) -> None:
        async with self._lock:
            await self._flush_locked()

    async def info(self, message: str, **meta: Any) -> None:
        await self._emit("info", message, meta or None)

    async def warn(self, message: str, **meta: Any) -> None:
        await self._emit("warn", message, meta or None)

    async def error(self, message: str, **meta: Any) -> None:
        await self._emit("error", message, meta or None)

    async def debug(self, message: str, **meta: Any) -> None:
        await self._emit("debug", message, meta or None)

    async def signal_terminal(self, status: str) -> None:
        """Tell SSE subscribers the job is done so they can close cleanly."""
        try:
            await self._redis.publish(
                self._channel,
                json.dumps({"__terminal": True, "status": status}),
            )
        except Exception:
            pass
