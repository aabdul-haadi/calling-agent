"""Speech recognition interface. Swap the engine by implementing these two protocols."""

from __future__ import annotations

from typing import Protocol

import numpy as np


class RecognizerStream(Protocol):
    """One utterance. Audio goes in as it arrives; a partial transcript can be read at any time."""

    def accept(self, samples: np.ndarray) -> None:
        """Add mono float32 audio in [-1, 1] at the recognizer's sample rate."""

    def partial(self) -> str:
        """Best transcript so far (may change as more audio arrives)."""

    def finish(self) -> str:
        """No more audio: flush and return the final transcript. The stream is unusable after."""


class Recognizer(Protocol):
    sample_rate: int
    name: str

    def create_stream(self) -> RecognizerStream: ...

    def warm_up(self) -> float:
        """Run a short silent decode so the first real turn does not pay start-up cost. Seconds."""
