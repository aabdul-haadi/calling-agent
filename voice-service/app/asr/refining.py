"""Two-pass recognition: live captions from the streaming model, the final text from an offline one.

The streaming model gives partial transcripts while the customer talks. When the turn ends, an
offline model re-decodes the whole utterance (it sees the full sentence, so it is far better on
accents, names, and numbers) and ITS text is what goes to the agent. If the offline pass fails or
is switched off, the streaming text is used, so recognition never gets worse than before.

Confidence: the offline model gives no probability, so none is invented. The signal used is
agreement between the two independent passes (compared as spoken words, see spoken.py). If they
disagree a lot, the transcript is flagged uncertain, and the agent runtime asks the customer to
repeat instead of acting on it.

Prefetch: the offline pass takes about half a second, and the turn is only confirmed over after
a pause of 600 ms. `prefetch()` lets the session start the offline pass a little way into that
pause, so most of the work is already done when the turn ends. If the customer speaks again the
session calls `discard_prefetch()` and the result is thrown away; the audio of a finished turn is
always the audio that was decoded.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Protocol

import numpy as np

from app.asr.base import Recognizer, RecognizerStream, Transcript
from app.asr.spoken import agreement

log = logging.getLogger("voice.asr")


class OfflineDecoder(Protocol):
    name: str

    def transcribe(self, samples: np.ndarray) -> str: ...

    def warm_up(self) -> float: ...


@dataclass
class _Prefetch:
    samples: int
    done: threading.Event = field(default_factory=threading.Event)
    text: str | None = None
    audio: np.ndarray | None = None
    failed: bool = False
    started: float = field(default_factory=time.perf_counter)


class RefiningStream:
    def __init__(self, owner: "RefiningRecognizer", inner: RecognizerStream) -> None:
        self._owner = owner
        self._inner = inner
        self._chunks: list[np.ndarray] = []
        self._samples = 0
        self._lock = threading.Lock()
        self._pf: _Prefetch | None = None

    def accept(self, samples: np.ndarray) -> None:
        if samples.size:
            with self._lock:
                if self._samples < self._owner.max_samples:
                    self._chunks.append(np.array(samples, dtype=np.float32, copy=True))
                    self._samples += samples.size
        self._inner.accept(samples)

    def partial(self) -> str:
        return self._inner.partial()

    # ------------------------------------------------------------------------------------------

    def prefetch(self) -> None:
        """Run the accurate pass on what has been heard so far. Blocking: call it from a worker thread.

        Does nothing if one is already running, there is no audio, or the turn is too long to
        re-decode (the live result is used for those)."""
        with self._lock:
            if self._pf is not None or not self._chunks or self._samples >= self._owner.max_samples:
                return
            pf = _Prefetch(samples=self._samples)
            self._pf = pf
            audio = np.concatenate(self._chunks)
        try:
            pf.text = self._owner.offline.transcribe(audio).strip()
            pf.audio = audio
        except Exception:  # noqa: BLE001 - finish() falls back to decoding again
            log.exception("prefetched second pass failed")
            pf.failed = True
        finally:
            pf.done.set()

    def discard_prefetch(self) -> None:
        """The customer spoke again: whatever the prefetch decodes is out of date."""
        with self._lock:
            self._pf = None

    # ------------------------------------------------------------------------------------------

    def finish(self) -> Transcript:
        live = self._inner.finish()
        if not live.text or self._samples >= self._owner.max_samples:
            return live  # nothing heard, or too long to re-decode in time: keep the live result
        t0 = time.perf_counter()
        with self._lock:
            pf = self._pf
        prefetched = False
        text = ""
        audio: np.ndarray | None = None
        if pf is not None:
            pf.done.wait(timeout=30)  # most of the time it is already finished
            if not pf.failed and pf.text is not None:
                text, audio, prefetched = pf.text, pf.audio, True
        if not prefetched:
            with self._lock:
                audio = np.concatenate(self._chunks)
                self._chunks.clear()
            try:
                text = self._owner.offline.transcribe(audio).strip()
            except Exception:  # noqa: BLE001 - fall back to the live transcript
                log.exception("second pass failed; using the live result")
                return live
        else:
            with self._lock:
                self._chunks.clear()
        ms = (time.perf_counter() - t0) * 1000  # the time this turn actually waited for the second pass
        if not text:
            return Transcript(live.text, live.confidence, live.weakest, live.text, None, ms)
        agree = agreement(text, live.text)
        # Agreement is the only honest confidence signal available for the offline text.
        result = Transcript(text, agree, agree, live.text, agree, ms, prefetched)
        if self._owner.on_decoded is not None and audio is not None:
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
