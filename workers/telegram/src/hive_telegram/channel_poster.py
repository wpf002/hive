"""Telegram Channel Poster handler."""
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


def _parse_mode(value: str | None) -> str | None:
    if value == "MarkdownV2":
        return constants.ParseMode.MARKDOWN_V2
    if value == "HTML":
        return constants.ParseMode.HTML
    return None


def make_handler(pool: TelegramBotPool):
    async def handler(config: dict[str, Any], joblog: JobLogger) -> dict[str, Any]:
        token = config.get("botToken")
        chat_id = config.get("chatId")
        content = config.get("content", "")
        parse_mode = config.get("parseMode", "MarkdownV2")
        disable_notification = bool(config.get("disableNotification", False))
        disable_preview = bool(config.get("disablePreview", False))

        if not isinstance(token, str) or not token:
            raise ValueError("botToken is required")
        if not isinstance(chat_id, str) or not chat_id:
            raise ValueError("chatId is required")
        if not isinstance(content, str) or not content:
            raise ValueError("content is required")
        if len(content) > MAX_CONTENT:
            raise ValueError(f"content exceeds {MAX_CONTENT} chars (got {len(content)})")
        if parse_mode not in PARSE_MODES:
            raise ValueError(f"parseMode must be one of {sorted(PARSE_MODES)}")

        try:
            bot = await pool.get(token)
        except InvalidToken:
            raise RuntimeError("invalid Telegram bot token")

        await joblog.info("telegram.send", chatId=chat_id, contentChars=len(content))

        try:
            msg = await bot.send_message(
                chat_id=chat_id,
                text=content,
                parse_mode=_parse_mode(parse_mode),
                disable_notification=disable_notification,
                disable_web_page_preview=disable_preview,
            )
        except Forbidden:
            raise RuntimeError(
                f"bot was blocked or kicked from chat {chat_id}; re-invite and grant Post Messages perms"
            )
        except BadRequest as e:
            raise RuntimeError(f"telegram BadRequest ({e.message}) — check chatId / parseMode escaping")
        except TelegramError as e:
            raise RuntimeError(f"telegram error: {type(e).__name__}: {e}")

        chat_title = getattr(msg.chat, "title", None) or getattr(msg.chat, "username", None)
        result = {
            "messageId": msg.message_id,
            "chatId": chat_id,
            "chatTitle": chat_title,
            "postedAt": datetime.now(timezone.utc).isoformat(),
        }
        await joblog.info("telegram.sent", **result)
        return result

    return handler
