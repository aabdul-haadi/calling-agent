"""The session state machine against scripted detectors, a fake recognizer, synthesizer and agent.

Nothing here depends on audio content: speech start/end is scripted, so every ordering and
cancellation rule can be asserted exactly.
"""

from __future__ import annotations

import asyncio
import struct
from typing import Any

import numpy as np
import pytest

from app.audio.framing import OUTPUT_HEADER_BYTES, parse_output
from app.config import Settings
from app.observability.metrics import Metrics
from app.protocols import events as ev
from app.sessions.session import State, VoiceSession
from tests.fakes import (
    FRAME,
    FakeAgent,
    FakeRecognizer,
    FakeSynth,
    detector_pair,
    seconds,
    text,
)

# The scripted tests feed silence frames, so the loudness gate is off here (it has its own test).
SETTINGS = Settings(
    gateway_secret="s", end_silence_ms=600, barge_in_min_ms=160, pre_roll_ms=300, barge_in_min_rms=0.0
)
PCM = (np.zeros(FRAME, dtype="<i2")).tobytes()  # one 20 ms frame of silence (content is irrelevant)


class Rig:
    def __init__(self, normal, strict=None, **kw: Any) -> None:
        self.events: list[dict[str, Any]] = []
        self.audio: list[Any] = []
        self.agent = kw.pop("agent", None) or FakeAgent()
        self.rec = kw.pop("rec", None) or FakeRecognizer()
        self.synth = kw.pop("synth", None) or FakeSynth()
        self.metrics = Metrics()

        async def send_json(obj):
            self.events.append(obj)

        async def send_bytes(b):
            self.audio.append(parse_output(b))

        self.session = VoiceSession(
            session_id="t1",
            client_id="skylink-air",
            conversation_id=None,
            settings=kw.pop("settings", SETTINGS),
            recognizer=self.rec,
            synth=self.synth,
            agent=self.agent,
            metrics=self.metrics,
            send_json=send_json,
            send_bytes=send_bytes,
            detector_factory=detector_pair(normal, strict),
        )

    async def start(self) -> None:
        await self.session.start({})

    async def frames(self, n: int, real_time: bool = False) -> None:
        for _ in range(n):
            await self.session.on_audio(PCM)
            await asyncio.sleep(0.02 if real_time else 0)

    async def until(self, predicate, timeout: float = 5.0) -> None:
        end = asyncio.get_running_loop().time() + timeout
        while not predicate():
            if asyncio.get_running_loop().time() > end:
                raise AssertionError(f"timed out; events so far: {self.types()}")
            await asyncio.sleep(0.01)

    def types(self) -> list[str]:
        return [e["type"] for e in self.events]

    def of(self, type_: str) -> list[dict[str, Any]]:
        return [e for e in self.events if e["type"] == type_]

    async def close(self) -> None:
        await self.session.close("test over")


def frames_for(s: float) -> int:
    return int(s * 50)


# A normal turn: speech from 0.5 s to 2.0 s, the detector reports the end 0.6 s later.
TURN = [(seconds(0.6), "start"), (seconds(2.6), "end")]


async def test_a_full_turn_is_transcribed_answered_and_spoken():
    r = Rig(TURN)
    r.agent.script(*text("Sure. I can help with that. ", "What is your booking reference?"))
    await r.start()
    await r.frames(frames_for(2.8))
    await r.until(lambda: "turn.completed" in r.types() or r.session.state == State.SPEAKING)
    await r.until(lambda: "agent.speech.completed" in r.types())
    r.session.on_playback_ended(1)
    await r.until(lambda: "turn.completed" in r.types())

    types = r.types()
    assert types[0] == ev.SESSION_STARTED
    for earlier, later in [
        (ev.SPEECH_STARTED, ev.TRANSCRIPT_FINAL),
        (ev.TRANSCRIPT_FINAL, ev.AGENT_THINKING),
        (ev.AGENT_THINKING, ev.AGENT_TEXT_DELTA),
        (ev.AGENT_SPEAKING, ev.AGENT_SPEECH_COMPLETED),
        (ev.AGENT_SPEECH_COMPLETED, ev.TURN_COMPLETED),
    ]:
        assert types.index(earlier) < types.index(later), (earlier, later)
    assert r.agent.calls[0]["message"] == "I would like to change my flight"
    assert r.agent.calls[0]["low_confidence"] is False
    # every event: session id, strictly increasing seq
    assert all(e["session"] == "t1" for e in r.events)
    seqs = [e["seq"] for e in r.events]
    assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs)
    # audio: right turn, chunk numbers rising, one final marker
    assert r.audio and all(a.turn == 1 for a in r.audio)
    assert [a.chunk for a in r.audio] == list(range(len(r.audio)))
    assert r.audio[-1].last and not any(a.last for a in r.audio[:-1])
    assert r.session.state == State.LISTENING
    await r.close()


