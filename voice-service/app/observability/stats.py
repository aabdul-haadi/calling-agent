"""Percentiles and summaries used by the live /metrics endpoint and the evaluation lab."""

from __future__ import annotations

import math
import statistics


def percentile(values: list[float], p: float) -> float:
    """Nearest-rank percentile; NaN for an empty list so a missing measurement is never a zero."""
    if not values:
        return math.nan
    ordered = sorted(values)
    k = max(0, min(len(ordered) - 1, math.ceil(p / 100 * len(ordered)) - 1))
    return ordered[k]


def summarize(values: list[float]) -> dict[str, float]:
    if not values:
        return {"n": 0}
    return {
        "n": len(values),
        "mean": round(statistics.fmean(values), 1),
        "p50": round(percentile(values, 50), 1),
        "p95": round(percentile(values, 95), 1),
        "max": round(max(values), 1),
    }
