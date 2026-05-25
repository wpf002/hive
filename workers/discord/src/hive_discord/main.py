"""Discord worker entry point."""
from __future__ import annotations
import asyncio
from typing import Optional
from hive_base import HiveWorker, Settings
from .client_pool import DiscordClientPool
from .channel_poster import make_handler as make_channel_handler
from .dm_sender import make_handler as make_dm_handler
from .slash_listener import make_handler as make_slash_handler


CHANNEL_POSTER = "Discord Channel Poster"
DM_SENDER = "Discord DM Sender"
SLASH_LISTENER = "Discord Slash Command Listener"


class DiscordWorker(HiveWorker):
    pool_type = "discord"
    capacity = 4

    def __init__(self, settings: Optional[Settings] = None) -> None:
        super().__init__(settings)
        self.discord_pool = DiscordClientPool()

    async def setup(self) -> None:
        self.register(CHANNEL_POSTER, make_channel_handler(self.discord_pool))
        self.register(DM_SENDER, make_dm_handler(self.discord_pool))
        self.register(SLASH_LISTENER, make_slash_handler(self.discord_pool))

    async def run(self) -> None:
        try:
            await super().run()
        finally:
            await self.discord_pool.close_all()


def main() -> None:
    asyncio.run(DiscordWorker().run())


if __name__ == "__main__":
    main()
