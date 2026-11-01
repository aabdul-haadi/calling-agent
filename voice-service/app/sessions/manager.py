"""Shared engine (models, limits) and the registry of live sessions."""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Callable

from app.asr.base import Recognizer
from app.asr.offline import OfflineRecognizer
from app.asr.refining import RefiningRecognizer
from app.asr.streaming import MissingModelError, SherpaRecognizer
from app.auth import TokenVerifier
from app.audio.vad import SpeechDetector
from app.config import Settings
from app.integrations.agent_runtime import AgentRuntime, HttpAgentRuntime
from app.observability.metrics import Metrics
from app.tts.base import Synthesizer
from app.tts.streaming import SherpaTts

log = logging.getLogger("voice.engine")


@dataclass
class Engine:
    """Everything sessions share. Models are heavy, so they load once, in the background, and the
    service reports `ready: false` on /health until they are warm."""

    settings: Settings
    metrics: Metrics = field(default_factory=Metrics)
    recognizer: Recognizer | None = None
    synth: Synthesizer | None = None
    agent: AgentRuntime | None = None
    detector_factory: Callable[..., Any] = SpeechDetector
    verifier: TokenVerifier = field(init=False)
    load_error: str | None = None
    ready: bool = False
    started_at: float = field(default_factory=time.monotonic)
    load_seconds: dict[str, float] = field(default_factory=dict)
    _active: int = 0
    _per_ip: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def __post_init__(self) -> None:
        self.verifier = TokenVerifier(self.settings.gateway_secret, self.settings.token_max_age_s)

    # ---- models ------------------------------------------------------------------------------

    def load_models(self) -> None:
        """Blocking: load and warm up whatever was not injected. Call from a worker thread."""
        try:
            s = self.settings
            if self.recognizer is None:
                self.recognizer = SherpaRecognizer(s.asr_model, s.asr_threads)
                self.load_seconds["asr_load"] = round(self.recognizer.load_seconds, 2)  # type: ignore[attr-defined]
            self._add_refiner()
            self.load_seconds["asr_warmup"] = round(self.recognizer.warm_up(), 2)
            if self.synth is None:
                try:
                    self.synth = SherpaTts(s.tts_model, s.tts_threads, s.tts_speed)
                except MissingModelError as exc:
                    if s.tts_model == "piper-amy-low":
                        raise
                    log.warning("voice %s is not installed (%s); falling back to piper-amy-low", s.tts_model, exc)
                    self.synth = SherpaTts("piper-amy-low", s.tts_threads, s.tts_speed)
                self.load_seconds["tts_load"] = round(self.synth.load_seconds, 2)  # type: ignore[attr-defined]
            self.load_seconds["tts_warmup"] = round(self.synth.warm_up(), 2)
            self.detector_factory(threshold=0.5, min_speech_ms=100, min_silence_ms=600)  # fails fast if missing
            if self.agent is None:
                self.agent = HttpAgentRuntime(
                    s.agent_runtime_url,
                    gateway_secret=s.gateway_secret,
                )
            self.ready = True
            log.info("voice models ready: %s", self.load_seconds)
        except Exception as exc:  # noqa: BLE001 - reported on /health, never crashes the process
            self.load_error = str(exc)
            log.error("model loading failed: %s", exc)

    def _add_refiner(self) -> None:
        """Wrap the streaming recognizer with the accurate final pass when its model is installed."""
        name = self.settings.asr_refine
        if name in ("", "off", "none") or isinstance(self.recognizer, RefiningRecognizer):
            return
        try:
            offline = OfflineRecognizer(name, self.settings.asr_refine_threads)
        except MissingModelError as exc:
            log.warning("accurate final pass unavailable, using streaming recognition only: %s", exc)
            return
        self.load_seconds["asr_refine_load"] = round(offline.load_seconds, 2)
        hook = None
        if self.settings.diagnostics:
            from app.observability.diagnostics import DIAG_DIR, save_capture

            log.warning("VOICE_DIAGNOSTICS is on: captures are saved in %s", DIAG_DIR)
            hook = save_capture
        self.recognizer = RefiningRecognizer(
            self.recognizer, offline, self.settings.max_turn_audio_s, hook  # type: ignore[arg-type]
        )

    async def load_models_async(self) -> None:
        await asyncio.to_thread(self.load_models)

    # ---- admission ---------------------------------------------------------------------------

    def admit(self, ip: str) -> str | None:
        """Reserve a slot for a new session, or return the reason it is refused."""
        with self._lock:
            if self._active >= self.settings.max_sessions:
                return "The voice service is busy. Please try again in a moment."
            if self._per_ip[ip] >= self.settings.max_sessions_per_ip:
                return "Too many voice sessions from this address."
            self._active += 1
            self._per_ip[ip] += 1
            return None

    def release(self, ip: str) -> None:
        with self._lock:
            self._active = max(0, self._active - 1)
            self._per_ip[ip] = max(0, self._per_ip[ip] - 1)
            if self._per_ip[ip] == 0:
                del self._per_ip[ip]

    @property
    def active_sessions(self) -> int:
        return self._active

    def limits(self) -> dict[str, Any]:
        s = self.settings
        return {
            "maxFrameBytes": s.max_frame_bytes,
            "maxTurnAudioSeconds": s.max_turn_audio_s,
            "maxSessionSeconds": s.max_session_s,
            "maxFramesPerSecond": s.max_frames_per_second,
        }

    async def aclose(self) -> None:
        agent = self.agent
        if isinstance(agent, HttpAgentRuntime):
            await agent.aclose()
