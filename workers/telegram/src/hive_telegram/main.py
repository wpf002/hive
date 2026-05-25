"""Telegram worker entry point."""
from __future__ import annotations
import asyncio
from typing import Optional
from hive_base import HiveWorker, Settings
from .bot_pool import TelegramBotPool
from .channel_poster import make_handler as make_channel_handler
from .dm_alerter import make_handler as make_dm_handler


CHANNEL_POSTER = "Telegram Channel Poster"
DM_ALERTER = "Telegram DM Alerter"


class TelegramWorker(HiveWorker):
    pool_type = "telegram"
    capacity = 8

    def __init__(self, settings: Optional[Settings] = None) -> None:
        super().__init__(settings)
        self.bot_pool = TelegramBotPool()

    async def setup(self) -> None:
        self.register(CHANNEL_POSTER, make_channel_handler(self.bot_pool))
        self.register(DM_ALERTER, make_dm_handler(self.bot_pool))

    async def run(self) -> None:
        try:
            await super().run()
        finally:
            await self.bot_pool.close_all()


def main() -> None:
    asyncio.run(TelegramWorker().run())


if __name__ == "__main__":
    main()
