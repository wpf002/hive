"""Per-book sportsbook normalizers."""
from .draftkings import normalize as normalize_draftkings
from .fanduel import normalize as normalize_fanduel

NORMALIZERS = {
    "draftkings": normalize_draftkings,
    "fanduel": normalize_fanduel,
}

__all__ = ["NORMALIZERS", "normalize_draftkings", "normalize_fanduel"]
