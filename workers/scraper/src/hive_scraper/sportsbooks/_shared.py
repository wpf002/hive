"""Shared shaping helpers for sportsbook normalizers.

The Odds API returns the same upstream payload regardless of book; we filter to
one book and reshape. Each per-book file is still a real per-book entry point
so we can swap the upstream (or specialize per-book quirks) later without
rewriting the handler.
"""
from __future__ import annotations
from typing import Any, Iterable

MARKET_KEY_MAP = {
    "moneyline": "h2h",
    "spread": "spreads",
    "total": "totals",
}


def _moneyline(outcomes: list[dict[str, Any]], home: str, away: str) -> dict[str, Any] | None:
    out: dict[str, Any] = {}
    for o in outcomes:
        if o.get("name") == home:
            out["home"] = o.get("price")
        elif o.get("name") == away:
            out["away"] = o.get("price")
    return out if out else None


def _spread(outcomes: list[dict[str, Any]], home: str, away: str) -> dict[str, Any] | None:
    out: dict[str, Any] = {}
    for o in outcomes:
        side = "home" if o.get("name") == home else ("away" if o.get("name") == away else None)
        if side is None:
            continue
        out[side] = {"line": o.get("point"), "price": o.get("price")}
    return out if out else None


def _total(outcomes: list[dict[str, Any]]) -> dict[str, Any] | None:
    out: dict[str, Any] = {}
    for o in outcomes:
        name = (o.get("name") or "").lower()
        if name == "over":
            out["over"] = {"line": o.get("point"), "price": o.get("price")}
        elif name == "under":
            out["under"] = {"line": o.get("point"), "price": o.get("price")}
    return out if out else None


def reshape_event(event: dict[str, Any], book_key: str, requested_markets: Iterable[str]) -> dict[str, Any] | None:
    """Reshape one upstream event for a single book. Returns None if no markets matched."""
    home = event.get("home_team")
    away = event.get("away_team")
    bookmaker = next((b for b in event.get("bookmakers") or [] if b.get("key") == book_key), None)
    if not bookmaker:
        return None

    upstream_keys = {MARKET_KEY_MAP[m] for m in requested_markets if m in MARKET_KEY_MAP}
    markets_by_key: dict[str, list[dict[str, Any]]] = {
        m["key"]: (m.get("outcomes") or [])
        for m in (bookmaker.get("markets") or [])
        if m.get("key") in upstream_keys
    }
    if not markets_by_key:
        return None

    lines: dict[str, Any] = {}
    if "h2h" in markets_by_key:
        ml = _moneyline(markets_by_key["h2h"], home or "", away or "")
        if ml:
            lines["moneyline"] = ml
    if "spreads" in markets_by_key:
        sp = _spread(markets_by_key["spreads"], home or "", away or "")
        if sp:
            lines["spread"] = sp
    if "totals" in markets_by_key:
        tot = _total(markets_by_key["totals"])
        if tot:
            lines["total"] = tot

    if not lines:
        return None

    return {
        "id": event.get("id"),
        "name": f"{away} @ {home}" if home and away else event.get("id"),
        "startTime": event.get("commence_time"),
        "home": home,
        "away": away,
        "lines": lines,
    }
