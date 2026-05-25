"""Full Page Screenshot handler."""
from __future__ import annotations
import time
from typing import Any

from playwright.async_api import async_playwright  # type: ignore[import-untyped]
from hive_base import JobLogger
from .artifacts import upload_artifact


async def full_page_screenshot(config: dict[str, Any], joblog: JobLogger) -> dict[str, Any]:
    url = str(config.get("url") or "").strip()
    if not url:
        raise ValueError("url is required")
    viewport_w = int(config.get("viewportWidth", 1440))
    viewport_h = int(config.get("viewportHeight", 900))
    full_page = bool(config.get("fullPage", True))
    wait_for_selector = config.get("waitForSelector")
    wait_ms = int(config.get("waitMs", 0))
    user_agent = config.get("userAgent")

    t0 = time.time()
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        try:
            ctx_kwargs: dict[str, Any] = {"viewport": {"width": viewport_w, "height": viewport_h}}
            if user_agent:
                ctx_kwargs["user_agent"] = str(user_agent)
            context = await browser.new_context(**ctx_kwargs)
            page = await context.new_page()
            await joblog.info("browser.goto", url=url)
            await page.goto(url, wait_until="load")
            if wait_for_selector:
                await page.wait_for_selector(str(wait_for_selector))
            if wait_ms > 0:
                await page.wait_for_timeout(wait_ms)
            png = await page.screenshot(full_page=full_page, type="png")
            title = await page.title()
            final_url = page.url
        finally:
            await browser.close()

    job_id = joblog.job_id
    art_id = await upload_artifact(
        job_id=job_id,
        filename="screenshot.png",
        body=png,
        content_type="image/png",
    )
    duration_ms = int((time.time() - t0) * 1000)
    await joblog.info("browser.screenshot.uploaded", artifactId=art_id, size=len(png), durationMs=duration_ms)
    return {
        "artifactId": art_id,
        "url": url,
        "pageTitle": title,
        "finalUrl": final_url,
        "screenshotSizeBytes": len(png),
        "durationMs": duration_ms,
    }
