"""Binary frame layouts. Audio never travels as base64 JSON: each frame is a small fixed header
followed by raw PCM16 little-endian samples. The header is a multiple of 4 bytes so the browser can
view the payload as an Int16Array without copying.

Client -> server (4-byte header):
    u8  type      0x01 = audio.input
    u8  flags     reserved, must be 0
    u16 reserved  must be 0
    ... mono PCM16LE at the session's declared input sample rate

Server -> client (16-byte header):
    u8  type         0x02 = agent.audio.chunk
    u8  flags        bit 0 = last chunk of this reply
    u16 reserved
    u32 turn         the user turn this reply answers (stale turns are dropped by the client)
    u32 chunk        0-based index within the reply
    u32 sample_rate  output sample rate in Hz
    ... mono PCM16LE
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

TYPE_AUDIO_INPUT = 0x01
TYPE_AGENT_AUDIO = 0x02
FLAG_LAST = 0x01

_IN = struct.Struct("<BBH")
_OUT = struct.Struct("<BBHIII")
INPUT_HEADER_BYTES = _IN.size  # 4
OUTPUT_HEADER_BYTES = _OUT.size  # 16


class FrameError(ValueError):
    """The frame is malformed. The session answers with session.error instead of crashing."""


def pack_input(pcm: bytes) -> bytes:
    return _IN.pack(TYPE_AUDIO_INPUT, 0, 0) + pcm


def parse_input(frame: bytes | memoryview) -> memoryview:
    """Return the PCM payload of a client audio frame, or raise FrameError."""
    view = memoryview(frame)
    if len(view) < INPUT_HEADER_BYTES:
        raise FrameError("frame shorter than its header")
    kind, flags, reserved = _IN.unpack_from(view)
    if kind != TYPE_AUDIO_INPUT:
        raise FrameError(f"unknown binary frame type {kind:#x}")
    if flags != 0 or reserved != 0:
        raise FrameError("reserved header fields must be zero")
    payload = view[INPUT_HEADER_BYTES:]
    if len(payload) == 0:
        raise FrameError("empty audio frame")
    if len(payload) % 2:
        raise FrameError("PCM16 payload must contain whole samples")
    return payload


def pack_output(turn: int, chunk: int, sample_rate: int, pcm: bytes, last: bool = False) -> bytes:
    return _OUT.pack(TYPE_AGENT_AUDIO, FLAG_LAST if last else 0, 0, turn, chunk, sample_rate) + pcm


@dataclass(frozen=True)
class OutputFrame:
    turn: int
    chunk: int
    sample_rate: int
    last: bool
    pcm: memoryview


def parse_output(frame: bytes | memoryview) -> OutputFrame:
    view = memoryview(frame)
    if len(view) < OUTPUT_HEADER_BYTES:
        raise FrameError("frame shorter than its header")
    kind, flags, _res, turn, chunk, rate = _OUT.unpack_from(view)
    if kind != TYPE_AGENT_AUDIO:
        raise FrameError(f"unknown binary frame type {kind:#x}")
    return OutputFrame(turn, chunk, rate, bool(flags & FLAG_LAST), view[OUTPUT_HEADER_BYTES:])
