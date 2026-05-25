"""browser worker entry — runs BrowserWorker forever."""
from __future__ import annotations
import asyncio
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


def main() -> None:
    asyncio.run(BrowserWorker().run())


if __name__ == "__main__":
    main()
