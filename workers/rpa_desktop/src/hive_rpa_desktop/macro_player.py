"""Window Macro Player — sequence of pyautogui actions with before/after audit."""
from __future__ import annotations
import asyncio
import hashlib
import io
import time
from typing import Any

import pyautogui  # type: ignore[import-untyped]
from hive_base import JobLogger
from .artifacts import upload_artifact


VALID_ACTIONS = {"click", "type", "keypress", "wait", "hotkey", "move"}


def _screenshot_bytes() -> bytes:
    img = pyautogui.screenshot()
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _phash(png: bytes) -> str:
    return hashlib.sha256(png).hexdigest()


def _do_action(action: str, step: dict[str, Any]) -> None:
    if action == "click":
        pyautogui.click(int(step.get("x", 0)), int(step.get("y", 0)))
    elif action == "type":
        pyautogui.write(str(step.get("text", "")), interval=0.02)
    elif action == "keypress":
        pyautogui.press(str(step.get("key", "")))
    elif action == "hotkey":
        keys = step.get("keys")
        if not isinstance(keys, list) or not keys:
            raise ValueError("hotkey requires keys[] of str")
        pyautogui.hotkey(*[str(k) for k in keys])
    elif action == "wait":
        time.sleep(int(step.get("ms", 100)) / 1000.0)
    elif action == "move":
        pyautogui.moveTo(int(step.get("x", 0)), int(step.get("y", 0)))


async def window_macro_player(config: dict[str, Any], joblog: JobLogger) -> dict[str, Any]:
    steps = config.get("steps")
    if not isinstance(steps, list) or not steps:
        raise ValueError("steps must be a non-empty array")
    pre_check = config.get("preCheck") or {}
    if not isinstance(pre_check, dict):
        pre_check = {}
    screenshot_before_after = bool(pre_check.get("screenshotBeforeAfter", True))
    fail_on_unchanged = bool(pre_check.get("failOnUnchanged", False))
    max_duration_s = int(config.get("maxDurationSeconds", 120))

    artifacts: list[dict[str, Any]] = []
    before_hash: str | None = None
    if screenshot_before_after:
        before_png = await asyncio.to_thread(_screenshot_bytes)
        before_hash = _phash(before_png)
        b_id = await upload_artifact(
            job_id=joblog.job_id, filename="before.png", body=before_png, content_type="image/png"
        )
        artifacts.append({"id": b_id, "filename": "before.png", "type": "image/png"})

    t0 = time.time()
    steps_completed = 0
    try:
        for i, step in enumerate(steps, start=1):
            if not isinstance(step, dict):
                raise ValueError(f"step {i} must be an object")
            action = str(step.get("action", "")).lower()
            if action not in VALID_ACTIONS:
                raise ValueError(f"step {i}: unknown action '{action}'")
            # LOUD audit log per the plan — every keystroke / click is recorded.
            await joblog.info("rpa.action", index=i, action=action, params={
                k: v for k, v in step.items() if k != "action"
            })
            await asyncio.to_thread(_do_action, action, step)
            steps_completed = i
            if time.time() - t0 > max_duration_s:
                raise TimeoutError(f"maxDurationSeconds={max_duration_s} exceeded after {i} steps")
    finally:
        duration_ms = int((time.time() - t0) * 1000)

    after_hash: str | None = None
    if screenshot_before_after:
        after_png = await asyncio.to_thread(_screenshot_bytes)
        after_hash = _phash(after_png)
        a_id = await upload_artifact(
            job_id=joblog.job_id, filename="after.png", body=after_png, content_type="image/png"
        )
        artifacts.append({"id": a_id, "filename": "after.png", "type": "image/png"})

    if fail_on_unchanged and before_hash and after_hash and before_hash == after_hash:
        raise RuntimeError("before/after screenshots are pixel-identical — macro likely missed its target")

    return {
        "stepsCompleted": steps_completed,
        "durationMs": duration_ms,
        "artifacts": artifacts,
        "beforeHash": before_hash,
        "afterHash": after_hash,
    }
