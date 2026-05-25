"""Discord DM Sender handler."""
from __future__ import annotations
from datetime import datetime, timezone
from typing import Any
import discord
from hive_base import JobLogger
from .client_pool import DiscordClientPool

MAX_CONTENT = 2000


def make_handler(pool: DiscordClientPool):
    async def handler(config: dict[str, Any], joblog: JobLogger) -> dict[str, Any]:
        bot_token = config.get("botToken")
        user_id = config.get("userId")
        content = config.get("content", "")
        if not isinstance(bot_token, str) or not bot_token:
            raise ValueError("botToken is required")
        if not isinstance(user_id, str) or not user_id:
            raise ValueError("userId is required")
        if not isinstance(content, str) or not content:
            raise ValueError("content is required")
        if len(content) > MAX_CONTENT:
            raise ValueError(f"content exceeds {MAX_CONTENT} chars (got {len(content)})")

        await joblog.info("discord.connect_dm", userId=user_id)
        client, _tree = await pool.get(bot_token)

        try:
            user = await client.fetch_user(int(user_id))
        except discord.NotFound:
            raise RuntimeError(f"user {user_id} not found")

        try:
            dm = user.dm_channel or await user.create_dm()
            msg = await dm.send(content=content)
        except discord.Forbidden:
            raise RuntimeError(
                f"cannot DM user {user_id} — Discord requires the user to share a guild with the bot"
            )

        result = {
            "messageId": str(msg.id),
            "userId": user_id,
            "postedAt": datetime.now(timezone.utc).isoformat(),
        }
        await joblog.info("discord.dm_sent", **result)
        return result

    return handler
