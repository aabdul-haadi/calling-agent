import numpy as np
import pytest

from app.audio.framing import (
    INPUT_HEADER_BYTES,
    OUTPUT_HEADER_BYTES,
    FrameError,
    pack_input,
    pack_output,
    parse_input,
    parse_output,
)
from app.protocols.schemas import MessageError, SessionStart, parse_client_message


def test_headers_are_multiples_of_four_bytes():
    assert INPUT_HEADER_BYTES % 4 == 0 and OUTPUT_HEADER_BYTES % 4 == 0


def test_input_frame_round_trip():
    pcm = np.arange(320, dtype="<i2").tobytes()
    assert bytes(parse_input(pack_input(pcm))) == pcm


@pytest.mark.parametrize(
    "frame",
    [b"", b"\x01\x00", b"\x09\x00\x00\x00ab", b"\x01\x01\x00\x00ab", b"\x01\x00\x00\x00", b"\x01\x00\x00\x00abc"],
)
def test_malformed_input_frames_are_refused(frame):
    with pytest.raises(FrameError):
        parse_input(frame)


def test_output_frame_round_trip():
    pcm = b"\x01\x02" * 100
    f = parse_output(pack_output(turn=7, chunk=3, sample_rate=16000, pcm=pcm, last=True))
    assert (f.turn, f.chunk, f.sample_rate, f.last, bytes(f.pcm)) == (7, 3, 16000, True, pcm)
    assert parse_output(pack_output(1, 0, 22050, pcm)).last is False


def test_client_messages_are_strictly_validated():
    ok = parse_client_message(
        '{"type":"session.start","protocol":1,"token":"0123456789abc","sampleRate":48000}'
    )
    assert isinstance(ok, SessionStart) and ok.sampleRate == 48000
    for bad in (
        '{"type":"session.start","protocol":2,"token":"0123456789abc"}',
        '{"type":"session.start","protocol":1,"token":"short"}',
        '{"type":"session.start","protocol":1,"token":"0123456789abc","extra":1}',
        '{"type":"session.start","protocol":1,"token":"0123456789abc","sampleRate":12345}',
        '{"type":"playback.stopped","turn":-1}',
        '{"type":"nope"}',
        "not json",
    ):
        with pytest.raises(MessageError):
            parse_client_message(bad)
