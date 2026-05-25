"""Telegram DM Alerter handler — personal page-me style alerts."""
from __future__ import annotations
from datetime import datetime, timezone
from typing import Any
from telegram import constants
from telegram.error import (
    Forbidden,
    InvalidToken,
    BadRequest,
    TelegramError,
)
from hive_base import JobLogger
from .bot_pool import TelegramBotPool

MAX_CONTENT = 4096
PARSE_MODES = {"MarkdownV2", "HTML", "plain"}
SEVERITY_PREFIX = {
    "info": "ℹ️ INFO",
    "warn": "⚠️ WARN",
    "critical": "🚨 CRITICAL",
}


def _parse_mode(value: str | None) -> str | None:
    if value == "MarkdownV2":
        return constants.ParseMode.MARKDOWN_V2
    if value == "HTML":
        return constants.ParseMode.HTML
    return None


def make_handler(pool: TelegramBotPool):
    async def handler(config: dict[str, Any], joblog: JobLogger) -> dict[str, Any]:
        token = config.get("botToken")
        user_id = config.get("userId")
        content = config.get("content", "")
        parse_mode = config.get("parseMode", "MarkdownV2")
        severity = config.get("severity", "info")
        prefix = bool(config.get("prefix", True))

        if not isinstance(token, str) or not token:
            raise ValueError("botToken is required")
        if not isinstance(user_id, str) or not user_id:
            raise ValueError("userId is required")
        try:
            int(user_id)
        except ValueError:
            raise ValueError("userId must be a numeric Telegram user id")
        if not isinstance(content, str) or not content:
            raise ValueError("content is required")
        if severity not in SEVERITY_PREFIX:
            raise ValueError("severity must be one of info/warn/critical")
        if parse_mode not in PARSE_MODES:
            raise ValueError(f"parseMode must be one of {sorted(PARSE_MODES)}")

        prefix_str = (SEVERITY_PREFIX[severity] + " — ") if prefix else ""
        full_content = prefix_str + content
        if len(full_content) > MAX_CONTENT:
            raise ValueError(f"prefix + content exceeds {MAX_CONTENT} chars (got {len(full_content)})")

        try:
            bot = await pool.get(token)
        except InvalidToken:
            raise RuntimeError("invalid Telegram bot token")

        await joblog.info("telegram.dm_send", userId=user_id, severity=severity)

        try:
            msg = await bot.send_message(
                chat_id=int(user_id),
                text=full_content,
                parse_mode=_parse_mode(parse_mode),
            )
        except Forbidden:
            # Try to fetch bot username so we can hand the user a t.me link.
            try:
                me = await bot.get_me()
                hint = f" — user must first start a chat with the bot at https://t.me/{me.username}"
            except Exception:
                hint = " — user must first start a chat with this bot"
            raise RuntimeError(f"telegram forbidden to DM user {user_id}{hint}")
        except BadRequest as e:
            raise RuntimeError(f"telegram BadRequest ({e.message}) — check userId / parseMode escaping")
        except TelegramError as e:
            raise RuntimeError(f"telegram error: {type(e).__name__}: {e}")

        result = {
            "messageId": msg.message_id,
            "userId": user_id,
            "postedAt": datetime.now(timezone.utc).isoformat(),
            "severity": severity,
        }
        await joblog.info("telegram.dm_sent", **result)
        return result

    return handler