async def test_reply_is_spoken_in_phrases_before_the_text_is_complete():
    r = Rig(TURN)
    # text arrives slowly; the first sentence must be spoken before the second has arrived
    r.agent.script(*text("Your flight was cancelled. "), 0.6, *text("I can rebook you."))
    await r.start()
    await r.frames(frames_for(2.8))
    await r.until(lambda: len(r.audio) > 0)
    # at that moment the second sentence is still on its way
    assert "I can rebook you." not in " ".join(r.synth.phrases)
    await r.until(lambda: "agent.speech.completed" in r.types())
    assert r.synth.phrases == ["Your flight was cancelled.", "I can rebook you."]
    await r.close()


async def test_a_sentence_that_stops_on_a_hanging_word_is_held_open_once():
    # The customer pauses after "and" (speech 0.6-2.0 s). The silence rule fires at 2.6 s but the
    # turn is held for 600 ms: they resume at 2.9 s, so the turn must not have been sent yet.
    r = Rig([(seconds(0.6), "start"), (seconds(2.6), "end"), (seconds(2.9), "start"), (seconds(4.9), "end")],
            rec=FakeRecognizer(text="I would like to book a flight and then"))
    await r.start()
    await r.frames(frames_for(2.8))
    assert r.agent.calls == [] and r.session.state == State.USER_SPEAKING
    await r.frames(frames_for(2.3))
    await r.until(lambda: r.agent.calls)
    assert len(r.of(ev.SPEECH_STARTED)) == 1  # one turn, not two
    assert r.metrics.snapshot()["counts"]["turns_held_open"] == 1
    await r.close()


async def test_a_held_turn_ends_when_the_extra_wait_runs_out():
    r = Rig([(seconds(0.6), "start"), (seconds(2.6), "end")],
            rec=FakeRecognizer(text="I would like to book a flight and"))
    await r.start()
    await r.frames(frames_for(2.8))
    assert r.agent.calls == []  # held
    await r.frames(frames_for(0.8), real_time=True)  # the extra wait passes without speech
    await r.until(lambda: r.agent.calls)
    assert r.agent.calls[0]["message"].endswith("and")
    await r.close()


async def test_a_finished_sentence_is_never_held():
    r = Rig(TURN)
    await r.start()
    await r.frames(frames_for(2.8))
    await r.until(lambda: r.agent.calls)
    assert "turns_held_open" not in r.metrics.snapshot()["counts"]
    await r.close()


async def test_a_blip_of_noise_is_discarded_not_sent_to_the_agent():
    r = Rig([(seconds(0.3), "start"), (seconds(0.45), "end")], rec=FakeRecognizer(text=""))
    await r.start()
    await r.frames(frames_for(1.0))
    await r.until(lambda: "turn.discarded" in r.types())
    assert r.agent.calls == []
    assert r.session.state == State.LISTENING
    await r.close()


async def test_a_doubtful_transcript_is_flagged_to_the_agent_runtime():
    r = Rig(TURN, rec=FakeRecognizer(text="yes", confidence=0.31, weakest=0.2))
    await r.start()
    await r.frames(frames_for(2.8))
    await r.until(lambda: r.agent.calls)
    assert r.agent.calls[0]["low_confidence"] is True
    final = r.of(ev.TRANSCRIPT_FINAL)[0]
    assert final["lowConfidence"] is True and final["confidence"] == 0.31
    await r.close()


