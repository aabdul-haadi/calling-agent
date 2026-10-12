"""Piper (VITS) voices through sherpa-onnx.

One call to `synthesize` handles one phrase. sherpa-onnx generates a phrase and reports it through
a callback, which is where cancellation takes effect: returning 0 stops generation, so an
interrupted reply stops costing CPU as soon as the current phrase finishes its internal step.
"""

from __future__ import annotations

import threading
import time
from pathlib import Path

import numpy as np

from app.asr.streaming import MissingModelError
from app.config import MODELS_DIR
from app.tts.base import ChunkSink

VOICES = {
    "piper-amy-low": "vits-piper-en_US-amy-low",
}


class SherpaTts:
    def __init__(self, voice: str = "piper-amy-low", num_threads: int = 2, speed: float = 1.0) -> None:
        import sherpa_onnx

        if voice not in VOICES:
            raise ValueError(f"unknown voice '{voice}', choose one of {sorted(VOICES)}")
        folder = MODELS_DIR / VOICES[voice]
        model = next(iter(folder.glob("*.onnx")), None)
        if model is None or not (folder / "tokens.txt").exists():
            raise MissingModelError(
                f"Voice '{voice}' is not installed in {folder}. Run: python -m app.tools.download_models"
            )
        self.name = f"sherpa-onnx/{voice}"
        self.speed = speed
        t0 = time.perf_counter()
        self._tts = sherpa_onnx.OfflineTts(
            sherpa_onnx.OfflineTtsConfig(
                model=sherpa_onnx.OfflineTtsModelConfig(
                    vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                        model=str(model),
                        tokens=str(folder / "tokens.txt"),
                        data_dir=str(folder / "espeak-ng-data"),
                    ),
                    num_threads=num_threads,
                    provider="cpu",
                ),
                max_num_sentences=1,
            )
        )
        self.sample_rate: int = self._tts.sample_rate
        self.load_seconds = time.perf_counter() - t0
        # The native engine is not safe to call from two threads at once.
        self._lock = threading.Lock()

    def synthesize(self, text: str, sink: ChunkSink, cancel: threading.Event) -> bool:
        text = text.strip()
        if not text:
            return True
        completed = True

        def callback(samples: np.ndarray, _progress: float) -> int:
            nonlocal completed
            if cancel.is_set():
                completed = False
                return 0
            if not sink(np.asarray(samples, dtype=np.float32)):
                completed = False
                return 0
            return 1

        with self._lock:
            if cancel.is_set():
                return False
            self._tts.generate(text, sid=0, speed=self.speed, callback=callback)
        return completed and not cancel.is_set()

    def warm_up(self) -> float:
        t0 = time.perf_counter()
        self.synthesize("Hello.", lambda _s: True, threading.Event())
        return time.perf_counter() - t0


def installed(voice: str = "piper-amy-low") -> bool:
    folder = MODELS_DIR / VOICES[voice]
    return Path(folder / "tokens.txt").exists()
