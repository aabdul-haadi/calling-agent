"""Real models, real WebSocket server, scripted agent runtime. Marked `models`: needs
`python -m app.tools.download_models` first."""

from __future__ import annotations

import asyncio
import json
import socket
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

import httpx
import numpy as np
import pytest
import uvicorn
import websockets

from app.audio.framing import OutputFrame, pack_input, parse_output
from app.audio.resampling import float_to_pcm16
from app.auth import sign
from app.config import MODELS_DIR, Settings
from app.main import create_app
from app.sessions.manager import Engine
from app.tts.streaming import SherpaTts
from tests.fakes import FakeAgent

SECRET = "integration-test-secret"
ORIGIN = "http://localhost:5173"


def pytest_collection_modifyitems(items):
    needed = [MODELS_DIR / "silero_vad.onnx", MODELS_DIR / "vits-piper-en_US-amy-medium" / "tokens.txt"]
    if all(p.exists() for p in needed):
        return
    skip = pytest.mark.skip(reason="speech models not downloaded (python -m app.tools.download_models)")
    for item in items:
        if "integration" in str(item.fspath):
            item.add_marker(skip)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@dataclass
class Gateway:
    port: int
    engine: Engine
    agent: FakeAgent
    settings: Settings

    @property
    def ws_url(self) -> str:
        return f"ws://127.0.0.1:{self.port}/ws"

    @property
    def http(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def token(self, **over: Any) -> str:
        now = time.time()
        payload = {"v": 1, "cid": "skylink-air", "iat": now, "exp": now + 60, "jti": uuid.uuid4().hex}
        payload.update(over)
        return sign(SECRET, payload)


@pytest.fixture(scope="session")
def tts() -> SherpaTts:
    return SherpaTts()


@pytest.fixture(scope="session")
def speech(tts):
    """speech('some words') -> float32 16 kHz audio of a synthetic voice saying it (cached)."""
    cache: dict[str, np.ndarray] = {}

    def make(words: str) -> np.ndarray:
        if words not in cache:
            chunks: list[np.ndarray] = []
            tts.synthesize(words, lambda s: chunks.append(s) or True, threading.Event())
            cache[words] = np.concatenate(chunks).astype(np.float32)
        return cache[words]

    return make


@pytest.fixture(scope="module")
def gateway():
    settings = Settings(
        gateway_secret=SECRET,
        allowed_origins=(ORIGIN,),
        max_sessions=4,
        max_sessions_per_ip=4,
        idle_timeout_s=30,
        max_frames_per_second=80,
    )
    agent = FakeAgent()
    engine = Engine(settings, agent=agent)
    app = create_app(settings, engine)
    port = free_port()
    server = uvicorn.Server(
        uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", ws_max_size=settings.max_frame_bytes + 64)
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 90
    while time.time() < deadline:
        try:
            if httpx.get(f"http://127.0.0.1:{port}/health", timeout=1).json().get("ready"):
                break
        except httpx.HTTPError:
            pass
        time.sleep(0.25)
    else:
        server.should_exit = True
        pytest.fail(f"gateway did not become ready: {engine.load_error}")
    yield Gateway(port, engine, agent, settings)
    server.should_exit = True
    thread.join(timeout=10)


@dataclass
class Client:
    ws: Any
    events: list[tuple[float, dict[str, Any]]] = field(default_factory=list)
    frames: list[tuple[float, OutputFrame]] = field(default_factory=list)
    closed: asyncio.Event = field(default_factory=asyncio.Event)
    close_code: int | None = None
    _pump_task: asyncio.Task | None = None

    @classmethod
    async def connect(cls, gw: Gateway, token: str | None = None, sample_rate: int = 16000, start: bool = True, origin: str | None = ORIGIN, **extra: Any) -> "Client":
        headers = {"Origin": origin} if origin else {}
        ws = await websockets.connect(gw.ws_url, additional_headers=headers, max_size=None)
        c = cls(ws)
        c._pump_task = asyncio.create_task(c._pump())
        if start:
            await c.send_json({"type": "session.start", "protocol": 1, "token": token or gw.token(), "sampleRate": sample_rate, **extra})
        return c

    async def _pump(self) -> None:
        try:
            async for msg in self.ws:
                now = time.perf_counter()
                if isinstance(msg, bytes):
                    self.frames.append((now, parse_output(msg)))
                else:
                    self.events.append((now, json.loads(msg)))
        except websockets.ConnectionClosed as exc:
            self.close_code = exc.rcvd.code if exc.rcvd else None
        finally:
            self.closed.set()

    async def send_json(self, obj: dict[str, Any]) -> None:
        await self.ws.send(json.dumps(obj))

    async def send_audio(self, samples: np.ndarray, frame_ms: int = 20, real_time: bool = True) -> float:
        """Send audio the way the browser does: one frame per frame_ms, in real time.
        Returns perf_counter() at the moment the first frame was sent."""
        n = int(16000 * frame_ms / 1000)
        t0 = time.perf_counter()
        for i, off in enumerate(range(0, samples.size, n)):
            chunk = samples[off : off + n]
            if chunk.size < n:
                chunk = np.pad(chunk, (0, n - chunk.size))
            await self.ws.send(pack_input(float_to_pcm16(chunk)))
            if real_time:
                delay = t0 + (i + 1) * frame_ms / 1000 - time.perf_counter()
                if delay > 0:
                    await asyncio.sleep(delay)
        return t0

    async def silence(self, seconds: float) -> None:
        await self.send_audio(np.zeros(int(16000 * seconds), dtype=np.float32))

    def types(self) -> list[str]:
        return [e["type"] for _, e in self.events]

    def of(self, type_: str) -> list[dict[str, Any]]:
        return [e for _, e in self.events if e["type"] == type_]

    def when(self, type_: str, nth: int = 0) -> float | None:
        hits = [t for t, e in self.events if e["type"] == type_]
        return hits[nth] if len(hits) > nth else None

    async def wait_for(self, type_: str, timeout: float = 20, nth: int = 0) -> dict[str, Any]:
        end = time.perf_counter() + timeout
        while time.perf_counter() < end:
            hits = self.of(type_)
            if len(hits) > nth:
                return hits[nth]
            await asyncio.sleep(0.01)
        raise AssertionError(f"timed out waiting for {type_} (#{nth}); got {self.types()}")

    async def close(self) -> None:
        try:
            await self.ws.close()
        except Exception:  # noqa: BLE001
            pass
        if self._pump_task:
            await asyncio.gather(self._pump_task, return_exceptions=True)


def onset_seconds(samples: np.ndarray, fraction: float = 0.04) -> float:
    """When the voice actually starts in a clip (first sample above a fraction of the peak)."""
    loud = np.flatnonzero(np.abs(samples) > fraction * np.max(np.abs(samples)))
    return float(loud[0]) / 16000 if loud.size else 0.0