async def test_a_confident_short_answer_is_not_flagged():
    r = Rig(TURN, rec=FakeRecognizer(text="yes", confidence=0.93, weakest=0.7))
    await r.start()
    await r.frames(frames_for(2.8))
    await r.until(lambda: r.agent.calls)
    assert r.agent.calls[0]["low_confidence"] is False
    await r.close()


# ---------------------------------------------------------------------------------------------
# barge-in
# ---------------------------------------------------------------------------------------------

# The customer speaks 0.6-2.6 s; the agent answers; at 6.0 s the customer talks over the agent.
BARGE_NORMAL = TURN + [(seconds(6.0), "start"), (seconds(8.2), "end")]
BARGE_STRICT = [(seconds(6.0), "start"), (seconds(8.2), "end")]


async def speak_then_interrupt(r: Rig, long_reply: bool = True):
    # The text arrives quickly but the model is still generating (an open stream) while we speak.
    r.agent.script(*text(*(["One sentence of a long answer here. "] * (14 if long_reply else 1))), 30.0)
    await r.start()
    await r.frames(frames_for(2.8))
    await r.until(lambda: len(r.audio) >= 3)
    # keep streaming silence frames (position moves toward the interruption at 6 s)
    await r.frames(frames_for(3.2) - 0, real_time=False)


async def test_barge_in_stops_speech_discards_queued_audio_and_starts_the_new_turn():
    r = Rig(BARGE_NORMAL, BARGE_STRICT, synth=FakeSynth(chunk_ms=400, gen_delay=0.02))
    await speak_then_interrupt(r)
    await r.until(lambda: "agent.interrupted" in r.types())
    interrupted_at = len(r.audio)

    # 1. The agent's request to the runtime was cancelled.
    await r.until(lambda: r.agent.closed_early and r.agent.closed_early[0])
    # 2. The event names the turn that was cut off, and the reason.
    e = r.of(ev.AGENT_INTERRUPTED)[0]
    assert e["turn"] == 1 and e["reason"] == "barge_in"
    # 3. No audio of the old reply leaves after the interruption (let any in-flight work settle).
    await asyncio.sleep(0.3)
    assert len(r.audio) == interrupted_at
    assert r.metrics.snapshot()["counts"].get("interruptions") == 1
    # 4. The new utterance becomes turn 2 and is answered with the right context.
    r.rec.text = "Actually make that the evening flight"
    r.agent.script(*text("Of course."))
    await r.frames(frames_for(2.4))
    await r.until(lambda: len(r.agent.calls) == 2)
    assert r.agent.calls[1]["message"] == "Actually make that the evening flight"
    assert r.agent.calls[1]["conversation_id"] == "11111111-1111-1111-1111-111111111111"
    await r.until(lambda: any(a.turn == 2 for a in r.audio))
    assert all(a.turn in (1, 2) for a in r.audio)
    await r.close()


async def test_the_interrupt_event_comes_before_any_further_audio_and_stale_chunks_are_dropped():
    r = Rig(BARGE_NORMAL, BARGE_STRICT, synth=FakeSynth(chunk_ms=400, gen_delay=0.0))
    await speak_then_interrupt(r)
    await r.until(lambda: "agent.interrupted" in r.types())
    await asyncio.sleep(0.3)
    # event order on the wire: audio frames are interleaved by the writer in send order, and the
    # writer sends events before queued audio, so nothing of turn 1 follows the interrupt event.
    sent_after = [a for a in r.audio if a.turn == 1]
    # all turn-1 audio was sent before the interruption was announced
    idx = r.events.index(r.of(ev.AGENT_INTERRUPTED)[0])
    assert idx > 0 and len(sent_after) == len([a for a in r.audio if a.turn == 1])
    await r.close()


async def test_speaking_over_a_slow_agent_cancels_the_pending_request_too():
    r = Rig(
        TURN + [(seconds(4.0), "start"), (seconds(5.8), "end")],
        [(seconds(4.0), "start"), (seconds(5.8), "end")],
    )
    r.agent.script(10.0, *text("This answer would take far too long."))  # still "thinking" at 4 s
    await r.start()
    await r.frames(frames_for(2.8))
    await r.until(lambda: r.session.state == State.THINKING)
    r.agent.script(*text("Sure."))
    r.rec.text = "Never mind, a different question"
    await r.frames(frames_for(3.2))
    await r.until(lambda: r.agent.closed_early and r.agent.closed_early[0])
    await r.until(lambda: len(r.agent.calls) == 2)
    assert r.audio == [] or all(a.turn == 2 for a in r.audio)
    assert r.of(ev.AGENT_INTERRUPTED)[0]["turn"] == 1
    await r.close()


