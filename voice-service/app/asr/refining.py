"""Two-pass recognition: live captions from the streaming model, the final text from an offline one.

The streaming model gives partial transcripts while the customer talks. When the turn ends, an
offline model re-decodes the whole utterance (it sees the full sentence, so it is far better on
accents, names, and numbers) and ITS text is what goes to the agent. If the offline pass fails or
is switched off, the streaming text is used, so recognition never gets worse than before.

Confidence: the offline model gives no probability, so none is invented. The signal used is
agreement between the two independent passes (compared as spoken words, see spoken.py). If they
disagree a lot, the transcript is flagged uncertain, and the agent runtime asks the customer to
repeat instead of acting on it.
"""

from __future__ import annotations

import logging
import time
from typing import Protocol

import numpy as np

from app.asr.base import Recognizer, RecognizerStream, Transcript
from app.asr.spoken import agreement

log = logging.getLogger("voice.asr")


class OfflineDecoder(Protocol):
    name: str

    def transcribe(self, samples: np.ndarray) -> str: ...

    def warm_up(self) -> float: ...


class RefiningStream:
    def __init__(self, owner: "RefiningRecognizer", inner: RecognizerStream) -> None:
        self._owner = owner
        self._inner = inner
        self._chunks: list[np.ndarray] = []
        self._samples = 0

    def accept(self, samples: np.ndarray) -> None:
        if samples.size and self._samples < self._owner.max_samples:
            self._chunks.append(np.array(samples, dtype=np.float32, copy=True))
            self._samples += samples.size
        self._inner.accept(samples)

    def partial(self) -> str:
        return self._inner.partial()

    def finish(self) -> Transcript:
        live = self._inner.finish()
        if not live.text or self._samples >= self._owner.max_samples:
            return live  # nothing heard, or too long to re-decode in time: keep the live result
        audio = np.concatenate(self._chunks)
        self._chunks.clear()
        t0 = time.perf_counter()
        try:
            text = self._owner.offline.transcribe(audio).strip()
        except Exception:  # noqa: BLE001 - fall back to the live transcript
            log.exception("second pass failed; using the live result")
            return live
        ms = (time.perf_counter() - t0) * 1000
        if not text:
            return Transcript(live.text, live.confidence, live.weakest, live.text, None, ms)
        agree = agreement(text, live.text)
        # Agreement is the only honest confidence signal available for the offline text.
        result = Transcript(text, agree, agree, live.text, agree, ms)
        if self._owner.on_decoded is not None:
            try:
                self._owner.on_decoded(audio, result)
            except Exception:  # noqa: BLE001 - diagnostics must never break a call
                log.exception("capture hook failed")
        return result


class RefiningRecognizer:
    def __init__(self, live: Recognizer, offline: OfflineDecoder, max_seconds: float = 30.0, on_decoded=None) -> None:
        self.live = live
        self.on_decoded = on_decoded  # optional hook (audio, result), used by opt-in diagnostics
        self.offline = offline
        self.sample_rate = live.sample_rate
        self.max_samples = int(max_seconds * self.sample_rate)
        self.name = f"{live.name} + {offline.name}"
        self.load_seconds = getattr(live, "load_seconds", 0.0) + getattr(offline, "load_seconds", 0.0)

    def create_stream(self) -> RefiningStream:
        return RefiningStream(self, self.live.create_stream())

    def warm_up(self) -> float:
        return self.live.warm_up() + self.offline.warm_up()
