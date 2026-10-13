"""End to end through a real WebSocket with the real VAD, recognizer and voice."""

from __future__ import annotations

import asyncio
import time

import httpx
import numpy as np
import pytest
import websockets

from app.api import websocket as ws_module
from app.audio.framing import pack_input
from app.audio.resampling import float_to_pcm16
from evalab.metrics import wer
from tests.fakes import text
from tests.integration.conftest import Client, onset_seconds

pytestmark = pytest.mark.models

GREETING = "Hello, I would like to change my flight please"


# ----------------------------------------------------------------------------------------------
# connection and security
# ----------------------------------------------------------------------------------------------


async def test_a_valid_session_starts_and_announces_its_limits(gateway):
    c = await Client.connect(gateway)
    started = await c.wait_for("session.started", 5)
    assert started["protocol"] == 1 and started["inputSampleRate"] == 16000
    assert started["outputSampleRate"] == gateway.engine.synth.sample_rate
    assert started["limits"]["maxFrameBytes"] == gateway.settings.max_frame_bytes
    assert started["seq"] == 1 and started["session"]
    await c.close()


async def test_a_token_too_short_to_be_real_is_a_bad_message(gateway):
    c = await Client.connect(gateway, token="garbage")
    assert (await c.wait_for("session.error", 5))["code"] == "bad_message"
    await c.close()


@pytest.mark.parametrize(
    "bad", ["garbagegarbage", "aaaaaaaaaaaa.bbbbbbbbbbbb", "x" * 50 + "." + "0" * 64]
)
async def test_a_bad_token_is_refused_without_a_session(gateway, bad):
    c = await Client.connect(gateway, token=bad)
    err = await c.wait_for("session.error", 5)
    assert err["code"] == "unauthorized" and err["fatal"] is True
    await asyncio.wait_for(c.closed.wait(), 5)
    assert "session.started" not in c.types()
    assert gateway.engine.active_sessions == 0
    await c.close()


async def test_an_expired_or_reused_token_is_refused(gateway):
    expired = gateway.token(exp=time.time() - 5)
    c = await Client.connect(gateway, token=expired)
    assert (await c.wait_for("session.error", 5))["code"] == "unauthorized"
    await c.close()

    token = gateway.token()
    first = await Client.connect(gateway, token=token)
    await first.wait_for("session.started", 5)
    second = await Client.connect(gateway, token=token)
    assert (await second.wait_for("session.error", 5))["code"] == "unauthorized"
    await first.close()
    await second.close()


async def test_an_unknown_web_origin_is_refused(gateway):
    with pytest.raises(websockets.InvalidStatus) as err:
        await Client.connect(gateway, origin="https://evil.example")
    assert err.value.response.status_code in (403, 1008) or err.value.response.status_code >= 400


async def test_audio_before_session_start_is_refused(gateway):
    c = await Client.connect(gateway, start=False)
    await c.ws.send(pack_input(float_to_pcm16(np.zeros(320, dtype=np.float32))))
    err = await c.wait_for("session.error", 5)
    assert err["code"] == "bad_message" and err["fatal"] is True
    await c.close()


async def test_a_silent_client_that_never_starts_is_dropped(gateway, monkeypatch):
    monkeypatch.setattr(ws_module, "START_TIMEOUT_S", 0.5)
    c = await Client.connect(gateway, start=False)
    err = await c.wait_for("session.error", 5)
    assert err["code"] == "timeout"
    await c.close()


async def test_token_for_another_conversation_cannot_be_redirected(gateway):
    token = gateway.token(conv="11111111-1111-1111-1111-111111111111")
    c = await Client.connect(gateway, token=token, conversationId="22222222-2222-2222-2222-222222222222")
    assert (await c.wait_for("session.error", 5))["code"] == "unauthorized"
    await c.close()


async def test_health_and_metrics_endpoints_carry_no_customer_data(gateway):
    health = httpx.get(f"{gateway.http}/health").json()
    assert health["ready"] is True and health["asr"].startswith("sherpa-onnx/")
    metrics = httpx.get(f"{gateway.http}/metrics").json()
    assert set(metrics) >= {"activeSessions", "timings_ms", "counts"}
    assert "transcript" not in str(metrics).lower()


# ----------------------------------------------------------------------------------------------
# input limits
# ----------------------------------------------------------------------------------------------


