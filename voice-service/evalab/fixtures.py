"""Reproducible test audio. Everything is generated from text with the local voice plus a seeded
random generator, so there are no recordings of real people and the same command always yields the
same files.

The voice is synthetic and clean, so recognition on it is easier than on a real microphone. That is
why the benchmark also reports the real LibriSpeech clips bundled with the recognizer, and why
"noisy", "telephone" and "fast" variants exist. Treat the numbers as a regression baseline, not as
a promise about real callers.
"""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from app.audio.resampling import resample
from app.tts.streaming import SherpaTts

ROOT = Path(__file__).resolve().parents[1]
GENERATED = ROOT / "tests" / "fixtures" / "generated"
SEED = 20261012

# Domain phrases. Booking references are spelled the way people say them on the phone.
PHRASES: dict[str, str] = {
    "yes": "Yes",
    "no": "No",
    "yes_please": "Yes please go ahead",
    "greeting": "Hello I would like to change my flight please",
    "ref": "My booking reference is S K one zero zero one",
    "ref_and_name": "My booking reference is S K one zero zero two and my last name is Okafor",
    "cancelled": "My flight to London was cancelled and I need to rebook it for tomorrow",
    "pick": "Please book me on the first option you listed",
    "refund": "Can I get a refund and how long does it take to arrive",
    "bags": "How many checked bags can I bring on an economy fare",
    "human": "I want to talk to a real person right now",
    "long": (
        "I booked this trip months ago for my sister and me and now the airline tells me that our "
        "flight is cancelled so I need to know what my options are and whether we can both travel "
        "on the same day without paying anything extra"
    ),
    "ambiguous_time": "I would take the flight at three fifty or maybe the one at five fifteen",
    "interrupter": "Actually make that the evening flight instead",
}


@dataclass(frozen=True)
class Fixture:
    name: str  # e.g. "greeting.clean"
    phrase: str
    condition: str
    reference: str
    audio: np.ndarray  # float32, 16 kHz

    @property
    def seconds(self) -> float:
        return self.audio.size / 16000


def synth(tts: SherpaTts, text: str, speed: float = 1.0) -> np.ndarray:
    previous = tts.speed
    tts.speed = speed
    try:
        chunks: list[np.ndarray] = []
        tts.synthesize(text, lambda s: chunks.append(s) or True, threading.Event())
    finally:
        tts.speed = previous
    return np.concatenate(chunks).astype(np.float32)


def add_noise(x: np.ndarray, snr_db: float, rng: np.random.Generator) -> np.ndarray:
    """White noise at the given signal-to-noise ratio (measured over the whole clip)."""
    power = float(np.mean(x**2)) + 1e-12
    noise = rng.standard_normal(x.size).astype(np.float32) * np.sqrt(power / 10 ** (snr_db / 10))
    return np.clip(x + noise, -1, 1).astype(np.float32)


def add_babble(x: np.ndarray, others: list[np.ndarray], snr_db: float, rng: np.random.Generator) -> np.ndarray:
    """Other people talking in the background: three voices mixed together at a given SNR."""
    babble = np.zeros(x.size, dtype=np.float32)
    for o in others:
        start = int(rng.integers(0, max(1, o.size)))
        rolled = np.roll(o, -start)
        reps = int(np.ceil(x.size / rolled.size))
        babble += np.tile(rolled, reps)[: x.size]
    sp, bp = float(np.mean(x**2)) + 1e-12, float(np.mean(babble**2)) + 1e-12
    babble *= np.sqrt(sp / (bp * 10 ** (snr_db / 10)))
    return np.clip(x + babble, -1, 1).astype(np.float32)


def telephone(x: np.ndarray) -> np.ndarray:
    """Narrow-band phone quality: squeeze to 8 kHz and back."""
    return resample(resample(x, 16000, 8000), 8000, 16000)


def with_pause(x: np.ndarray, seconds: float) -> np.ndarray:
    """A long thinking pause in the middle of the sentence."""
    mid = x.size // 2
    return np.concatenate([x[:mid], np.zeros(int(16000 * seconds), dtype=np.float32), x[mid:]])


CONDITIONS = ("clean", "snr20", "snr10", "snr5", "babble10", "telephone", "fast", "pause")


def build(tts: SherpaTts, phrases: list[str] | None = None, conditions: tuple[str, ...] = CONDITIONS) -> list[Fixture]:
    rng = np.random.default_rng(SEED)
    chosen = {k: v for k, v in PHRASES.items() if phrases is None or k in phrases}
    clean = {k: synth(tts, v) for k, v in chosen.items()}
    voices = [synth(tts, PHRASES["long"]), synth(tts, PHRASES["cancelled"]), synth(tts, PHRASES["refund"])]
    out: list[Fixture] = []
    for key, text in chosen.items():
        x = clean[key]
        variants = {
            "clean": lambda: x,
            "snr20": lambda: add_noise(x, 20, rng),
            "snr10": lambda: add_noise(x, 10, rng),
            "snr5": lambda: add_noise(x, 5, rng),
            "babble10": lambda: add_babble(x, voices, 10, rng),
            "telephone": lambda: telephone(x),
            "fast": lambda: synth(tts, text, speed=1.35),
            "pause": lambda: with_pause(x, 1.8),
        }
        for cond in conditions:
            out.append(Fixture(f"{key}.{cond}", key, cond, text, variants[cond]()))
    return out


def write_manifest(fixtures: list[Fixture]) -> Path:
    """Save the audio and a manifest with checksums, so a run can be reproduced and verified."""
    import hashlib
    import wave

    GENERATED.mkdir(parents=True, exist_ok=True)
    entries = []
    for f in fixtures:
        path = GENERATED / f"{f.name}.wav"
        pcm = (np.clip(f.audio, -1, 1) * 32767).astype("<i2").tobytes()
        with wave.open(str(path), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(16000)
            w.writeframes(pcm)
        entries.append(
            {"name": f.name, "reference": f.reference, "condition": f.condition, "seconds": round(f.seconds, 2),
             "sha256": hashlib.sha256(pcm).hexdigest()[:16]}
        )
    manifest = GENERATED / "manifest.json"
    manifest.write_text(json.dumps({"seed": SEED, "fixtures": entries}, indent=1), encoding="utf-8")
    return manifest
