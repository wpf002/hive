"""Monitor worker entry — runs MonitorWorker forever."""
from __future__ import annotations
import asyncio
from hive_base import HiveWorker
from .http_check import http_endpoint_monitor
from .heartbeat import cron_heartbeat


class MonitorWorker(HiveWorker):
    pool_type = "monitor"
    capacity = 16

    async def setup(self) -> None:
        self.register("HTTP Endpoint Monitor", http_endpoint_monitor)
        self.register("Cron Heartbeat", cron_heartbeat)


def main() -> None:
    asyncio.run(MonitorWorker().run())


if __name__ == "__main__":
    main()
