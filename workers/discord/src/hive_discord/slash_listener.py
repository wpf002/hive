"""Discord Slash Command Listener handler.

First long-running job type in Hive: registers a guild-scoped slash command,
listens for invocations for `durationSeconds`, replies to each with a rendered
template, then cleans up and exits.

Tagged 'discord_long_running' so future schedulers can avoid overlapping runs.
"""
from __future__ import annotations
import asyncio
import re
import textwrap
from datetime import datetime, timezone
from typing import Any, Callable
import discord
from discord import app_commands
from hive_base import JobLogger
from .client_pool import DiscordClientPool

LONG_RUNNING_TAG = "discord_long_running"
COMMAND_NAME_RE = re.compile(r"^[a-z0-9_-]{1,32}$")
ARG_TYPE_MAP = {"string": "str", "int": "int", "bool": "bool"}


def _render(template: str, kwargs: dict[str, Any]) -> str:
    out = template
    for k, v in kwargs.items():
        s = "" if v is None else str(v)
        out = out.replace("{{ " + k + " }}", s).replace("{{" + k + "}}", s)
    return out


def _build_callback(arg_schema: list[dict[str, Any]], body: Callable) -> Callable:
    """Build an async callback whose signature matches argSchema so discord.py's
    command inspector generates the correct slash command options."""
    sig_parts = ["interaction: discord.Interaction"]
    arg_names: list[str] = []
    for spec in arg_schema:
        name = spec["name"]
        if not re.match(r"^[a-z][a-z0-9_]{0,31}$", name):
            raise ValueError(f"arg name '{name}' must be lowercase alphanumeric+underscore (max 32)")
        py_type = ARG_TYPE_MAP[spec.get("type", "string")]
        arg_names.append(name)
        if spec.get("required"):
            sig_parts.append(f"{name}: {py_type}")
        else:
            sig_parts.append(f"{name}: {py_type} = None")
    args_pairs = ", ".join(f"'{n}': {n}" for n in arg_names)
    src = textwrap.dedent(
        f"""
        async def __cmd({", ".join(sig_parts)}):
            await __body(interaction, {{{args_pairs}}})
        """
    ).strip()
    ns: dict[str, Any] = {"discord": discord, "__body": body}
    exec(src, ns)  # noqa: S102 - controlled, sanitized inputs
    cb = ns["__cmd"]
    # Apply describe() so each option has a label other than '…'.
    describes = {spec["name"]: (spec.get("description") or spec["name"]) for spec in arg_schema}
    if describes:
        cb = app_commands.describe(**describes)(cb)
    return cb


def make_handler(pool: DiscordClientPool):
    async def handler(config: dict[str, Any], joblog: JobLogger) -> dict[str, Any]:
        bot_token = config.get("botToken")
        guild_id = config.get("guildId")
        command_name = config.get("commandName")
        command_desc = config.get("commandDescription")
        response_template = config.get("responseTemplate")
        arg_schema = config.get("argSchema") or []
        duration_seconds = int(config.get("durationSeconds", 3600))

        if not isinstance(bot_token, str) or not bot_token:
            raise ValueError("botToken is required")
        if not isinstance(guild_id, str) or not guild_id:
            raise ValueError("guildId is required")
        if not isinstance(command_name, str) or not COMMAND_NAME_RE.match(command_name):
            raise ValueError(
                f"commandName must match {COMMAND_NAME_RE.pattern} (lowercase, no spaces, ≤32 chars)"
            )
        if not isinstance(command_desc, str) or not command_desc:
            raise ValueError("commandDescription is required")
        if not isinstance(response_template, str) or not response_template:
            raise ValueError("responseTemplate is required")
        if duration_seconds <= 0 or duration_seconds > 24 * 3600:
            raise ValueError("durationSeconds must be in (0, 86400]")
        if not isinstance(arg_schema, list):
            raise ValueError("argSchema must be a list")
        for a in arg_schema:
            if a.get("type") not in ARG_TYPE_MAP:
                raise ValueError(f"argSchema entry has bad type: {a.get('type')}")

        client, tree = await pool.get(bot_token)
        guild_obj = discord.Object(id=int(guild_id))

        invocation_count = 0
        registered_at = datetime.now(timezone.utc)

        async def invoke_body(interaction: discord.Interaction, kwargs: dict[str, Any]) -> None:
            nonlocal invocation_count
            invocation_count += 1
            rendered = _render(response_template, kwargs)
            try:
                await interaction.response.send_message(rendered, ephemeral=False)
            except Exception as e:
                await joblog.error("slash.reply_failed", error=str(e))
                return
            await joblog.info(
                "slash.invoked",
                user=str(interaction.user),
                userId=str(interaction.user.id),
                args=kwargs,
                replyChars=len(rendered),
            )

        callback = _build_callback(arg_schema, invoke_body)
        cmd = app_commands.Command(
            name=command_name,
            description=command_desc[:100],
            callback=callback,
        )
        tree.add_command(cmd, guild=guild_obj)

        try:
            synced = await tree.sync(guild=guild_obj)
            await joblog.info(
                "slash.registered",
                commandName=command_name,
                guildId=guild_id,
                durationSeconds=duration_seconds,
                synced=len(synced),
            )
        except discord.Forbidden:
            tree.remove_command(command_name, guild=guild_obj)
            raise RuntimeError(
                "bot lacks applications.commands scope in this guild; re-invite with the scope set"
            )
        except discord.HTTPException as e:
            tree.remove_command(command_name, guild=guild_obj)
            raise RuntimeError(f"failed to register slash command: {e}")

        try:
            await asyncio.sleep(duration_seconds)
        finally:
            tree.remove_command(command_name, guild=guild_obj)
            try:
                await tree.sync(guild=guild_obj)
            except Exception as e:
                await joblog.warn("slash.cleanup_sync_failed", error=str(e))

        result = {
            "commandName": command_name,
            "guildId": guild_id,
            "invocationCount": invocation_count,
            "durationSeconds": duration_seconds,
            "registeredAt": registered_at.isoformat(),
            "exitedAt": datetime.now(timezone.utc).isoformat(),
        }
        await joblog.info("slash.exited", **result)
        return result

    handler.hive_tags = {LONG_RUNNING_TAG}  # type: ignore[attr-defined]
    return handler
