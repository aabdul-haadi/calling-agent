"""Offline (whole-utterance) recognizers used to re-decode a finished turn.

A streaming model decides each word with little look-ahead, so it is fast but less accurate,
especially on accents it saw little of in training. An offline model sees the whole utterance at
once. The gateway keeps the streaming model for live captions and the instant "I heard you" signal,
then re-decodes the finished turn with an offline model and uses that text.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from app.asr.base import Transcript
from app.asr.streaming import MissingModelError
from app.config import MODELS_DIR


@dataclass(frozen=True)
class OfflineSpec:
    key: str
    folder: str
    kind: str  # "nemo_transducer" | "whisper"
    files: dict[str, str]
    description: str
    download_key: str


OFFLINE_MODELS: dict[str, OfflineSpec] = {
    "parakeet-tdt-0.6b-v2": OfflineSpec(
        key="parakeet-tdt-0.6b-v2",
        folder="sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
        kind="nemo_transducer",
        files={
            "encoder": "encoder.int8.onnx",
            "decoder": "decoder.int8.onnx",
            "joiner": "joiner.int8.onnx",
            "tokens": "tokens.txt",
        },
        description="NVIDIA Parakeet TDT 0.6B v2, int8 (English, CC-BY-4.0)",
        download_key="asr-offline",
    ),
}


class OfflineRecognizer:
    sample_rate = 16000

    def __init__(self, model: str, num_threads: int = 4) -> None:
        import sherpa_onnx

        if model not in OFFLINE_MODELS:
            raise ValueError(f"unknown offline model '{model}', choose one of {sorted(OFFLINE_MODELS)}")
        spec = OFFLINE_MODELS[model]
        paths = {k: str(MODELS_DIR / spec.folder / v) for k, v in spec.files.items()}
        missing = [Path(p).name for p in paths.values() if not Path(p).exists()]
        if missing:
            raise MissingModelError(
                f"Speech model '{model}' is missing {missing} in {MODELS_DIR / spec.folder}. "
                f"Run: python -m app.tools.download_models --only {spec.download_key}"
            )
        self.name = f"sherpa-onnx/{spec.key}"
        self.spec = spec
        t0 = time.perf_counter()
        if spec.kind == "nemo_transducer":
            self._rec = sherpa_onnx.OfflineRecognizer.from_transducer(
                encoder=paths["encoder"],
                decoder=paths["decoder"],
                joiner=paths["joiner"],
                tokens=paths["tokens"],
                num_threads=num_threads,
                sample_rate=self.sample_rate,
                feature_dim=80,
                decoding_method="greedy_search",
                model_type="nemo_transducer",
            )
        else:
            self._rec = sherpa_onnx.OfflineRecognizer.from_whisper(
                encoder=paths["encoder"],
                decoder=paths["decoder"],
                tokens=paths["tokens"],
                num_threads=num_threads,
                language="en",
                task="transcribe",
            )
        self.load_seconds = time.perf_counter() - t0
        self._lock = threading.Lock()

    def transcribe(self, samples: np.ndarray) -> str:
        """Decode a whole utterance (mono float32 at 16 kHz). Thread-safe; decodes one at a time."""
        # Offline models need a little silence at both ends or they clip the first and last sounds.
        pad = np.zeros(int(0.25 * self.sample_rate), dtype=np.float32)
        x = np.concatenate([pad, np.ascontiguousarray(samples, dtype=np.float32), pad])
        with self._lock:
            s = self._rec.create_stream()
            s.accept_waveform(self.sample_rate, x)
            self._rec.decode_stream(s)
            return s.result.text.strip()

    def warm_up(self) -> float:
        t0 = time.perf_counter()
        self.transcribe(np.zeros(self.sample_rate, dtype=np.float32))
        return time.perf_counter() - t0


__all__ = ["OfflineRecognizer", "OFFLINE_MODELS", "Transcript"]
