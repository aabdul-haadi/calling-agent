"""Deterministic stand-ins for the models and the agent runtime, so the session logic can be tested
exactly: when speech starts and ends is scripted, not detected."""

from __future__ import annotations

import asyncio
import threading
import time
from dataclasses import dataclass, field
from typing import Any, AsyncIterator

import numpy as np

from app.asr.base import Transcript
from app.audio.vad import VadEvent

FRAME = 320  # 20 ms at 16 kHz


class FakeDetector:
    """Reports `start` / `end` when the stream position passes the scripted sample counts."""

    def __init__(self, script: list[tuple[int, str]] | None = None, **_: Any) -> None:
        self.script = sorted(script or [])
        self._pos = 0
        self._i = 0
        self.in_speech = False

    def reset(self) -> None:
        self._pos = 0
        self._i = 0
        self.in_speech = False

    def feed(self, samples: np.ndarray) -> list[VadEvent]:
        self._pos += samples.size
        out: list[VadEvent] = []
        while self._i < len(self.script) and self.script[self._i][0] <= self._pos:
            kind = self.script[self._i][1]
            self.in_speech = kind == "start"
            out.append(VadEvent(kind, self._pos))
            self._i += 1
        return out


def detector_pair(normal: list[tuple[int, str]], strict: list[tuple[int, str]] | None = None):
    """A factory that hands out the scripted detectors in order: normal first, strict second."""
    made = [FakeDetector(normal), FakeDetector(strict if strict is not None else normal)]

    def factory(**_: Any) -> FakeDetector:
        return made.pop(0)

    return factory


def seconds(n: float) -> int:
    return int(n * 16000)


class FakeStream:
    def __init__(self, owner: "FakeRecognizer") -> None:
        self.owner = owner
        self.samples = 0

    def accept(self, samples: np.ndarray) -> None:
        if self.owner.fail_on_accept:
            raise RuntimeError("asr exploded")
        self.samples += samples.size

    def partial(self) -> str:
        words = self.owner.text.split()
        n = min(len(words), self.samples // 3200)
        return " ".join(words[:n])

    def finish(self) -> Transcript:
        if self.owner.fail_on_finish:
            raise RuntimeError("asr finish exploded")
        t = self.owner.text
        return Transcript(t, self.owner.confidence if t else 0.0, self.owner.weakest if t else 0.0)


@dataclass
class FakeRecognizer:
    text: str = "I would like to change my flight"
    confidence: float = 0.9
    weakest: float = 0.6
    fail_on_accept: bool = False
    fail_on_finish: bool = False
    sample_rate: int = 16000
    name: str = "fake-asr"
    streams: list[FakeStream] = field(default_factory=list)

    def create_stream(self) -> FakeStream:
        s = FakeStream(self)
        self.streams.append(s)
        return s

    def warm_up(self) -> float:
        return 0.0


@dataclass
class FakeSynth:
    """Produces `chunk_ms` of low-level tone per `words_per_chunk` words, taking `gen_delay` each."""

    sample_rate: int = 16000
    name: str = "fake-tts"
    chunk_ms: int = 400
    words_per_chunk: int = 3
    gen_delay: float = 0.0
    fail_on: str | None = None
    phrases: list[str] = field(default_factory=list)
    cancelled_midway: int = 0

    def synthesize(self, text: str, sink, cancel: threading.Event) -> bool:
        self.phrases.append(text)
        if self.fail_on and self.fail_on in text:
            raise RuntimeError("tts exploded")
        words = text.split()
        for i in range(0, max(1, len(words)), self.words_per_chunk):
            if cancel.is_set():
                self.cancelled_midway += 1
                return False
            if self.gen_delay:
                time.sleep(self.gen_delay)
            n = int(self.sample_rate * self.chunk_ms / 1000)
            tone = (0.1 * np.sin(2 * np.pi * 220 * np.arange(n) / self.sample_rate)).astype(np.float32)
            if not sink(tone):
                self.cancelled_midway += 1
                return False
        return True

    def warm_up(self) -> float:
        return 0.0


class FakeAgent:
    """Scripted runtime. Each call consumes the next script; records how each stream ended."""

    def __init__(self) -> None:
        self.scripts: list[list[dict[str, Any] | float]] = []
        self.calls: list[dict[str, Any]] = []
        self.closed_early: list[bool] = []
        self.finished: list[bool] = []

    def script(self, *events: dict[str, Any] | float) -> None:
        """Dicts are events; numbers are seconds to wait."""
        self.scripts.append(list(events))

    async def stream_turn(self, *, client_id, conversation_id, message, low_confidence) -> AsyncIterator[dict[str, Any]]:
        self.calls.append(
            {"client_id": client_id, "conversation_id": conversation_id, "message": message, "low_confidence": low_confidence}
        )
        script = self.scripts.pop(0) if self.scripts else [{"type": "agent.text.delta", "text": "Okay."}]
        index = len(self.calls) - 1
        self.closed_early.append(False)
        self.finished.append(False)
        try:
            yield {"type": "turn.started", "conversationId": "11111111-1111-1111-1111-111111111111"}
            yield {"type": "agent.thinking"}
            for item in script:
                if isinstance(item, (int, float)):
                    await asyncio.sleep(item)
                else:
                    yield item
            yield {"type": "turn.completed", "conversationId": "11111111-1111-1111-1111-111111111111"}
            self.finished[index] = True
        except (asyncio.CancelledError, GeneratorExit):
            self.closed_early[index] = True
            raise


def text(*chunks: str) -> list[dict[str, Any]]:
    return [{"type": "agent.text.delta", "text": c} for c in chunks]
