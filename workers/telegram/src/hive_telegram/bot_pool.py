"""Per-token Telegram Bot cache.

python-telegram-bot's `Bot` is lightweight (just an HTTP client wrapper around
the Bot API) but creating one per call wastes connection-pool warm-up. We keep
one `Bot` per token for the worker's lifetime.

TODO(phase-4): tokens are stored plaintext in BotTemplate.config — encrypt at
rest before any non-dev deployment.
"""
from __future__ import annotations
import asyncio
from telegram import Bot
from telegram.request import HTTPXRequest


class TelegramBotPool:
    def __init__(self) -> None:
        self._bots: dict[str, Bot] = {}
        self._lock = asyncio.Lock()

    async def get(self, token: str) -> Bot:
        async with self._lock:
            bot = self._bots.get(token)
            if bot is not None:
                return bot
            request = HTTPXRequest(connection_pool_size=4)
            bot = Bot(token=token, request=request)
            self._bots[token] = bot
            return bot

    async def close_all(self) -> None:
        for bot in self._bots.values():
            try:
                await bot.shutdown()
            except Exception:
                pass
        self._bots.clear()
