"""Speech synthesis interface. Swap the engine (Piper, Kokoro, ...) by implementing Synthesizer."""

from __future__ import annotations

import threading
from typing import Callable, Protocol

import numpy as np

# Called once per generated audio piece with mono float32 samples. Return False to stop early.
ChunkSink = Callable[[np.ndarray], bool]


class Synthesizer(Protocol):
    sample_rate: int
    name: str

    def synthesize(self, text: str, sink: ChunkSink, cancel: threading.Event, *,
                   speaker: str | None = None, speed: float | None = None) -> bool:
        """Blocking. Generates audio for `text` and hands pieces to `sink` as they are ready.

        Stops as soon as `cancel` is set or `sink` returns False. Returns True only if all of the
        text was synthesized. Raises on engine failure (the caller recovers).
        """

    def warm_up(self) -> float:
        """Synthesize a short phrase so the first real reply does not pay start-up cost. Seconds."""
