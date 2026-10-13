"""Opt-in capture of what the microphone really delivered, for diagnosing recognition problems.

OFF by default. Set VOICE_DIAGNOSTICS=1 and each finished turn is saved under voice-service/diagnostics/
as a WAV plus a small JSON (durations, levels, both transcripts, timings). It is the only place raw
audio and transcripts are ever written, it stays on this computer, and the folder is git-ignored.
Delete the folder to remove everything. Use `python -m evalab.label` to add the correct text to a
capture, then `python -m evalab.model_bench --captures` to score the models on real microphone audio.
"""

from __future__ import annotations

import json
import time
import wave
from pathlib import Path

import numpy as np

from app.asr.base import Transcript

DIAG_DIR = Path(__file__).resolve().parents[2] / "diagnostics"


def audio_stats(x: np.ndarray) -> dict:
    if x.size == 0:
        return {"seconds": 0.0}
    return {
        "seconds": round(x.size / 16000, 3),
        "rms": round(float(np.sqrt(np.mean(x**2))), 5),
        "peak": round(float(np.max(np.abs(x))), 4),
        "clipped_fraction": round(float(np.mean(np.abs(x) >= 0.999)), 5),
        "silent_fraction": round(float(np.mean(np.abs(x) < 0.003)), 3),
    }


def save_capture(audio: np.ndarray, result: Transcript, directory: Path = DIAG_DIR) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    stem = time.strftime("%Y%m%d-%H%M%S") + f"-{int(time.time() * 1000) % 1000:03d}"
    pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2")
    with wave.open(str(directory / f"{stem}.wav"), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(pcm.tobytes())
    meta = {
        "audio": audio_stats(audio),
        "final": result.text,
        "streaming": result.streaming_text,
        "agreement": result.agreement,
        "refine_ms": result.refine_ms,
        "reference": None,  # fill in with: python -m evalab.label
    }
    (directory / f"{stem}.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
    return directory / f"{stem}.wav"