async def test_malformed_frames_are_reported_and_the_call_survives(gateway):
    c = await Client.connect(gateway)
    await c.wait_for("session.started", 5)
    await c.ws.send(b"\x09\x00\x00\x00abcd")  # unknown frame type
    await c.ws.send(b"\x01\x00\x00\x00abc")  # odd number of bytes: not whole samples
    err = await c.wait_for("session.error", 5)
    assert err["code"] == "bad_frame" and err["fatal"] is False
    await c.ws.send(pack_input(float_to_pcm16(np.zeros(320, dtype=np.float32))))  # still works
    await asyncio.sleep(0.2)
    assert not c.closed.is_set()
    await c.close()


async def test_too_many_malformed_frames_end_the_session(gateway):
    c = await Client.connect(gateway)
    await c.wait_for("session.started", 5)
    for _ in range(25):
        await c.ws.send(b"\x09\x00")
    await asyncio.wait_for(c.closed.wait(), 5)
    await c.close()


async def test_an_oversized_frame_is_refused(gateway):
    c = await Client.connect(gateway)
    await c.wait_for("session.started", 5)
    try:
        await c.ws.send(b"\x01\x00\x00\x00" + b"\x00\x00" * 20000)  # 40 KB > limit
    except websockets.ConnectionClosed:
        pass
    await asyncio.wait_for(c.closed.wait(), 5)
    await c.close()


async def test_flooding_frames_faster_than_the_limit_ends_the_session(gateway):
    c = await Client.connect(gateway)
    await c.wait_for("session.started", 5)
    frame = pack_input(float_to_pcm16(np.zeros(320, dtype=np.float32)))
    for _ in range(gateway.settings.max_frames_per_second * 5 + 400):  # no pacing: more than the burst allowance
        try:
            await c.ws.send(frame)
        except websockets.ConnectionClosed:
            break
    await asyncio.wait_for(c.closed.wait(), 5)
    assert any(e.get("code") == "rate_limited" for e in c.of("session.error"))
    await c.close()


async def test_too_many_sessions_at_once_are_refused_politely(gateway):
    held = [await Client.connect(gateway) for _ in range(gateway.settings.max_sessions)]
    for h in held:
        await h.wait_for("session.started", 5)
    extra = await Client.connect(gateway)
    err = await extra.wait_for("session.error", 5)
    assert err["code"] == "rate_limited"
    for c in [*held, extra]:
        await c.close()
    await asyncio.sleep(0.3)
    assert gateway.engine.active_sessions == 0


async def test_a_client_that_vanishes_mid_reply_leaves_nothing_behind(gateway):
    c = await Client.connect(gateway)
    await c.wait_for("session.started", 5)
    gateway.agent.script(*text(*(["A rather long sentence that keeps the agent talking. "] * 8)), 30.0)
    await c.send_audio(_speech_of(GREETING))
    await c.silence(1.2)
    await c.wait_for("agent.speaking", 30)
    n_calls = len(gateway.agent.calls)
    c.ws.transport.abort()  # no goodbye, like a closed laptop lid
    deadline = time.time() + 5
    while gateway.engine.active_sessions and time.time() < deadline:
        await asyncio.sleep(0.05)
    assert gateway.engine.active_sessions == 0
    assert gateway.agent.closed_early[n_calls - 1] is True  # the request to the agent was cancelled
    await c.close()


# ----------------------------------------------------------------------------------------------
# a real conversation
# ----------------------------------------------------------------------------------------------

_speech_cache = {}


def _speech_of(words: str) -> np.ndarray:
    return _speech_cache[words]


@pytest.fixture(autouse=True)
def _fill_speech_cache(speech):
    for w in (GREETING, "Actually, make that the evening flight instead"):
        _speech_cache[w] = speech(w)


