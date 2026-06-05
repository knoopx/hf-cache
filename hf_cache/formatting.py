"""Human-readable formatting helpers."""

import time


def format_timesince(ts: float) -> str:
    """Format a timestamp as a human-readable relative string."""
    _TIMESINCE_CHUNKS = (
        ("second", 1, 60),
        ("minute", 60, 60),
        ("hour", 60 * 60, 24),
        ("day", 60 * 60 * 24, 6),
        ("week", 60 * 60 * 24 * 7, 6),
        ("month", 60 * 60 * 24 * 30, 11),
        ("year", 60 * 60 * 24 * 365, None),
    )
    delta = time.time() - ts
    if delta < 20:
        return "a few seconds ago"
    for label, divider, max_value in _TIMESINCE_CHUNKS:
        value = round(delta / divider)
        if max_value is not None and value <= max_value:
            break
    return f"{value} {label}{'s' if value > 1 else ''} ago"


def format_size(size_bytes: int) -> str:
    """Format bytes into a human-readable string."""
    size_gb = size_bytes / (1024 ** 3)
    if size_gb >= 1:
        return f"{size_gb:.2f} GB"
    size_mb = size_bytes / (1024 ** 2)
    return f"{size_mb:.2f} MB"
