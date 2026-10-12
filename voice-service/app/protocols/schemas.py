"""Strict schemas for what the client may send. Anything else is rejected with session.error.

Every field is bounded: a hostile or buggy client cannot make the service allocate without limit.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, TypeAdapter


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SessionStart(_Strict):
    type: Literal["session.start"]
    protocol: Literal[1]
    token: str = Field(min_length=10, max_length=2048)
    # Rate of the audio the client will send. 16 kHz is native; others are resampled.
    sampleRate: Literal[8000, 16000, 22050, 24000, 32000, 44100, 48000] = 16000
    # Existing conversation to continue (must match the one inside the signed token, if any).
    conversationId: str | None = Field(default=None, pattern=r"^[0-9a-fA-F-]{36}$")


class Interrupt(_Strict):
    type: Literal["control.interrupt"]


class PlaybackStarted(_Strict):
    type: Literal["playback.started"]
    turn: int = Field(ge=0, le=2**31)


class PlaybackStopped(_Strict):
    type: Literal["playback.stopped"]
    turn: int = Field(ge=0, le=2**31)
    # How long the browser took to silence output after the interrupt event, in milliseconds.
    stopMs: float | None = Field(default=None, ge=0, le=60_000)


class PlaybackEnded(_Strict):
    type: Literal["playback.ended"]
    turn: int = Field(ge=0, le=2**31)


class SessionEnd(_Strict):
    type: Literal["session.end"]


ClientMessage = (
    SessionStart | Interrupt | PlaybackStarted | PlaybackStopped | PlaybackEnded | SessionEnd
)
_adapter: TypeAdapter[ClientMessage] = TypeAdapter(ClientMessage)  # type: ignore[arg-type]


class MessageError(ValueError):
    pass


def parse_client_message(text: str) -> ClientMessage:
    try:
        return _adapter.validate_json(text)
    except ValidationError as exc:
        first = exc.errors()[0]
        where = ".".join(str(p) for p in first["loc"]) or "message"
        raise MessageError(f"{where}: {first['msg']}") from None
