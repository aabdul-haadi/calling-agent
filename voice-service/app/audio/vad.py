"""Voice activity detection (Silero VAD through sherpa-onnx), exposed as speech start/end events.

The detector looks at 32 ms windows (512 samples at 16 kHz). `min_speech_ms` is how long speech must
last before it is reported (this is the onset delay), and `min_silence_ms` how long silence must
last before speech is reported as ended (this is the end-of-turn delay).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np

from app.asr.streaming import MissingModelError
from app.config import MODELS_DIR

SAMPLE_RATE = 16000
WINDOW = 512  # samples; Silero VAD at 16 kHz works on 32 ms windows


@dataclass(frozen=True)
class VadEvent:
    kind: str  # "start" | "end"
    # Stream position, in samples, at which the detector reached this decision.
    at_sample: int

    @property
    def at_ms(self) -> float:
        return self.at_sample * 1000.0 / SAMPLE_RATE


class SpeechDetector:
    def __init__(
        self,
        threshold: float = 0.5,
        min_speech_ms: int = 100,
        min_silence_ms: int = 600,
        model_path: Path | None = None,
    ) -> None:
        import sherpa_onnx

        path = model_path or (MODELS_DIR / "silero_vad.onnx")
        if not path.exists():
            raise MissingModelError(
                f"The VAD model is missing at {path}. Run: python -m app.tools.download_models"
            )
        cfg = sherpa_onnx.VadModelConfig()
        cfg.silero_vad.model = str(path)
        cfg.silero_vad.threshold = threshold
        cfg.silero_vad.min_speech_duration = min_speech_ms / 1000.0
        cfg.silero_vad.min_silence_duration = min_silence_ms / 1000.0
        cfg.silero_vad.window_size = WINDOW
        cfg.sample_rate = SAMPLE_RATE
        self._cfg = cfg
        self._sherpa = sherpa_onnx
        self.threshold = threshold
        self.min_speech_ms = min_speech_ms
        self.min_silence_ms = min_silence_ms
        self._vad = sherpa_onnx.VoiceActivityDetector(cfg, buffer_size_in_seconds=10)
        self._pending = np.zeros(0, dtype=np.float32)
        self._position = 0
        self._speaking = False

    @property
    def in_speech(self) -> bool:
        return self._speaking

    def reset(self) -> None:
        self._vad = self._sherpa.VoiceActivityDetector(self._cfg, buffer_size_in_seconds=10)
        self._pending = np.zeros(0, dtype=np.float32)
        self._position = 0
        self._speaking = False

    def feed(self, samples: np.ndarray) -> list[VadEvent]:
        """Add mono float32 16 kHz audio of any length; returns the start/end events it caused."""
        events: list[VadEvent] = []
        data = np.concatenate([self._pending, samples.astype(np.float32, copy=False)])
        n = (data.size // WINDOW) * WINDOW
        for i in range(0, n, WINDOW):
            self._vad.accept_waveform(data[i : i + WINDOW])
            self._position += WINDOW
            now = self._vad.is_speech_detected()
            if now != self._speaking:
                self._speaking = now
                events.append(VadEvent("start" if now else "end", self._position))
            # Completed segments are not needed (we stream audio ourselves): drop them.
            while not self._vad.empty():
                self._vad.pop()
        self._pending = data[n:]
        return events
