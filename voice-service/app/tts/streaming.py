"""Piper (VITS) voices through sherpa-onnx.

One call to `synthesize` handles one phrase. sherpa-onnx generates a phrase and reports it through
a callback, which is where cancellation takes effect: returning 0 stops generation, so an
interrupted reply stops costing CPU as soon as the current phrase finishes its internal step.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from app.asr.streaming import MissingModelError
from app.config import MODELS_DIR
from app.tts.base import ChunkSink

@dataclass(frozen=True)
class VoiceSpec:
    key: str
    folder: str
    kind: str  # "vits" (Piper) | "kokoro"
    licence: str
    description: str
    download_key: str
    # Named speakers of a multi-speaker model (name -> speaker id). Empty for single-voice models.
    speakers: dict[str, int] = field(default_factory=dict)


# Kokoro v1.0 speaker table, in the order sherpa-onnx's voices.bin stores it (af/am = US female/male,
# bf/bm = British). Checked for gender by pitch in evalab/tts_bench.py.
KOKORO_SPEAKERS = {n: i for i, n in enumerate(
    "af_alloy af_aoede af_bella af_heart af_jessica af_kore af_nicole af_nova af_river af_sarah af_sky "
    "am_adam am_echo am_eric am_fenrir am_liam am_michael am_onyx am_puck am_santa "
    "bf_alice bf_emma bf_isabella bf_lily bm_daniel bm_fable bm_george bm_lewis".split())}

VOICES: dict[str, VoiceSpec] = {
    "piper-amy-low": VoiceSpec("piper-amy-low", "vits-piper-en_US-amy-low", "vits", "see model card", "Piper amy, low quality, 16 kHz", "tts"),
    "piper-amy-medium": VoiceSpec("piper-amy-medium", "vits-piper-en_US-amy-medium", "vits", "see model card", "Piper amy, medium, 22 kHz", "tts-amy-medium"),
    "piper-hfc-female-medium": VoiceSpec("piper-hfc-female-medium", "vits-piper-en_US-hfc_female-medium", "vits", "see model card", "Piper hfc_female, medium", "tts-hfc-female"),
    "piper-lessac-high": VoiceSpec("piper-lessac-high", "vits-piper-en_US-lessac-high", "vits", "see model card", "Piper lessac, high, 22 kHz", "tts-lessac-high"),
    "kokoro": VoiceSpec("kokoro", "kokoro-multi-lang-v1_0", "kokoro", "Apache-2.0 (Kokoro-82M)", "Kokoro 82M v1.0, 24 kHz, many voices", "tts-kokoro", KOKORO_SPEAKERS),
}


class SherpaTts:
    """One loaded engine. Kokoro is multi-speaker, so a call may pick a speaker by name and a speed;
    single-voice Piper models ignore the speaker."""

    def __init__(self, voice: str = "piper-amy-low", num_threads: int = 2, speed: float = 1.0,
                 speaker: str | None = None) -> None:
        import sherpa_onnx

        if voice not in VOICES:
            raise ValueError(f"unknown voice '{voice}', choose one of {sorted(VOICES)}")
        spec = VOICES[voice]
        folder = MODELS_DIR / spec.folder
        model = folder / "model.onnx" if spec.kind == "kokoro" else next(iter(folder.glob("*.onnx")), None)
        if model is None or not model.exists() or not (folder / "tokens.txt").exists():
            raise MissingModelError(
                f"Voice '{voice}' is not installed in {folder}. "
                f"Run: python -m app.tools.download_models --only {spec.download_key}"
            )
        self.name = f"sherpa-onnx/{voice}"
        self.spec = spec
        self.speed = speed
        self.default_speaker = speaker if speaker in spec.speakers else (next(iter(spec.speakers), None))
        t0 = time.perf_counter()
        if spec.kind == "kokoro":
            model_cfg = sherpa_onnx.OfflineTtsModelConfig(
                kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
                    model=str(model),
                    voices=str(folder / "voices.bin"),
                    tokens=str(folder / "tokens.txt"),
                    data_dir=str(folder / "espeak-ng-data"),
                    dict_dir=str(folder / "dict"),
                    lexicon=f'{folder / "lexicon-us-en.txt"},{folder / "lexicon-zh.txt"}',
                ),
                num_threads=num_threads,
                provider="cpu",
            )
        else:
            model_cfg = sherpa_onnx.OfflineTtsModelConfig(
                vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                    model=str(model),
                    tokens=str(folder / "tokens.txt"),
                    data_dir=str(folder / "espeak-ng-data"),
                ),
                num_threads=num_threads,
                provider="cpu",
            )
        self._tts = sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(model=model_cfg, max_num_sentences=1))
        self.sample_rate: int = self._tts.sample_rate
        self.load_seconds = time.perf_counter() - t0
        # The native engine is not safe to call from two threads at once.
        self._lock = threading.Lock()

    def synthesize(self, text: str, sink: ChunkSink, cancel: threading.Event, *,
                   speaker: str | None = None, speed: float | None = None) -> bool:
        text = text.strip()
        if not text:
            return True
        completed = True
        name = speaker if speaker in self.spec.speakers else self.default_speaker
        sid = self.spec.speakers.get(name, 0) if name else 0

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
            self._tts.generate(text, sid=sid, speed=speed or self.speed, callback=callback)
        return completed and not cancel.is_set()

    def warm_up(self) -> float:
        t0 = time.perf_counter()
        self.synthesize("Hello.", lambda _s: True, threading.Event())
        return time.perf_counter() - t0


def installed(voice: str = "piper-amy-low") -> bool:
    spec = VOICES[voice]
    return Path(MODELS_DIR / spec.folder / "tokens.txt").exists()
