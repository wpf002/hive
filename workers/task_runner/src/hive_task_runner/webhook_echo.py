"""Generic Webhook Receiver Echo — tiny HTTP server, logs every request."""
from __future__ import annotations
import asyncio
import json
import time
from typing import Any

from aiohttp import web  # type: ignore[import-untyped]
from hive_base import JobLogger


DEFAULT_DURATION_S = 300
MAX_DURATION_S = 3600
MAX_REQUESTS_KEPT = 50


async def webhook_receiver_echo(config: dict[str, Any], joblog: JobLogger) -> dict[str, Any]:
    duration_s = min(MAX_DURATION_S, int(config.get("durationSeconds", DEFAULT_DURATION_S)))
    port = int(config.get("port") or 0)

    requests: list[dict[str, Any]] = []

    async def handle(req: web.BaseRequest) -> web.StreamResponse:
        try:
            body = (await req.read()).decode("utf-8", errors="replace")
        except Exception:
            body = ""
        entry = {
            "ts": time.time(),
            "method": req.method,
            "path": req.path,
            "query": dict(req.query),
            "headers": dict(req.headers),
            "body": body[:8192],  # cap to keep memory bounded
        }
        requests.append(entry)
        if len(requests) > MAX_REQUESTS_KEPT:
            del requests[: len(requests) - MAX_REQUESTS_KEPT]
        await joblog.info(
            "webhook.received",
            method=req.method,
            path=req.path,
            bytes=len(body),
        )
        return web.json_response({"ok": True, "received": entry})

    app = web.Application()
    app.router.add_route("*", "/{tail:.*}", handle)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", port)
    await site.start()

    # Resolve actual bound port when port=0.
    bound_port = port
    if port == 0:
        for s in site._server.sockets if site._server else []:  # type: ignore[attr-defined]
            sock_name = s.getsockname()
            if sock_name:
                bound_port = sock_name[1]
                break

    await joblog.info("webhook.listening", port=bound_port, durationSeconds=duration_s)
    try:
        await asyncio.sleep(duration_s)
    finally:
        await runner.cleanup()

    return {
        "port": bound_port,
        "durationSeconds": duration_s,
        "requestCount": len(requests),
        "requests": requests[-MAX_REQUESTS_KEPT:],
    }
