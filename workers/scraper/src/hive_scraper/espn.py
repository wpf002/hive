"""ESPN scoreboard fetcher."""
from __future__ import annotations
from datetime import datetime, timedelta, timezone
from typing import Any
import httpx
from hive_base import JobLogger

LEAGUE_PATHS = {
    "nfl": "football/nfl",
    "nba": "basketball/nba",
    "wnba": "basketball/wnba",
    "mlb": "baseball/mlb",
    "nhl": "hockey/nhl",
}


def _date_str(offset_days: int) -> str:
    d = datetime.now(timezone.utc).date() + timedelta(days=offset_days)
    return d.strftime("%Y%m%d")


def _normalize_event(ev: dict[str, Any]) -> dict[str, Any]:
    comp = (ev.get("competitions") or [{}])[0]
    competitors = comp.get("competitors") or []
    home = next((c for c in competitors if c.get("homeAway") == "home"), {})
    away = next((c for c in competitors if c.get("homeAway") == "away"), {})

    def _side(c: dict[str, Any]) -> dict[str, Any]:
        team = c.get("team") or {}
        return {
            "team": team.get("displayName"),
            "abbreviation": team.get("abbreviation"),
            "score": c.get("score"),
        }

    status = ((ev.get("status") or {}).get("type") or {})
    return {
        "id": ev.get("id"),
        "name": ev.get("name"),
        "status": status.get("name"),
        "completed": bool(status.get("completed", False)),
        "startDate": ev.get("date"),
        "home": _side(home),
        "away": _side(away),
    }


async def fetch_scoreboard(config: dict[str, Any], joblog: JobLogger) -> dict[str, Any]:
    league = str(config.get("league", "nfl")).lower()
    if league not in LEAGUE_PATHS:
        raise ValueError(f"unsupported league '{league}'; must be one of {list(LEAGUE_PATHS)}")
    date_offset = int(config.get("dateOffset", 0))
    date = _date_str(date_offset)
    url = f"https://site.api.espn.com/apis/site/v2/sports/{LEAGUE_PATHS[league]}/scoreboard?dates={date}"
    await joblog.info("espn.request", url=url, league=league, date=date)

    async with httpx.AsyncClient(timeout=15.0) as client:
        r = await client.get(url, headers={"Accept": "application/json"})
        r.raise_for_status()
        data = r.json()

    events = data.get("events") or []
    games = [_normalize_event(e) for e in events]
    await joblog.info("espn.response", gameCount=len(games))
    return {
        "league": league,
        "date": date,
        "gameCount": len(games),
        "games": games,
    }
