"""Web Element Extractor — load URL, extract values per selectors map."""
from __future__ import annotations
from datetime import datetime, timezone
from typing import Any

from playwright.async_api import async_playwright  # type: ignore[import-untyped]
from hive_base import JobLogger


async def web_element_extractor(config: dict[str, Any], joblog: JobLogger) -> dict[str, Any]:
    url = str(config.get("url") or "").strip()
    if not url:
        raise ValueError("url is required")
    selectors = config.get("selectors")
    if not isinstance(selectors, list) or not selectors:
        raise ValueError("selectors must be a non-empty array of {name, selector, [attr], [multiple]}")
    wait_for_selector = config.get("waitForSelector")
    user_agent = config.get("userAgent")

    data: dict[str, Any] = {}
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        try:
            ctx_kwargs: dict[str, Any] = {}
            if user_agent:
                ctx_kwargs["user_agent"] = str(user_agent)
            context = await browser.new_context(**ctx_kwargs)
            page = await context.new_page()
            await joblog.info("browser.goto", url=url)
            await page.goto(url, wait_until="load")
            if wait_for_selector:
                await page.wait_for_selector(str(wait_for_selector))

            for sel in selectors:
                if not isinstance(sel, dict):
                    continue
                name = sel.get("name")
                css = sel.get("selector")
                attr = sel.get("attr")
                multiple = bool(sel.get("multiple", False))
                if not isinstance(name, str) or not isinstance(css, str):
                    continue
                locator = page.locator(css)
                try:
                    if multiple:
                        if attr:
                            values = [await el.get_attribute(str(attr)) for el in await locator.all()]
                        else:
                            values = [await el.text_content() for el in await locator.all()]
                        data[name] = [v.strip() if isinstance(v, str) else v for v in values]
                    else:
                        first = locator.first
                        if attr:
                            data[name] = await first.get_attribute(str(attr))
                        else:
                            txt = await first.text_content()
                            data[name] = txt.strip() if isinstance(txt, str) else txt
                except Exception as e:
                    await joblog.warn("extract.failed", name=name, selector=css, error=str(e))
                    data[name] = None
        finally:
            await browser.close()

    return {
        "url": url,
        "extractedAt": datetime.now(timezone.utc).isoformat(),
        "data": data,
    }
