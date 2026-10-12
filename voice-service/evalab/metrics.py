"""Small, dependency-free metrics shared by the evaluation lab and the tests."""

from __future__ import annotations

import math
import re
import statistics
import wave
from pathlib import Path

import numpy as np

_WORD = re.compile(r"[a-z0-9']+")


def normalize_words(text: str) -> list[str]:
    """Lower case, punctuation removed: ASR output is compared on words, not formatting."""
    return _WORD.findall(text.lower())


def word_errors(reference: str, hypothesis: str) -> tuple[int, int]:
    """(edit distance in words, reference length). Substitutions, insertions, deletions cost 1."""
    ref, hyp = normalize_words(reference), normalize_words(hypothesis)
    prev = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        cur = [i]
        for j, h in enumerate(hyp, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r != h)))
        prev = cur
    return prev[-1], len(ref)


def wer(reference: str, hypothesis: str) -> float:
    errors, n = word_errors(reference, hypothesis)
    return errors / n if n else (0.0 if not normalize_words(hypothesis) else 1.0)


def corpus_wer(pairs: list[tuple[str, str]]) -> float:
    """Total errors over total reference words (not an average of per-file rates)."""
    errors = words = 0
    for ref, hyp in pairs:
        e, n = word_errors(ref, hyp)
        errors += e
        words += n
    return errors / words if words else 0.0


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


def read_wav_mono16k(path: str | Path) -> np.ndarray:
    """Read a PCM16 wav as mono float32 at 16 kHz (linear resampling if needed)."""
    from app.audio.resampling import resample

    with wave.open(str(path)) as w:
        rate, channels, n = w.getframerate(), w.getnchannels(), w.getnframes()
        raw = np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        raw = raw.reshape(-1, channels).mean(axis=1)
    return resample(raw, rate, 16000)