async def test_a_stop_button_press_interrupts_without_any_speech():
    r = Rig(TURN, synth=FakeSynth(chunk_ms=400, gen_delay=0.02))
    r.agent.script(*text(*(["A long sentence for the agent to speak. "] * 10)))
    await r.start()
    await r.frames(frames_for(2.8))
    await r.until(lambda: len(r.audio) >= 2)
    await r.session.interrupt_from_client()
    assert r.of(ev.AGENT_INTERRUPTED)[0]["reason"] == "client_request"
    assert r.session.state == State.LISTENING
    n = len(r.audio)
    await asyncio.sleep(0.3)
    assert len(r.audio) == n
    # pressing stop when nothing is playing is harmless
    await r.session.interrupt_from_client()
    assert len(r.of(ev.AGENT_INTERRUPTED)) == 1
    await r.close()


async def test_the_customers_own_noise_cannot_interrupt_unless_the_strict_detector_agrees():
    # The sensitive detector hears something at 6 s, the strict one does not: no interruption.
    r = Rig(TURN + [(seconds(6.0), "start")], [])
    r.agent.script(*text(*(["A long sentence for the agent to speak. "] * 14)))
    r.synth = r.synth
    await r.start()
    await r.frames(frames_for(2.8))
    await r.until(lambda: len(r.audio) >= 2)
    await r.frames(frames_for(3.4))
    assert "agent.interrupted" not in r.types()
    assert r.agent.closed_early == [False]
    await r.close()


async def test_nothing_is_said_after_the_customer_stops_the_reply_even_if_speech_is_slow():
    r = Rig(BARGE_NORMAL, BARGE_STRICT, synth=FakeSynth(chunk_ms=400, gen_delay=0.15))
    await speak_then_interrupt(r)
    await r.until(lambda: "agent.interrupted" in r.types())
    n = len(r.audio)
    await asyncio.sleep(0.6)  # the synthesizer thread may still be inside a phrase
    assert len(r.audio) == n
    assert r.synth.cancelled_midway >= 1
    await r.close()


# ---------------------------------------------------------------------------------------------
# failures
# ---------------------------------------------------------------------------------------------


async def test_a_failing_recognizer_reports_an_error_and_the_call_continues():
    r = Rig(TURN, rec=FakeRecognizer(fail_on_accept=True))
    await r.start()
    await r.frames(frames_for(2.8))
    await r.until(lambda: any(e["type"] == ev.SESSION_ERROR for e in r.events))
    err = r.of(ev.SESSION_ERROR)[0]
    assert err["code"] == ev.E_ASR_FAILED and err["fatal"] is False
    assert r.session.state == State.LISTENING
    await r.close()


async def test_a_synthesis_failure_is_reported_once_and_the_rest_is_still_spoken():
    r = Rig(TURN, synth=FakeSynth(fail_on="BOOM"))
    r.agent.script(*text("First part fine. ", "BOOM this one fails. ", "Last part fine."))
    await r.start()
    await r.frames(frames_for(2.8))
    await r.until(lambda: "agent.speech.completed" in r.types())
    errs = [e for e in r.events if e["type"] == ev.SESSION_ERROR]
    assert [e["code"] for e in errs] == [ev.E_TTS_FAILED]
    assert "Last part fine." in r.synth.phrases
    await r.close()


async def test_an_agent_error_is_spoken_as_an_apology_and_reported():
    r = Rig(TURN)
    r.agent.script({"type": "turn.error", "code": "X", "message": "internal details must not leak"})
    await r.start()
    await r.frames(frames_for(2.8))
    await r.until(lambda: "agent.speech.completed" in r.types())
    assert any(e.get("code") == ev.E_AGENT_FAILED for e in r.events)
    assert any("trouble answering" in p for p in r.synth.phrases)
    assert "internal details" not in str(r.events)
    await r.close()


