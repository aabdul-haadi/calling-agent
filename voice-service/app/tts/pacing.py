"""Silence between spoken phrases.

Each phrase is synthesized on its own, and every synthesis ends with a little silence of its own
length (about 100-160 ms with the Piper voices) and starts with some more. Played back to back that
makes a pause after every comma-sized phrase, which is what makes streamed speech sound chopped up.
`Pacer` trims that silence and puts back a deliberate pause: a short one after a clause, a longer
one after a sentence, none after the last phrase. It only touches silence, never speech.
"""

from __future__ import annotations

import re

import numpy as np

SENTENCE_END = re.compile(r"[.!?]['\")\]]*\s*$")


def trim_silence(x: np.ndarray, rate: int, lead_ms: float | None, tail_ms: float | None, floor: float = 0.01) -> np.ndarray:
    """Keep at most `lead_ms` of leading and `tail_ms` of trailing quiet (None leaves that side alone).
    A pause is never made longer than it was."""
    if x.size == 0:
        return x
    loud = np.flatnonzero(np.abs(x) > floor)
    if loud.size == 0:
        return x[: int(rate * (tail_ms or 0) / 1000)] if tail_ms is not None else x
    start, end = int(loud[0]), int(loud[-1]) + 1
    if lead_ms is not None:
        start = max(0, start - int(rate * lead_ms / 1000))
    else:
        start = 0
    if tail_ms is not None:
        end = min(x.size, end + int(rate * tail_ms / 1000))
    else:
        end = x.size
    return x[start:end]


class Pacer:
    """Wraps a synthesis sink for ONE phrase. Everything but the last `window_ms` of audio is passed
    on at once (so streaming engines lose no latency); that last stretch is held until `finish()`,
    when its trailing silence can be trimmed to the pause this phrase should end with."""

    def __init__(self, sink, rate: int, phrase: str, *, last_phrase: bool, sentence_ms: int, clause_ms: int,
                 lead_ms: int = 20, window_ms: int = 250) -> None:
        self._sink = sink
        self._rate = rate
        self._held = np.zeros(0, np.float32)
        self._first = True
        self._lead_ms = lead_ms
        self._window = int(rate * window_ms / 1000)
        self._tail_ms = 0 if last_phrase else (sentence_ms if SENTENCE_END.search(phrase) else clause_ms)

    def __call__(self, samples: np.ndarray) -> bool:
        if self._first and samples.size:
            samples = trim_silence(samples, self._rate, self._lead_ms, None)
            self._first = False
        self._held = np.concatenate([self._held, samples])
        if self._held.size <= self._window:
            return True
        send, self._held = self._held[: -self._window], self._held[-self._window :]
        return self._sink(send)

    def finish(self) -> bool:
        tail = trim_silence(self._held, self._rate, None, self._tail_ms)
        self._held = np.zeros(0, np.float32)
        return self._sink(tail) if tail.size else True
