"""Headless Form Filler — sequence of fill/click/select/wait steps."""
from __future__ import annotations
import time
from typing import Any

from playwright.async_api import async_playwright  # type: ignore[import-untyped]
from hive_base import JobLogger
from .artifacts import upload_artifact


VALID_ACTIONS = {"fill", "click", "select", "wait"}


async def headless_form_filler(config: dict[str, Any], joblog: JobLogger) -> dict[str, Any]:
    url = str(config.get("url") or "").strip()
    if not url:
        raise ValueError("url is required")
    steps = config.get("steps")
    if not isinstance(steps, list) or not steps:
        raise ValueError("steps must be a non-empty array")
    final_selector = config.get("finalSelectorWait")
    capture = str(config.get("capture", "screenshot")).lower()
    if capture not in {"screenshot", "html", "both", "none"}:
        raise ValueError("capture must be one of: screenshot, html, both, none")
    timeout_s = int(config.get("timeoutSeconds", 30))

    artifacts: list[dict[str, Any]] = []
    steps_completed = 0
    t0 = time.time()

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        try:
            context = await browser.new_context()
            page = await context.new_page()
            page.set_default_timeout(timeout_s * 1000)
            await joblog.info("browser.goto", url=url)
            await page.goto(url, wait_until="load")

            try:
                for i, step in enumerate(steps, start=1):
                    if not isinstance(step, dict):
                        raise ValueError(f"step {i} must be an object")
                    action = str(step.get("action", "")).lower()
                    if action not in VALID_ACTIONS:
                        raise ValueError(f"step {i}: unknown action '{action}'")
                    selector = step.get("selector")
                    value = step.get("value")
                    wait_ms = int(step.get("waitMs", 0))
                    await joblog.info("form.step", index=i, action=action, selector=selector)
                    if action == "fill":
                        await page.fill(str(selector), str(value or ""))
                    elif action == "click":
                        await page.click(str(selector))
                    elif action == "select":
                        await page.select_option(str(selector), str(value or ""))
                    elif action == "wait":
                        if selector:
                            await page.wait_for_selector(str(selector))
                        elif wait_ms > 0:
                            await page.wait_for_timeout(wait_ms)
                        else:
                            await page.wait_for_timeout(500)
                    steps_completed = i

                if final_selector:
                    await page.wait_for_selector(str(final_selector))

                if capture in {"screenshot", "both"}:
                    png = await page.screenshot(full_page=True, type="png")
                    art_id = await upload_artifact(
                        job_id=joblog.job_id, filename="result.png", body=png, content_type="image/png"
                    )
                    artifacts.append({"id": art_id, "filename": "result.png", "type": "image/png"})
                if capture in {"html", "both"}:
                    html = await page.content()
                    art_id = await upload_artifact(
                        job_id=joblog.job_id, filename="result.html", body=html.encode("utf-8"), content_type="text/html"
                    )
                    artifacts.append({"id": art_id, "filename": "result.html", "type": "text/html"})

            except Exception as e:
                # On failure ALWAYS capture failure.png + failure.html, regardless of capture config.
                await joblog.error("form.step_failed", error=str(e), step=steps_completed + 1)
                try:
                    fail_png = await page.screenshot(full_page=True, type="png")
                    fa_id = await upload_artifact(
                        job_id=joblog.job_id, filename="failure.png", body=fail_png, content_type="image/png"
                    )
                    artifacts.append({"id": fa_id, "filename": "failure.png", "type": "image/png"})
                    fail_html = await page.content()
                    fh_id = await upload_artifact(
                        job_id=joblog.job_id, filename="failure.html", body=fail_html.encode("utf-8"), content_type="text/html"
                    )
                    artifacts.append({"id": fh_id, "filename": "failure.html", "type": "text/html"})
                except Exception as cap_err:
                    await joblog.error("form.failure_capture_failed", error=str(cap_err))
                raise
        finally:
            await browser.close()

    duration_ms = int((time.time() - t0) * 1000)
    return {
        "stepsCompleted": steps_completed,
        "durationMs": duration_ms,
        "artifacts": artifacts,
    }
