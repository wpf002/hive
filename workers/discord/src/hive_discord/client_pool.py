"""Per-token Discord client cache.

Discord clients are heavy (websocket gateway connection + handshake), so we keep
one client per bot token and reuse it across jobs for the worker's lifetime.

The client runs as a background task in the worker's event loop. We wait for
on_ready before returning the client so callers can immediately use it.

TODO(phase-4): tokens are stored plaintext in BotTemplate.config — add
encryption-at-rest with libsodium or pgcrypto before any non-dev deployment.
"""
from __future__ import annotations
import asyncio
from typing import Optional
import discord
import structlog

log = structlog.get_logger()


class _Slot:
    __slots__ = ("client", "task", "ready", "tree")

    def __init__(
        self,
        client: discord.Client,
        task: asyncio.Task,
        ready: asyncio.Event,
        tree: discord.app_commands.CommandTree,
    ) -> None:
        self.client = client
        self.task = task
        self.ready = ready
        self.tree = tree


class DiscordClientPool:
    """One Client per bot token. Thread-unsafe; designed for a single event loop."""

    def __init__(self) -> None:
        self._slots: dict[str, _Slot] = {}
        self._lock = asyncio.Lock()

    async def get(self, token: str) -> tuple[discord.Client, discord.app_commands.CommandTree]:
        async with self._lock:
            slot = self._slots.get(token)
            if slot is not None and not slot.task.done():
                await slot.ready.wait()
                return slot.client, slot.tree

            intents = discord.Intents.default()
            intents.message_content = False  # not needed for posting + slash
            client = discord.Client(intents=intents)
            tree = discord.app_commands.CommandTree(client)
            ready = asyncio.Event()

            @client.event
            async def on_ready() -> None:
                log.info(
                    "discord.client_ready",
                    user=str(client.user),
                    guilds=len(client.guilds),
                )
                ready.set()

            task = asyncio.create_task(
                client.start(token), name=f"discord-client-{_short(token)}"
            )
            slot = _Slot(client, task, ready, tree)
            self._slots[token] = slot

            done, _pending = await asyncio.wait(
                [asyncio.create_task(ready.wait()), task],
                return_when=asyncio.FIRST_COMPLETED,
                timeout=30.0,
            )
            if not ready.is_set():
                self._slots.pop(token, None)
                if task.done():
                    exc: Optional[BaseException] = task.exception()
                    raise RuntimeError(
                        f"discord client failed to connect: {type(exc).__name__ if exc else 'timeout'}: {exc}"
                    )
                # Timed out before READY — cancel and bail.
                task.cancel()
                raise RuntimeError("discord client did not become ready within 30s")
            return client, tree

    async def close_all(self) -> None:
        for token, slot in list(self._slots.items()):
            try:
                await slot.client.close()
            except Exception as e:
                log.warn("discord.close_err", token=_short(token), err=str(e))
            if not slot.task.done():
                slot.task.cancel()
        self._slots.clear()


def _short(token: str) -> str:
    return token[-6:] if len(token) > 6 else "***"
