"""Discord Channel Poster handler."""
from __future__ import annotations
from datetime import datetime, timezone
from typing import Any, Optional
import discord
from hive_base import JobLogger
from .client_pool import DiscordClientPool

MAX_CONTENT = 2000


def _build_embed(spec: dict[str, Any]) -> Optional[discord.Embed]:
    if not spec:
        return None
    color = spec.get("color")
    if isinstance(color, str) and color.startswith("#"):
        color = int(color[1:], 16)
    embed = discord.Embed(
        title=spec.get("title") or discord.Embed.Empty,
        description=spec.get("description") or discord.Embed.Empty,
        color=int(color) if isinstance(color, int) else discord.Embed.Empty,
    )
    for f in spec.get("fields") or []:
        name = f.get("name") or ""
        value = f.get("value") or ""
        if name and value:
            embed.add_field(name=name, value=value, inline=bool(f.get("inline")))
    return embed


def make_handler(pool: DiscordClientPool):
    async def handler(config: dict[str, Any], joblog: JobLogger) -> dict[str, Any]:
        bot_token = config.get("botToken")
        channel_id = config.get("channelId")
        content = config.get("content", "")
        if not isinstance(bot_token, str) or not bot_token:
            raise ValueError("botToken is required")
        if not isinstance(channel_id, str) or not channel_id:
            raise ValueError("channelId is required")
        if not isinstance(content, str) or not content:
            raise ValueError("content is required")
        if len(content) > MAX_CONTENT:
            raise ValueError(f"content exceeds {MAX_CONTENT} chars (got {len(content)})")

        embed_spec = config.get("embed") or {}
        if not isinstance(embed_spec, dict):
            raise ValueError("embed must be an object")
        mentions = config.get("mentions") or []
        if not isinstance(mentions, list):
            raise ValueError("mentions must be a list")

        await joblog.info("discord.connect", channelId=channel_id)
        client, _tree = await pool.get(bot_token)

        try:
            channel = client.get_channel(int(channel_id)) or await client.fetch_channel(int(channel_id))
        except discord.NotFound:
            raise RuntimeError(f"channel {channel_id} not found — is the bot in the guild?")
        except discord.Forbidden:
            raise RuntimeError(
                f"bot lacks access to channel {channel_id} — invite it to the guild with View Channel + Send Messages perms"
            )

        mention_str = " ".join(f"<@{uid}>" for uid in mentions if uid)
        full_content = (mention_str + " " + content).strip() if mention_str else content

        embed = _build_embed(embed_spec) if embed_spec else None
        try:
            msg = await channel.send(
                content=full_content,
                embed=embed,
                allowed_mentions=discord.AllowedMentions(
                    users=[discord.Object(id=int(u)) for u in mentions if u],
                ),
            )
        except discord.Forbidden:
            raise RuntimeError(
                f"bot cannot send messages to channel {channel_id} — needs Send Messages permission"
            )

        guild = getattr(channel, "guild", None)
        result = {
            "messageId": str(msg.id),
            "channelId": channel_id,
            "channelName": getattr(channel, "name", None),
            "guildName": guild.name if guild else None,
            "postedAt": datetime.now(timezone.utc).isoformat(),
        }
        await joblog.info("discord.message_posted", **result)
        return result

    return handler
