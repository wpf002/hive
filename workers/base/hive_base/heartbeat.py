"""Background heartbeat task — POSTs worker status to the API every 10s."""
from __future__ import annotations
import asyncio
import socket
from typing import Optional
import httpx
import structlog

log = structlog.get_logger()
DEFAULT_INTERVAL_S = 10.0


class Heartbeat:
    def __init__(
        self,
        *,
        worker_id: str,
        pool_type: str,
        capacity: int,
        api_base_url: str,
        auth_token: str,
        get_active_jobs: callable,  # type: ignore[type-arg]
        get_status: Optional[callable] = None,  # type: ignore[type-arg]
        hostname: Optional[str] = None,
        region: str = "local",
        zone: str = "default",
        interval_s: float = DEFAULT_INTERVAL_S,
        extra_metadata: Optional[dict] = None,
    ) -> None:
        self.worker_id = worker_id
        self.pool_type = pool_type
        self.capacity = capacity
        self.api_base_url = api_base_url.rstrip("/")
        self.auth_token = auth_token
        self.get_active_jobs = get_active_jobs
        self.get_status = get_status
        self.hostname = hostname or socket.gethostname()
        self.region = region
        self.zone = zone
        self.interval_s = interval_s
        self.extra_metadata = extra_metadata or {}
        self._task: Optional[asyncio.Task] = None

    async def _send_once(self, client: httpx.AsyncClient) -> None:
        try:
            status = self.get_status() if self.get_status else "online"
            metadata = {"status": status, "region": self.region, "zone": self.zone, **self.extra_metadata}
            r = await client.post(
                f"{self.api_base_url}/api/workers/heartbeat",
                json={
                    "workerId": self.worker_id,
                    "poolType": self.pool_type,
                    "hostname": self.hostname,
                    "region": self.region,
                    "zone": self.zone,
                    "capacity": self.capacity,
                    "activeJobs": int(self.get_active_jobs()),
                    "metadata": metadata,
                },
                headers={"Authorization": f"Bearer {self.auth_token}"},
                timeout=5.0,
            )
            if r.status_code >= 400:
                log.warn("heartbeat.bad_status", status=r.status_code, body=r.text[:200])
        except Exception as e:
            log.warn("heartbeat.failed", err=str(e))

    async def _run(self) -> None:
        async with httpx.AsyncClient() as client:
            while True:
                await self._send_once(client)
                await asyncio.sleep(self.interval_s)

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run(), name=f"heartbeat-{self.worker_id}")

    async def stop(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
