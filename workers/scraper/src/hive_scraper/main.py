"""Scraper worker entry — runs ScraperWorker forever."""
from __future__ import annotations
import asyncio
from hive_base import HiveWorker
from .espn import fetch_scoreboard
from .sportsbook import scrape_sportsbook_lines


class ScraperWorker(HiveWorker):
    pool_type = "scraper"
    capacity = 8

    async def setup(self) -> None:
        self.register("ESPN Scoreboard Scraper", fetch_scoreboard)
        self.register("Sportsbook Line Scraper", scrape_sportsbook_lines)


def main() -> None:
    asyncio.run(ScraperWorker().run())


if __name__ == "__main__":
    main()
