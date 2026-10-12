"""All settings in one place, read from environment variables (see .env.example). No secrets here."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODELS_DIR = Path(os.environ.get("VOICE_MODELS_DIR", ROOT / "models"))


def _f(name: str, default: float) -> float:
    return float(os.environ.get(name, default))


def _i(name: str, default: int) -> int:
    return int(os.environ.get(name, default))


@dataclass(frozen=True)
class Settings:
    host: str = field(default_factory=lambda: os.environ.get("VOICE_HOST", "127.0.0.1"))
    port: int = field(default_factory=lambda: _i("VOICE_PORT", 8765))
    # Shared with the TypeScript backend, which signs the short-lived session tokens.
    gateway_secret: str = field(default_factory=lambda: os.environ.get("VOICE_GATEWAY_SECRET", ""))
    agent_runtime_url: str = field(
        default_factory=lambda: os.environ.get("AGENT_RUNTIME_URL", "http://127.0.0.1:4000")
    )
    allowed_origins: tuple[str, ...] = field(
        default_factory=lambda: tuple(
            o.strip()
            for o in os.environ.get("VOICE_ALLOWED_ORIGINS", "http://localhost:5173").split(",")
            if o.strip()
        )
    )

    # Models
    asr_model: str = field(default_factory=lambda: os.environ.get("VOICE_ASR_MODEL", "zipformer-large"))
    asr_threads: int = field(default_factory=lambda: _i("VOICE_ASR_THREADS", 2))
    tts_model: str = field(default_factory=lambda: os.environ.get("VOICE_TTS_MODEL", "piper-amy-low"))
    tts_threads: int = field(default_factory=lambda: _i("VOICE_TTS_THREADS", 2))
    tts_speed: float = field(default_factory=lambda: _f("VOICE_TTS_SPEED", 1.0))

    # Turn taking. Times are milliseconds, probabilities are Silero VAD scores (0-1).
    vad_threshold: float = field(default_factory=lambda: _f("VOICE_VAD_THRESHOLD", 0.5))
    min_speech_ms: int = field(default_factory=lambda: _i("VOICE_MIN_SPEECH_MS", 100))
    end_silence_ms: int = field(default_factory=lambda: _i("VOICE_END_SILENCE_MS", 600))
    # While the agent talks, only clearly louder or clearer speech counts as an interruption.
    barge_in_threshold: float = field(default_factory=lambda: _f("VOICE_BARGE_IN_THRESHOLD", 0.7))
    barge_in_min_ms: int = field(default_factory=lambda: _i("VOICE_BARGE_IN_MIN_MS", 160))
    pre_roll_ms: int = field(default_factory=lambda: _i("VOICE_PRE_ROLL_MS", 300))

    # Limits (all enforced, see sessions/manager.py)
    max_turn_audio_s: float = field(default_factory=lambda: _f("VOICE_MAX_TURN_AUDIO_S", 30))
    max_session_s: float = field(default_factory=lambda: _f("VOICE_MAX_SESSION_S", 900))
    idle_timeout_s: float = field(default_factory=lambda: _f("VOICE_IDLE_TIMEOUT_S", 120))
    max_frame_bytes: int = field(default_factory=lambda: _i("VOICE_MAX_FRAME_BYTES", 16_384))
    max_control_bytes: int = field(default_factory=lambda: _i("VOICE_MAX_CONTROL_BYTES", 4_096))
    max_frames_per_second: int = field(default_factory=lambda: _i("VOICE_MAX_FPS", 100))
    max_sessions: int = field(default_factory=lambda: _i("VOICE_MAX_SESSIONS", 6))
    max_sessions_per_ip: int = field(default_factory=lambda: _i("VOICE_MAX_SESSIONS_PER_IP", 3))
    outbound_queue_chunks: int = field(default_factory=lambda: _i("VOICE_OUTBOUND_QUEUE", 48))
    token_max_age_s: float = field(default_factory=lambda: _f("VOICE_TOKEN_MAX_AGE_S", 90))


def load_settings() -> Settings:
    return Settings()
