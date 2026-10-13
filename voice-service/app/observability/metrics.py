"""Rolling, in-memory measurements. Nothing here is persisted or sent anywhere."""

from __future__ import annotations

import threading
from collections import defaultdict, deque

from app.observability.stats import summarize


class Metrics:
    """Keeps the last `keep` observations per name. Safe to call from any thread."""

    def __init__(self, keep: int = 500) -> None:
        self._values: dict[str, deque[float]] = defaultdict(lambda: deque(maxlen=keep))
        self._counts: dict[str, int] = defaultdict(int)
        self._lock = threading.Lock()

    def observe(self, name: str, value_ms: float) -> None:
        with self._lock:
            self._values[name].append(value_ms)

    def count(self, name: str, n: int = 1) -> None:
        with self._lock:
            self._counts[name] += n

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "timings_ms": {k: summarize(list(v)) for k, v in sorted(self._values.items())},
                "counts": dict(sorted(self._counts.items())),
            }
