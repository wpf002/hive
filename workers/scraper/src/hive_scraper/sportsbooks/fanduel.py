"""FanDuel normalizer.

Today this filters The Odds API payload to the FanDuel bookmaker. Future
swap-in (direct FD scrape) reuses the same output contract.
"""
from __future__ import annotations
from typing import Any, Iterable
from ._shared import reshape_event

BOOK_KEY = "fanduel"


def normalize(upstream_events: list[dict[str, Any]], requested_markets: Iterable[str]) -> list[dict[str, Any]]:
    reshaped: list[dict[str, Any]] = []
    for ev in upstream_events:
        out = reshape_event(ev, BOOK_KEY, requested_markets)
        if out is not None:
            reshaped.append(out)
    return reshaped
