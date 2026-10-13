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
    # Second, more accurate pass over each finished turn ("off" to disable).
    asr_refine: str = field(default_factory=lambda: os.environ.get("VOICE_ASR_REFINE", "parakeet-tdt-0.6b-v2"))
    asr_refine_threads: int = field(default_factory=lambda: _i("VOICE_ASR_REFINE_THREADS", 4))
    diagnostics: bool = field(default_factory=lambda: os.environ.get("VOICE_DIAGNOSTICS", "").lower() in ("1", "true", "yes"))
    pause_sentence_ms: int = field(default_factory=lambda: _i("VOICE_PAUSE_SENTENCE_MS", 160))
    pause_clause_ms: int = field(default_factory=lambda: _i("VOICE_PAUSE_CLAUSE_MS", 60))
    progress_after_s: float = field(default_factory=lambda: _f("VOICE_PROGRESS_AFTER_S", 3.0))
    asr_threads: int = field(default_factory=lambda: _i("VOICE_ASR_THREADS", 2))
    tts_model: str = field(default_factory=lambda: os.environ.get("VOICE_TTS_MODEL", "piper-amy-medium"))
    tts_threads: int = field(default_factory=lambda: _i("VOICE_TTS_THREADS", 2))
    tts_speed: float = field(default_factory=lambda: _f("VOICE_TTS_SPEED", 1.0))

    # Turn taking. Times are milliseconds, probabilities are Silero VAD scores (0-1).
    vad_threshold: float = field(default_factory=lambda: _f("VOICE_VAD_THRESHOLD", 0.5))
    min_speech_ms: int = field(default_factory=lambda: _i("VOICE_MIN_SPEECH_MS", 64))
    end_silence_ms: int = field(default_factory=lambda: _i("VOICE_END_SILENCE_MS", 600))
    # While the agent talks, only clearly louder or clearer speech counts as an interruption.
    barge_in_threshold: float = field(default_factory=lambda: _f("VOICE_BARGE_IN_THRESHOLD", 0.7))
    barge_in_min_ms: int = field(default_factory=lambda: _i("VOICE_BARGE_IN_MIN_MS", 96))
    pre_roll_ms: int = field(default_factory=lambda: _i("VOICE_PRE_ROLL_MS", 300))
    # The loudness gate averages over this window: long enough that the peaks of an echo of the
    # agent's own voice average out, short enough that a real voice passes within a moment.
    barge_in_rms_window_ms: int = field(default_factory=lambda: _i("VOICE_BARGE_IN_RMS_WINDOW_MS", 240))
    # Minimum loudness (RMS, 0-1 scale) of speech that may interrupt the agent. Real speech measured
    # about 0.05; the agent's own voice echoed 20 dB down is about 0.009. 0 disables the gate.
    barge_in_min_rms: float = field(default_factory=lambda: _f("VOICE_BARGE_IN_MIN_RMS", 0.015))
    # Extra wait before ending a turn that stops on a word like "and" or "is". 0 turns it off.
    hold_for_hanging_word_ms: int = field(default_factory=lambda: _i("VOICE_HOLD_HANGING_MS", 600))

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


# Only these names are read from the repository .env (it also holds API keys that this service has
# no business seeing). A real environment variable always wins over the file.
_SHARED_KEYS = ("VOICE_", "AGENT_RUNTIME_URL")


def load_env_file(path: Path | None = None) -> int:
    """Copy VOICE_* and AGENT_RUNTIME_URL from the repo's .env into the environment. Returns how many."""
    env_path = path or ROOT.parent / ".env"
    if not env_path.exists():
        return 0
    loaded = 0
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip("\"'")
        if key.startswith(_SHARED_KEYS) and value and key not in os.environ:
            os.environ[key] = value
            loaded += 1
    return loaded


def load_settings() -> Settings:
    load_env_file()
    return Settings()
