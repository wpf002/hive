"""E2E Test Runner — load URL, run a list of assertions, optionally capture on failure."""
from __future__ import annotations
import time
from typing import Any

from playwright.async_api import async_playwright  # type: ignore[import-untyped]
from hive_base import JobLogger
from .artifacts import upload_artifact


async def e2e_test_runner(config: dict[str, Any], joblog: JobLogger) -> dict[str, Any]:
    url = str(config.get("url") or "").strip()
    if not url:
        raise ValueError("url is required")
    assertions = config.get("assertions")
    if not isinstance(assertions, list) or not assertions:
        raise ValueError("assertions must be a non-empty array")
    viewport_w = int(config.get("viewportWidth", 1440))
    viewport_h = int(config.get("viewportHeight", 900))
    capture_on_failure = bool(config.get("captureOnFailure", True))

    results: list[dict[str, Any]] = []
    artifacts: list[dict[str, Any]] = []
    passed = 0
    failed = 0

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        try:
            context = await browser.new_context(viewport={"width": viewport_w, "height": viewport_h})
            page = await context.new_page()
            await joblog.info("browser.goto", url=url)
            await page.goto(url, wait_until="load")

            for i, a in enumerate(assertions, start=1):
                if not isinstance(a, dict):
                    results.append({"selector": None, "ok": False, "message": "assertion must be an object"})
                    failed += 1
                    continue
                selector = a.get("selector")
                if not isinstance(selector, str) or not selector:
                    results.append({"selector": selector, "ok": False, "message": "selector is required"})
                    failed += 1
                    continue
                ok = True
                msg = "ok"
                try:
                    locator = page.locator(selector).first
                    if a.get("expectVisible") is True:
                        visible = await locator.is_visible()
                        if not visible:
                            ok = False
                            msg = "not visible"
                    expect_text = a.get("expectText")
                    if ok and isinstance(expect_text, str):
                        text = (await locator.text_content()) or ""
                        if expect_text not in text:
                            ok = False
                            msg = f"text mismatch: expected '{expect_text}', got '{text[:80]}'"
                    expect_attr = a.get("expectAttribute")
                    if ok and isinstance(expect_attr, dict):
                        name = expect_attr.get("name")
                        wanted = expect_attr.get("value")
                        actual = await locator.get_attribute(str(name)) if name else None
                        if actual != str(wanted):
                            ok = False
                            msg = f"attribute '{name}' mismatch: expected '{wanted}', got '{actual}'"
                except Exception as e:
                    ok = False
                    msg = f"playwright error: {e}"
                results.append({"selector": selector, "ok": ok, "message": msg})
                if ok:
                    passed += 1
                    await joblog.info("e2e.assert.pass", index=i, selector=selector)
                else:
                    failed += 1
                    await joblog.warn("e2e.assert.fail", index=i, selector=selector, message=msg)

            if failed > 0 and capture_on_failure:
                png = await page.screenshot(full_page=True, type="png")
                p_id = await upload_artifact(
                    job_id=joblog.job_id, filename="failure.png", body=png, content_type="image/png"
                )
                artifacts.append({"id": p_id, "filename": "failure.png", "type": "image/png"})
                html = await page.content()
                h_id = await upload_artifact(
                    job_id=joblog.job_id,
                    filename="failure.html",
                    body=html.encode("utf-8"),
                    content_type="text/html",
                )
                artifacts.append({"id": h_id, "filename": "failure.html", "type": "text/html"})

        finally:
            await browser.close()

    return {
        "passed": passed,
        "failed": failed,
        "assertions": results,
        "artifacts": artifacts,
    }
