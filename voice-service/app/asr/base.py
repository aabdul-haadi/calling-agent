"""Speech recognition interface. Swap the engine by implementing these two protocols."""

from __future__ import annotations

from typing import Protocol

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class Transcript:
    text: str
    # Geometric mean of the model's probability for each word piece it chose, 0 to 1. Low means the
    # model was guessing. 0.0 when there is no text.
    confidence: float
    # Probability of the least certain word piece, 0 to 1.
    weakest: float
    # Set when a second, more accurate pass re-decoded the turn: what the live (streaming) model
    # heard, and how closely the two passes agreed (1.0 = same words). None otherwise.
    streaming_text: str | None = None
    agreement: float | None = None
    refine_ms: float | None = None


class RecognizerStream(Protocol):
    """One utterance. Audio goes in as it arrives; a partial transcript can be read at any time."""

    def accept(self, samples: np.ndarray) -> None:
        """Add mono float32 audio in [-1, 1] at the recognizer's sample rate."""

    def partial(self) -> str:
        """Best transcript so far (may change as more audio arrives)."""

    def finish(self) -> Transcript:
        """No more audio: flush and return the final transcript. The stream is unusable after."""


class Recognizer(Protocol):
    sample_rate: int
    name: str

    def create_stream(self) -> RecognizerStream: ...

    def warm_up(self) -> float:
        """Run a short silent decode so the first real turn does not pay start-up cost. Seconds."""