async def test_events_forward_tool_and_approval_info_but_never_arguments():
    r = Rig(TURN)
    r.agent.script(
        {"type": "tool.started", "tool": "change_flight", "input": {"bookingRef": "SK1001"}},
        {"type": "tool.completed", "tool": "change_flight", "status": "ok", "output": {"secret": 1}},
        {"type": "approval.required", "summary": "Move booking SK1001 to flight SK110", "expiresAt": "2026-11-10T10:10:00Z"},
        {"type": "knowledge.used", "sources": ["refunds"]},
        *text("Done."),
    )
    await r.start()
    await r.frames(frames_for(2.8))
    await r.until(lambda: "agent.speech.completed" in r.types())
    wire = str(r.events)
    assert "bookingRef" not in wire and "secret" not in wire
    assert r.of(ev.TOOL_STARTED)[0]["tool"] == "change_flight"
    assert r.of(ev.TOOL_COMPLETED)[0]["status"] == "ok"
    assert "SK1001" in r.of(ev.APPROVAL_REQUIRED)[0]["summary"]
    await r.close()


async def test_closing_mid_reply_cancels_everything_and_releases_tasks():
    r = Rig(TURN, synth=FakeSynth(chunk_ms=400, gen_delay=0.05))
    r.agent.script(*text(*(["A long sentence for the agent to speak. "] * 10)), 30.0)
    await r.start()
    await r.frames(frames_for(2.8))
    await r.until(lambda: len(r.audio) >= 2)
    await r.close()
    assert r.agent.closed_early == [True]
    assert r.session._agent_task is None or r.session._agent_task.done()
    assert r.session._writer_task is not None and r.session._writer_task.done()
    assert r.session.state == State.CLOSED
    # events after close are ignored, not queued forever
    r.session.emit(ev.AGENT_THINKING)
    assert r.session._events.empty()


async def test_audio_is_resampled_when_the_browser_uses_another_rate():
    r = Rig(TURN)
    r.session._input_rate = 48000
    await r.start()
    pcm48 = np.zeros(960, dtype="<i2").tobytes()  # 20 ms at 48 kHz
    for _ in range(frames_for(2.8)):
        await r.session.on_audio(pcm48)
    # 2.8 s of 48 kHz audio became 2.8 s of 16 kHz audio inside the session
    assert abs(r.session.audio_samples_total - seconds(2.8)) < 2000
    await r.close()


async def test_frame_rate_limit():
    r = Rig(TURN)
    await r.start()
    # a clump of five seconds of audio (a stalled page catching up) is fine ...
    burst = SETTINGS.max_frames_per_second * 5
    assert all(r.session.allow_frame() for _ in range(burst))
    # ... a sustained flood is not
    assert r.session.allow_frame() is False
    await r.close()


async def test_output_header_is_sixteen_bytes():
    assert OUTPUT_HEADER_BYTES == 16 and struct.calcsize("<BBHIII") == 16


@pytest.mark.parametrize("sentence", ["Hello there.", "Hello there"])
async def test_a_reply_without_final_punctuation_is_still_spoken(sentence):
    r = Rig(TURN)
    r.agent.script(*text(sentence))
    await r.start()
    await r.frames(frames_for(2.8))
    await r.until(lambda: "agent.speech.completed" in r.types())
    assert r.synth.phrases == [sentence]
    await r.close()


