"""Small, dependency-free metrics shared by the evaluation lab and the tests."""

from __future__ import annotations

import re
import wave
from pathlib import Path

import numpy as np

from app.observability.stats import percentile, summarize  # noqa: F401  (re-exported for the lab)

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


def read_wav_mono16k(path: str | Path) -> np.ndarray:
    """Read a PCM16 wav as mono float32 at 16 kHz (linear resampling if needed)."""
    from app.audio.resampling import resample

    with wave.open(str(path)) as w:
        rate, channels, n = w.getframerate(), w.getnchannels(), w.getnframes()
        raw = np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        raw = raw.reshape(-1, channels).mean(axis=1)
    return resample(raw, rate, 16000)
