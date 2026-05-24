"""Base worker class — all pools inherit from this."""
from __future__ import annotations
from abc import ABC, abstractmethod
from typing import Any
import structlog

log = structlog.get_logger()


class HiveWorker(ABC):
    pool_type: str = ""

    @abstractmethod
    async def execute(self, config: dict[str, Any]) -> dict[str, Any]:
        """Execute a single job. Return result dict."""
        ...

    async def run(self) -> None:
        log.info("worker.start", pool=self.pool_type)
        # Phase 1: poll Redis queue, execute jobs, publish results
