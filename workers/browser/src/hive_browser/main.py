"""browser worker entry — runs BrowserWorker forever."""
from __future__ import annotations
import asyncio
from typing import Optional
from playwright.async_api import async_playwright
from hive_base import HiveWorker
from .screenshot import full_page_screenshot
from .form_filler import headless_form_filler
from .e2e_runner import e2e_test_runner
from .element_extractor import web_element_extractor


class BrowserWorker(HiveWorker):
    pool_type = "browser"
    capacity = 4  # each Playwright instance ~300 MB

    async def setup(self) -> None:
        self.register("Full Page Screenshot", full_page_screenshot)
        self.register("Headless Form Filler", headless_form_filler)
        self.register("E2E Test Runner", e2e_test_runner)
        self.register("Web Element Extractor", web_element_extractor)

    async def preflight(self) -> Optional[str]:
        """Confirm a browser binary is actually installed.

        `pip install playwright` gets the Python package; it does not download
        the browser, and the two version independently — a package upgrade asks
        for a build number that may not be in the cache. This pool ran for days
        in exactly that state: online, claiming jobs, failing every one of them
        with "Executable doesn't exist", while the mission composer kept picking
        it because the pool said it was up.

        Launching for real rather than stat-ing a path: the path is a private
        detail of the installed version, and a launch is what a job does.
        """
        try:
            async with async_playwright() as p:
                browser = await p.chromium.launch()
                await browser.close()
        except Exception as e:
            first = str(e).strip().splitlines()[0] if str(e).strip() else e.__class__.__name__
            return f"chromium will not launch ({first}) — run: python -m playwright install chromium"
        return None


def main() -> None:
    asyncio.run(BrowserWorker().run())


if __name__ == "__main__":
    main()