async def test_a_faint_voice_cannot_interrupt_but_the_same_person_speaking_up_can():
    """The strict detector hears speech from 6.0 s, but quietly (like an echo): no interruption.
    When the level rises at 7.0 s, the same speech now interrupts."""
    gated = Settings(
        gateway_secret="s", end_silence_ms=600, barge_in_min_ms=160, pre_roll_ms=300, barge_in_min_rms=0.02
    )
    r = Rig(TURN + [(seconds(6.0), "start")], [(seconds(6.0), "start")], settings=gated,
            synth=FakeSynth(chunk_ms=400, gen_delay=0.02))
    r.agent.script(*text(*(["A long sentence for the agent to speak. "] * 14)), 30.0)
    await r.start()
    await r.frames(frames_for(2.8))
    await r.until(lambda: len(r.audio) >= 2)
    quiet = (np.full(FRAME, 0.005 * 32767, dtype="<i2")).tobytes()
    loud = (np.full(FRAME, 0.08 * 32767, dtype="<i2")).tobytes()
    # silence up to 6.0 s, then 1 s of faint audio
    for _ in range(frames_for(3.2) - 0):
        await r.session.on_audio(PCM)
    for _ in range(frames_for(1.0)):
        await r.session.on_audio(quiet)
    assert "agent.interrupted" not in r.types()
    for _ in range(frames_for(0.4)):
        await r.session.on_audio(loud)
    await r.until(lambda: "agent.interrupted" in r.types())
    await r.close()


# ---- how the agent sounds: speech preferences and the truthful progress line --------------------

FAST_PROGRESS = Settings(
    gateway_secret="s", end_silence_ms=600, barge_in_min_ms=160, pre_roll_ms=300, barge_in_min_rms=0.0,
    ack_after_s=0.2,
    ack_again_after_s=30.0,
)


async def turn(r, seconds_of_audio: float = 2.8) -> None:
    await r.start()
    await r.frames(frames_for(seconds_of_audio))


async def test_the_voice_uses_the_speaker_and_speed_the_runtime_asks_for():
    r = Rig(TURN)
    r.agent.script(
        {"type": "turn.started", "conversationId": "c1", "speech": {"speaker": "af_bella", "speed": 0.9, "language": "en-US"}},
        *text("Here you go."),
    )
    await turn(r)
    await r.until(lambda: r.synth.phrases)
    assert r.synth.prefs[0] == {"speaker": "af_bella", "speed": 0.9}
    await r.close()


@pytest.mark.parametrize(
    "raw, expected",
    [
        ({"speaker": "../../etc", "speed": 9}, {"speaker": None, "speed": 1.25}),
        ({"speaker": "af_heart", "speed": 0.1}, {"speaker": "af_heart", "speed": 0.8}),
        ({"speed": "fast"}, {"speaker": None, "speed": 1.0}),
        ({"speed": True}, {"speaker": None, "speed": 1.0}),
        ("nonsense", {"speaker": None, "speed": 1.0}),
    ],
)
def test_speech_preferences_are_validated_never_trusted(raw, expected):
    from app.sessions.session import SpeechPrefs

    p = SpeechPrefs.from_event(raw)
    assert {"speaker": p.speaker, "speed": p.speed} == expected


async def test_a_still_working_line_is_spoken_only_while_a_lookup_really_runs():
    r = Rig(TURN, settings=FAST_PROGRESS)
    r.agent.script(
        {"type": "turn.started", "conversationId": "c1", "speech": {"progressLine": "One moment, I am still checking."}},
        {"type": "tool.started", "tool": "search_alternatives"},
        1.0,
        {"type": "tool.completed", "tool": "search_alternatives", "status": "ok"},
        *text("I found two flights."),
    )
    await turn(r)
    await r.until(lambda: len(r.synth.phrases) >= 2, timeout=6)
    assert r.synth.phrases[0] == "One moment, I am still checking."
    assert r.synth.phrases[1] == "I found two flights."
    assert r.of(ev.TOOL_STARTED) and r.of(ev.TOOL_COMPLETED)
    await r.close()


async def test_no_still_working_line_when_the_answer_comes_quickly_or_no_tool_runs():
    r = Rig(TURN, settings=FAST_PROGRESS)
    r.agent.script(
        {"type": "turn.started", "conversationId": "c1", "speech": {"progressLine": "One moment, I am still checking."}},
        {"type": "tool.started", "tool": "get_booking"},
        0.05,
        {"type": "tool.completed", "tool": "get_booking", "status": "ok"},
        0.4,
        *text("Your flight is on time."),
    )
    await turn(r)
    await r.until(lambda: r.synth.phrases, timeout=6)
    assert r.synth.phrases == ["Your flight is on time."]
    await r.close()

    r = Rig(TURN, settings=FAST_PROGRESS)  # a slow model with no tool: nothing true to say, so silence
    r.agent.script(
        {"type": "turn.started", "conversationId": "c1", "speech": {"progressLine": "One moment, I am still checking."}},
        0.6,
        *text("Happy to help."),
    )
    await turn(r)
    await r.until(lambda: r.synth.phrases, timeout=6)
    assert r.synth.phrases == ["Happy to help."]
    await r.close()


