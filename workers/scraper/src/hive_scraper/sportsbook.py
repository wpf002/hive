"""Sportsbook line scraper handler.

Talks to The Odds API (the-odds-api.com) and dispatches the per-event
payload to the requested book's normalizer. Backends are pluggable per
book — see hive_scraper.sportsbooks.{draftkings,fanduel}.
"""
from __future__ import annotations
import os
from datetime import datetime, timezone
from typing import Any
import httpx
from hive_base import JobLogger
from .sportsbooks import NORMALIZERS

LEAGUE_TO_SPORT_KEY = {
    "nfl": "americanfootball_nfl",
    "nba": "basketball_nba",
    "mlb": "baseball_mlb",
    "nhl": "icehockey_nhl",
}

MARKET_TO_UPSTREAM = {
    "moneyline": "h2h",
    "spread": "spreads",
    "total": "totals",
}

DEFAULT_MARKETS = ["moneyline", "spread", "total"]
USER_AGENT = "Hive/0.1 (+https://github.com/wpf002/hive)"


async def scrape_sportsbook_lines(config: dict[str, Any], joblog: JobLogger) -> dict[str, Any]:
    book = str(config.get("book", "")).lower()
    league = str(config.get("league", "")).lower()
    raw_markets = config.get("markets") or DEFAULT_MARKETS
    if not isinstance(raw_markets, list):
        raise ValueError("markets must be a list")
    markets = [str(m).lower() for m in raw_markets]

    if book not in NORMALIZERS:
        raise ValueError(f"unsupported book '{book}'; must be one of {sorted(NORMALIZERS)}")
    if league not in LEAGUE_TO_SPORT_KEY:
        raise ValueError(f"unsupported league '{league}'; must be one of {sorted(LEAGUE_TO_SPORT_KEY)}")
    unknown_markets = [m for m in markets if m not in MARKET_TO_UPSTREAM]
    if unknown_markets:
        raise ValueError(f"unsupported markets {unknown_markets}; must be subset of {sorted(MARKET_TO_UPSTREAM)}")

    api_key = os.environ.get("ODDS_API_KEY")
    if not api_key:
        raise RuntimeError(
            "ODDS_API_KEY is not set. Get a free key at the-odds-api.com and add to .env."
        )

    sport_key = LEAGUE_TO_SPORT_KEY[league]
    upstream_markets = ",".join(MARKET_TO_UPSTREAM[m] for m in markets)
    url = f"https://api.the-odds-api.com/v4/sports/{sport_key}/odds"
    params = {
        "apiKey": api_key,
        "regions": "us",
        "markets": upstream_markets,
        "bookmakers": book,
        "oddsFormat": "american",
    }
    log_params = {k: v for k, v in params.items() if k != "apiKey"}
    await joblog.info("sportsbook.request", url=url, params=log_params, book=book, league=league)

    async with httpx.AsyncClient(timeout=10.0, headers={"User-Agent": USER_AGENT}) as client:
        r = await client.get(url, params=params)
        if r.status_code == 401:
            raise RuntimeError("ODDS_API_KEY rejected by the-odds-api.com (401)")
        if r.status_code == 422:
            raise RuntimeError(
                f"the-odds-api rejected the request (422): {r.text[:300]}. "
                f"Likely no live odds for {book}/{league} right now."
            )
        r.raise_for_status()
        upstream = r.json()
    if not isinstance(upstream, list):
        raise RuntimeError(f"unexpected upstream shape: {type(upstream).__name__}")

    quota_remaining = r.headers.get("x-requests-remaining")
    quota_used = r.headers.get("x-requests-used")
    await joblog.info(
        "sportsbook.response",
        upstreamEvents=len(upstream),
        quotaRemaining=quota_remaining,
        quotaUsed=quota_used,
    )

    normalize = NORMALIZERS[book]
    events = normalize(upstream, markets)

    await joblog.info("sportsbook.normalized", book=book, eventCount=len(events))
    return {
        "book": book,
        "league": league,
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
        "events": events,
        "eventCount": len(events),
    }
