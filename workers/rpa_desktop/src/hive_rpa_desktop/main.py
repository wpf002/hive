"""rpa_desktop worker entry — singleton pool (one job at a time)."""
from __future__ import annotations
import asyncio
from hive_base import HiveWorker
from .checks import check_tesseract, check_accessibility
from .screen_capture import screen_region_capture
from .macro_player import window_macro_player
from .ocr_field import ocr_field_reader


class RpaDesktopWorker(HiveWorker):
    pool_type = "rpa_desktop"
    capacity = 1
    singleton = True  # API rejects parallel dispatch with 429 pool_busy

    async def setup(self) -> None:
        # Fail loud at startup if OS prereqs are missing — the singleton
        # pool can't surface this any other way.
        check_tesseract()
        check_accessibility()
        self.register("Screen Region Capture", screen_region_capture)
        self.register("Window Macro Player", window_macro_player)
        self.register("OCR Field Reader", ocr_field_reader)


def main() -> None:
    asyncio.run(RpaDesktopWorker().run())


if __name__ == "__main__":
    main()
