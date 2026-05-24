"""Cron Heartbeat handler — minimal template that proves the monitor pool works."""
from __future__ import annotations
import socket
from datetime import datetime, timezone
from typing import Any
from hive_base import JobLogger


async def cron_heartbeat(config: dict[str, Any], joblog: JobLogger) -> dict[str, Any]:
    label = config.get("label")
    if not isinstance(label, str) or not label:
        raise ValueError("label is required")
    payload = config.get("payload") or {}
    await joblog.info("heartbeat.tick", label=label)
    return {
        "ok": True,
        "label": label,
        "payload": payload,
        "ranAt": datetime.now(timezone.utc).isoformat(),
        "hostname": socket.gethostname(),
    }
