"""Streaming speech recognition with sherpa-onnx transducers.

This is real streaming: audio is decoded incrementally while it arrives, so partial transcripts
appear during speech and the final transcript is ready almost as soon as the speaker stops. The
model keeps its own state per stream. (Feeding chunks to an offline model would not be streaming;
these are online transducer models.)
"""

from __future__ import annotations

import math
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from app.asr.base import Transcript
from app.config import MODELS_DIR


@dataclass(frozen=True)
class AsrModelSpec:
    key: str
    folder: str
    encoder: str
    decoder: str
    joiner: str
    description: str

    def path(self, name: str) -> str:
        return str(MODELS_DIR / self.folder / name)


ASR_MODELS: dict[str, AsrModelSpec] = {
    "zipformer-20m": AsrModelSpec(
        key="zipformer-20m",
        folder="sherpa-onnx-streaming-zipformer-en-20M-2023-02-17",
        encoder="encoder-epoch-99-avg-1.int8.onnx",
        decoder="decoder-epoch-99-avg-1.int8.onnx",
        joiner="joiner-epoch-99-avg-1.int8.onnx",
        description="20M parameters, int8 (fast fallback; drops leading words on real speech)",
    ),
    "zipformer-large": AsrModelSpec(
        key="zipformer-large",
        folder="sherpa-onnx-streaming-zipformer-en-2023-06-26",
        encoder="encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx",
        decoder="decoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx",
        joiner="joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx",
        description="zipformer 2023-06-26, int8 (default)",
    ),
}


class MissingModelError(RuntimeError):
    """A model file is not on disk. The message says exactly how to get it."""


def _require(spec: AsrModelSpec) -> None:
    missing = [
        n for n in (spec.encoder, spec.decoder, spec.joiner, "tokens.txt") if not Path(spec.path(n)).exists()
    ]
    if missing:
        raise MissingModelError(
            f"Speech model '{spec.key}' is missing {missing} in {MODELS_DIR / spec.folder}. "
            "Run: python -m app.tools.download_models"
            + (" --only asr-small" if spec.key == "zipformer-20m" else "")
        )


class SherpaStream:
    def __init__(self, owner: "SherpaRecognizer") -> None:
        self._owner = owner
        self._stream = owner._rec.create_stream()
        self._last = ""

    def accept(self, samples: np.ndarray) -> None:
        if samples.size == 0:
            return
        self._stream.accept_waveform(self._owner.sample_rate, np.ascontiguousarray(samples, dtype=np.float32))
        self._owner._decode_ready(self._stream)

    def partial(self) -> str:
        with self._owner._lock:
            self._last = self._owner._rec.get_result(self._stream).strip()
        return self._last

    def finish(self) -> Transcript:
        # Half a second of silence flushes the last frames out of the model's look-ahead.
        pad = np.zeros(int(0.5 * self._owner.sample_rate), dtype=np.float32)
        self._stream.accept_waveform(self._owner.sample_rate, pad)
        self._stream.input_finished()
        self._owner._decode_ready(self._stream)
        with self._owner._lock:
            result = self._owner._rec.get_result_all(self._stream)
        text = result.text.strip()
        probs = [float(p) for p in result.ys_probs]  # natural-log probability of each chosen piece
        if not text or not probs:
            return Transcript(text, 0.0, 0.0)
        return Transcript(text, math.exp(sum(probs) / len(probs)), math.exp(min(probs)))


class SherpaRecognizer:
    sample_rate = 16000

    def __init__(self, model: str = "zipformer-large", num_threads: int = 2) -> None:
        import sherpa_onnx

        if model not in ASR_MODELS:
            raise ValueError(f"unknown ASR model '{model}', choose one of {sorted(ASR_MODELS)}")
        spec = ASR_MODELS[model]
        _require(spec)
        self.name = f"sherpa-onnx/{spec.key}"
        self.spec = spec
        t0 = time.perf_counter()
        self._rec = sherpa_onnx.OnlineRecognizer.from_transducer(
            tokens=spec.path("tokens.txt"),
            encoder=spec.path(spec.encoder),
            decoder=spec.path(spec.decoder),
            joiner=spec.path(spec.joiner),
            num_threads=num_threads,
            sample_rate=self.sample_rate,
            feature_dim=80,
            decoding_method="greedy_search",
        )
        self.load_seconds = time.perf_counter() - t0
        # The recognizer is shared by all sessions; decoding is serialised.
        self._lock = threading.Lock()

    def _decode_ready(self, stream: object) -> None:
        with self._lock:
            while self._rec.is_ready(stream):
                self._rec.decode_stream(stream)

    def create_stream(self) -> SherpaStream:
        return SherpaStream(self)

    def warm_up(self) -> float:
        t0 = time.perf_counter()
        s = self.create_stream()
        s.accept(np.zeros(self.sample_rate, dtype=np.float32))
        s.finish()
        return time.perf_counter() - t0
