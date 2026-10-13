"""Event names and builders for the voice WebSocket protocol (version 1).

Every server event is a JSON object with: `type`, `session`, `seq` (strictly increasing within the
session, assigned at send time so ordering is real), `t` (milliseconds since the session started)
and, where it applies, `turn` (the user turn the event belongs to). Nothing here carries model
reasoning or tool arguments: tool events name the tool and its outcome only.
"""

from __future__ import annotations

from typing import Any

PROTOCOL_VERSION = 1

# --- server -> client -----------------------------------------------------------------------
SESSION_STARTED = "session.started"
SESSION_CONVERSATION = "session.conversation"
SPEECH_STARTED = "speech.started"
TRANSCRIPT_PARTIAL = "transcript.partial"
TRANSCRIPT_FINAL = "transcript.final"
TURN_DISCARDED = "turn.discarded"
AGENT_THINKING = "agent.thinking"
AGENT_TEXT_DELTA = "agent.text.delta"
AGENT_SPEAKING = "agent.speaking"
AGENT_SPEECH_COMPLETED = "agent.speech.completed"
AGENT_INTERRUPTED = "agent.interrupted"
KNOWLEDGE_SEARCHING = "knowledge.searching"
KNOWLEDGE_USED = "knowledge.used"
TOOL_STARTED = "tool.started"
TOOL_COMPLETED = "tool.completed"
APPROVAL_REQUIRED = "approval.required"
HANDOFF_STARTED = "handoff.started"
TURN_METRICS = "turn.metrics"
TURN_COMPLETED = "turn.completed"
SESSION_ERROR = "session.error"
SESSION_CLOSED = "session.closed"

SERVER_EVENTS = frozenset(
    {
        SESSION_STARTED, SESSION_CONVERSATION, SPEECH_STARTED, TRANSCRIPT_PARTIAL, TRANSCRIPT_FINAL,
        TURN_DISCARDED, AGENT_THINKING, AGENT_TEXT_DELTA, AGENT_SPEAKING, AGENT_SPEECH_COMPLETED,
        AGENT_INTERRUPTED, KNOWLEDGE_SEARCHING, KNOWLEDGE_USED, TOOL_STARTED, TOOL_COMPLETED, APPROVAL_REQUIRED,
        HANDOFF_STARTED, TURN_METRICS, TURN_COMPLETED, SESSION_ERROR, SESSION_CLOSED,
    }
)

# --- client -> server (JSON; audio frames are binary, see audio/framing.py) -------------------
C_SESSION_START = "session.start"
C_INTERRUPT = "control.interrupt"
C_PLAYBACK_STARTED = "playback.started"
C_PLAYBACK_STOPPED = "playback.stopped"
C_PLAYBACK_ENDED = "playback.ended"
C_SESSION_END = "session.end"

# --- error codes (session.error `code`) -------------------------------------------------------
E_BAD_FRAME = "bad_frame"
E_BAD_MESSAGE = "bad_message"
E_UNAUTHORIZED = "unauthorized"
E_RATE_LIMIT = "rate_limited"
E_OVERLOADED = "overloaded"
E_TOO_LONG = "turn_too_long"
E_TIMEOUT = "timeout"
E_ASR_FAILED = "asr_failed"
E_TTS_FAILED = "tts_failed"
E_AGENT_FAILED = "agent_unavailable"
E_UNAVAILABLE = "service_unavailable"

# --- reasons ----------------------------------------------------------------------------------
R_BARGE_IN = "barge_in"
R_CLIENT = "client_request"
R_NEW_TURN = "new_turn"


def event(type_: str, session: str, seq: int, t_ms: float, turn: int | None = None, **fields: Any) -> dict[str, Any]:
    out: dict[str, Any] = {"type": type_, "session": session, "seq": seq, "t": round(t_ms)}
    if turn is not None:
        out["turn"] = turn
    out.update(fields)
    return out
