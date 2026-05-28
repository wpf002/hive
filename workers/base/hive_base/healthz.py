"""Optional /healthz HTTP server for Python workers (Phase 6c.2).

Dependency-free: a minimal asyncio HTTP/1.1 server (no aiohttp). Enabled only
when HIVE_WORKER_HEALTHZ_PORT > 0 — workers are stream consumers, not HTTP
services, so this is opt-in and doesn't change default behavior.

Returns the same JSON shape as the control-plane /healthz endpoints:
    {status, service, version, region, uptime_seconds, checks: {...}}
with HTTP 200 when healthy and 503 when degraded. A 5s cache keeps frequent
external monitor polls from hammering Redis.
"""
from __future__ import annotations
import asyncio
import json
import os
import time
from typing import Any, Awaitable, Callable, Optional

import structlog

log = structlog.get_logger()

HEARTBEAT_FRESH_S = 30.0
CACHE_S = 5.0


def _region() -> str:
    return os.environ.get("HIVE_WORKER_REGION") or os.environ.get("FLY_REGION") or "local"


def _version() -> str:
    return os.environ.get("HIVE_VERSION") or os.environ.get("FLY_IMAGE_REF") or "0.1.0"


class WorkerHealthz:
    def __init__(
        self,
        *,
        port: int,
        pool_type: str,
        check_fn: Callable[[], Awaitable[dict[str, dict[str, Any]]]],
    ) -> None:
        self.port = port
        self.service = f"worker-{pool_type}"
        self.check_fn = check_fn
        self.started_at = time.time()
        self._server: Optional[asyncio.AbstractServer] = None
        self._cache: Optional[tuple[float, int, bytes]] = None  # (at, code, body)

    async def _snapshot(self) -> tuple[int, bytes]:
        now = time.time()
        if self._cache and now - self._cache[0] < CACHE_S:
            return self._cache[1], self._cache[2]
        try:
            checks = await self.check_fn()
        except Exception as e:  # noqa: BLE001
            checks = {"service": {"ok": False, "error": str(e)}}
        status = "ok" if all(c.get("ok") for c in checks.values()) else "degraded"
        body = json.dumps(
            {
                "status": status,
                "service": self.service,
                "version": _version(),
                "region": _region(),
                "uptime_seconds": int(now - self.started_at),
                "checks": checks,
            }
        ).encode()
        code = 200 if status == "ok" else 503
        self._cache = (now, code, body)
        return code, body

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            request_line = await reader.readline()
            # Drain headers (we don't use them, but must consume to be polite).
            while True:
                line = await reader.readline()
                if line in (b"\r\n", b"\n", b""):
                    break
            path = b""
            parts = request_line.split(b" ")
            if len(parts) >= 2:
                path = parts[1]
            if not path.startswith(b"/healthz"):
                writer.write(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
                await writer.drain()
                return
            code, body = await self._snapshot()
            reason = "OK" if code == 200 else "Service Unavailable"
            headers = (
                f"HTTP/1.1 {code} {reason}\r\n"
                "Content-Type: application/json\r\n"
                "Cache-Control: public, max-age=5\r\n"
                f"Content-Length: {len(body)}\r\n"
                "Connection: close\r\n\r\n"
            ).encode()
            writer.write(headers + body)
            await writer.drain()
        except Exception as e:  # noqa: BLE001
            log.warn("healthz.handler_error", err=str(e))
        finally:
            try:
                writer.close()
            except Exception:  # noqa: BLE001
                pass

    async def start(self) -> None:
        self._server = await asyncio.start_server(self._handle, "0.0.0.0", self.port)
        log.info("healthz.listening", port=self.port, service=self.service)

    async def stop(self) -> None:
        if self._server:
            self._server.close()
            try:
                await self._server.wait_closed()
            except Exception:  # noqa: BLE001
                pass