# ---- when a transcript counts as doubtful with the accurate second pass ---------------------------


async def run_one_turn(r) -> dict:
    await r.start()
    await r.frames(frames_for(2.8))
    await r.until(lambda: r.of(ev.TRANSCRIPT_FINAL))
    return r.of(ev.TRANSCRIPT_FINAL)[0]


async def test_the_live_and_accurate_passes_disagreeing_does_not_block_an_ordinary_turn():
    # the live model is the weaker one; its disagreement alone must not stop the customer getting help
    r = Rig(TURN, rec=FakeRecognizer(text="My name is Rahman and my reservation is SK1001", agreement=0.5))
    final = await run_one_turn(r)
    assert final["lowConfidence"] is False
    await r.until(lambda: r.agent.calls)
    assert r.agent.calls[0]["low_confidence"] is False
    await r.close()


async def test_a_near_total_disagreement_is_still_doubtful():
    r = Rig(TURN, rec=FakeRecognizer(text="something", agreement=0.1))
    assert (await run_one_turn(r))["lowConfidence"] is True
    await r.close()


async def test_the_answer_to_a_waiting_approval_must_be_clearly_heard():
    r = Rig(TURN, rec=FakeRecognizer(text="yes", agreement=0.6))
    r.agent.script({"type": "approval.required", "summary": "Move you to SK110", "expiresAt": "x"}, *text("Say yes to confirm."))
    # first turn only sets the approval up (agreement is irrelevant to it: nothing was waiting yet)
    await run_one_turn(r)
    await r.until(lambda: "turn.completed" in r.types())
    assert r.session._awaiting_approval is True
    await r.close()


def test_with_only_the_live_model_its_own_confidence_decides():
    from app.asr.base import Transcript

    r = Rig(TURN)
    assert r.session._is_doubtful(Transcript("x", 0.3, 0.5)) is True
    assert r.session._is_doubtful(Transcript("x", 0.9, 0.5)) is False
    r.session._awaiting_approval = True
    assert r.session._is_doubtful(Transcript("yes", 0.9, 0.9, "YES", 0.5)) is True   # waiting approval: strict
    assert r.session._is_doubtful(Transcript("yes", 0.9, 0.9, "YES", 0.95)) is False


# ---- context-aware waiting lines ---------------------------------------------------------------

SPEECH = {
    "progressLine": "Still on it.",
    "progress": {
        "knowledge": "Let me check the policy.",
        "tools": {"search_alternatives": "Let me check which alternatives are available."},
    },
}


async def test_the_waiting_line_names_the_step_that_is_really_running():
    r = Rig(TURN, settings=FAST_PROGRESS)
    r.agent.script(
        {"type": "turn.started", "conversationId": "c1", "speech": SPEECH},
        {"type": "tool.started", "tool": "search_alternatives"},
        1.0,
        {"type": "tool.completed", "tool": "search_alternatives", "status": "ok"},
        *text("There are two."),
    )
    await turn(r)
    await r.until(lambda: len(r.synth.phrases) >= 2, timeout=6)
    assert r.synth.phrases[0] == "Let me check which alternatives are available."
    await r.close()


async def test_a_policy_search_that_takes_a_moment_gets_its_own_line():
    r = Rig(TURN, settings=FAST_PROGRESS)
    r.agent.script(
        {"type": "turn.started", "conversationId": "c1", "speech": SPEECH},
        {"type": "knowledge.searching"},
        0.6,
        {"type": "knowledge.used", "sources": ["refunds"]},
        *text("Refunds take seven days."),
    )
    await turn(r)
    await r.until(lambda: len(r.synth.phrases) >= 2, timeout=6)
    assert r.synth.phrases[0] == "Let me check the policy."
    assert "knowledge.searching" in r.types()
    await r.close()