async def test_speech_in_text_and_speech_out(gateway):
    c = await Client.connect(gateway)
    await c.wait_for("session.started", 5)
    gateway.agent.script(*text("Of course, I can help with that. ", "What is your booking reference?"))
    audio = _speech_of(GREETING)
    await c.send_audio(audio)
    await c.silence(1.5)
    final = await c.wait_for("transcript.final", 15)
    assert wer(GREETING, final["text"]) <= 0.35, final["text"]
    assert final["lowConfidence"] is False
    await c.wait_for("turn.completed", 30)

    # the agent received what we said, on the voice channel, as a normal conversation turn
    call = gateway.agent.calls[-1]
    assert call["client_id"] == "skylink-air" and wer(GREETING, call["message"]) <= 0.35
    # speech came back as binary frames: right turn, right rate, real audio
    assert c.frames and all(f.turn == final["turn"] and f.sample_rate == gateway.engine.synth.sample_rate for _, f in c.frames)
    pcm = np.concatenate([np.frombuffer(bytes(f.pcm), dtype="<i2") for _, f in c.frames]).astype(np.float32) / 32768
    assert pcm.size > 16000 and float(np.sqrt(np.mean(pcm**2))) > 0.01
    assert c.frames[-1][1].last
    # partials arrived while the customer was still speaking
    first_partial = c.when("transcript.partial")
    assert first_partial is not None and first_partial < c.when("transcript.final")
    # order and numbering
    seqs = [e["seq"] for _, e in c.events]
    assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs)
    metrics = c.of("turn.metrics")[0]
    assert metrics["speechEndToFinalMs"] < 3000  # sanity bound; the real target is measured by evalab.turn_bench
    await c.close()


async def test_noise_without_speech_never_starts_a_turn(gateway):
    c = await Client.connect(gateway)
    await c.wait_for("session.started", 5)
    rng = np.random.default_rng(7)
    noise = (rng.standard_normal(16000 * 3) * 0.04).astype(np.float32)
    await c.send_audio(noise)
    click = np.zeros(16000, dtype=np.float32)
    click[3000:3400] = 0.6  # a short loud knock
    await c.send_audio(click)
    await asyncio.sleep(0.3)
    assert "speech.started" not in c.types()
    assert gateway.agent.calls == [] or gateway.agent.calls[-1]["message"] != ""
    await c.close()


async def test_barge_in_stops_the_agent_within_a_fraction_of_a_second(gateway):
    c = await Client.connect(gateway)
    await c.wait_for("session.started", 5)
    # a long answer, and the model is still "generating" when the customer interrupts
    gateway.agent.script(*text(*(["Here is one more sentence of a rather long explanation. "] * 12)), 30.0)
    await c.send_audio(_speech_of(GREETING))
    await c.silence(1.2)
    await c.wait_for("agent.speaking", 30)
    await asyncio.sleep(1.0)  # the agent has been talking for a moment

    interrupter = _speech_of("Actually, make that the evening flight instead")
    t_sent = await_first = None
    t0 = time.perf_counter()
    sender = asyncio.create_task(c.send_audio(interrupter))
    await c.wait_for("agent.interrupted", 5)
    t_stop = c.when("agent.interrupted")
    t_sent = t0 + onset_seconds(interrupter)
    stop_ms = (t_stop - t_sent) * 1000
    await sender
    # speech onset to the stop signal: VAD confirmation (>= 160 ms) plus transit and decision
    assert 0 < stop_ms < 900, stop_ms

    # nothing of the old reply arrives after the interruption was announced
    n = len(c.frames)
    await asyncio.sleep(0.5)
    late = [f for t, f in c.frames if t > t_stop and f.turn == 1]
    assert late == [] and len(c.frames) == n, f"{len(late)} stale frames after the interrupt"
    assert gateway.agent.closed_early[0] is True

    # and the new request is understood in the right context
    await c.silence(1.5)
    await c.wait_for("transcript.final", 15, nth=1)
    await asyncio.sleep(0.2)
    assert wer("Actually, make that the evening flight instead", gateway.agent.calls[-1]["message"]) <= 0.4
    assert gateway.agent.calls[-1]["conversation_id"] == "11111111-1111-1111-1111-111111111111"
    await c.close()


async def test_the_stop_button_works_without_any_speech(gateway):
    c = await Client.connect(gateway)
    await c.wait_for("session.started", 5)
    gateway.agent.script(*text(*(["Another long sentence for the agent to say. "] * 12)), 30.0)
    await c.send_audio(_speech_of(GREETING))
    await c.silence(1.2)
    await c.wait_for("agent.speaking", 30)
    await c.send_json({"type": "control.interrupt"})
    ev = await c.wait_for("agent.interrupted", 3)
    assert ev["reason"] == "client_request"
    await c.close()