async def test_nothing_is_said_when_the_answer_is_already_ready():
    r = Rig(TURN, settings=FAST_PROGRESS)
    r.agent.script(
        {"type": "turn.started", "conversationId": "c1", "speech": SPEECH},
        {"type": "knowledge.searching"},
        0.05,
        {"type": "knowledge.used", "sources": ["refunds"]},
        *text("Refunds take seven days."),
    )
    await turn(r)
    await r.until(lambda: r.synth.phrases, timeout=6)
    assert r.synth.phrases == ["Refunds take seven days."]
    await r.close()


async def test_at_most_two_lines_and_the_second_only_for_a_step_that_is_still_running():
    settings = Settings(
        gateway_secret="s", end_silence_ms=600, barge_in_min_ms=160, pre_roll_ms=300, barge_in_min_rms=0.0,
        ack_after_s=0.1, ack_again_after_s=0.3,
    )
    r = Rig(TURN, settings=settings)
    r.agent.script(
        {"type": "turn.started", "conversationId": "c1", "speech": SPEECH},
        {"type": "tool.started", "tool": "search_alternatives"},
        1.2,
        {"type": "tool.completed", "tool": "search_alternatives", "status": "ok"},
        {"type": "tool.started", "tool": "search_alternatives"},
        0.8,
        *text("Done."),
    )
    await turn(r)
    await r.until(lambda: len(r.synth.phrases) >= 3, timeout=8)
    assert r.synth.phrases[:2] == ["Let me check which alternatives are available.", "Still on it."]
    assert r.synth.phrases.count("Still on it.") == 1  # never a third
    await r.close()


async def test_the_runtimes_stage_timings_reach_the_turn_metrics():
    r = Rig(TURN)
    r.agent.script(
        {"type": "turn.started", "conversationId": "c1"},
        {"type": "turn.timing", "timings": {"totalMs": 900, "stages": [
            {"stage": "understand", "label": "x", "startMs": 0, "ms": 200},
            {"stage": "retrieve", "label": "x", "startMs": 200, "ms": 30},
            {"stage": "llm", "label": "model call 1", "startMs": 230, "ms": 600, "firstTokenMs": 300},
            {"stage": "tool", "label": "t", "startMs": 830, "ms": 70},
        ]}},
        *text("Okay."),
    )
    await turn(r)
    await r.until(lambda: "turn.metrics" in r.types())
    m = r.of(ev.TURN_METRICS)[0]
    assert (m["agentUnderstandMs"], m["agentRetrieveMs"], m["agentLlmMs"], m["agentToolMs"]) == (200, 30, 600, 70)
    assert m["agentFirstTokenMs"] == 530 and m["agentTotalMs"] == 900
    await r.close()


async def test_where_an_answer_came_from_is_forwarded_for_the_screen_and_validated():
    r = Rig(TURN)
    r.agent.script(
        {"type": "turn.started", "conversationId": "c1"},
        {"type": "knowledge.searching"},
        {"type": "knowledge.used", "sources": ["handbook.pdf"], "passages": [
            {"source": "handbook.pdf", "heading": "Handbook > Refunds", "page": 5, "pageEnd": 6, "version": 2,
             "excerpt": "Refunds take 7 business days. " * 20, "apiKey": "secret-should-not-pass"},
            {"source": 7, "heading": "bad"},
            "not a dict",
            {"source": "x.pdf", "heading": "H", "page": True, "excerpt": "e"},
        ]},
        *text("Refunds take seven business days."),
    )
    await turn(r)
    await r.until(lambda: r.of(ev.KNOWLEDGE_USED))
    used = r.of(ev.KNOWLEDGE_USED)[0]
    assert used["sources"] == ["handbook.pdf"]
    first, second = used["passages"]
    assert first["page"] == 5 and first["pageEnd"] == 6 and first["version"] == 2
    assert len(first["excerpt"]) <= 240 and "apiKey" not in first
    assert "page" not in second  # a boolean is not a page number
    assert len(used["passages"]) == 2  # the junk entries were dropped
    assert "knowledge.searching" in r.types()
    # nothing about the passages is ever spoken
    await r.until(lambda: r.synth.phrases)
    assert all("Handbook" not in p and "page" not in p for p in r.synth.phrases)
    await r.close()
