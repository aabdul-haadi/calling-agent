"""One live voice conversation.

What this file does: listens (VAD + streaming ASR), decides when the customer's turn is over, asks
the TypeScript agent runtime for the reply, speaks it phrase by phrase, and stops everything at once
when the customer talks over it (barge-in).

What this file never does: decide whether anything is allowed, call company systems, or change
business data. It forwards what the customer said and plays what the runtime says.

Vocabulary
  turn         a number that identifies one customer utterance and the reply to it
  generation   bumps every time a reply is cancelled; audio from an older generation is dropped
               everywhere (here before sending, in the browser on arrival)
"""

from __future__ import annotations

import asyncio
import re
import enum
import logging
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

import numpy as np

from app.asr.base import Recognizer, RecognizerStream
from app.audio.framing import pack_output
from app.audio.resampling import float_to_pcm16, pcm16_to_float, resample
from app.audio.vad import SAMPLE_RATE, VadEvent
from app.config import Settings
from app.integrations.agent_runtime import AgentRuntime
from app.observability.metrics import Metrics
from app.protocols import events as ev
from app.tts.base import Synthesizer
from app.asr.spoken import normalize_spoken_codes
from app.tts.pacing import Pacer
from app.tts.text import Chunker, speakable

log = logging.getLogger("voice.session")

# Output audio is cut into frames of this length so playback can be cancelled at fine grain.
OUT_FRAME_MS = 200
# A transcript below these is flagged to the runtime, which then refuses to treat it as approval.
# Chosen from evalab/asr_bench: below 0.6 flags ~5% of correct transcripts and catches ~70% of wrong ones.
LOW_CONFIDENCE = 0.6
LOW_WEAKEST = 0.12
MIN_TURN_SPEECH_MS = 250

# A sentence that stops on one of these words is not finished ("my booking reference is ..."): when
# the silence timer fires the turn is held open a little longer. Held at most once per turn.
HANGING = frozenset(
    "and but or so because to the a an my for with of at on in if that which then from by is was are "
    "i it we you can would could want need like".split()
)


class State(str, enum.Enum):
    LISTENING = "listening"
    USER_SPEAKING = "user_speaking"
    TRANSCRIBING = "transcribing"
    THINKING = "thinking"
    SPEAKING = "speaking"
    CLOSED = "closed"


@dataclass
class _Turn:
    id: int
    stream: RecognizerStream
    # All times are time.monotonic() seconds.
    detected_at: float
    fed_samples: int = 0
    last_partial: str = ""
    last_partial_at: float = 0.0
    first_partial_at: float | None = None
    end_deadline: float | None = None  # set while a turn is held open for a hanging word
    held: bool = False
    marks: dict[str, float] = field(default_factory=dict)
    agent_timings: dict[str, Any] | None = None  # the runtime's per-stage timings for this turn


@dataclass
class _Audio:
    turn: int
    gen: int
    data: bytes
    last: bool


SendJson = Callable[[dict[str, Any]], Awaitable[None]]
SendBytes = Callable[[bytes], Awaitable[None]]
DetectorFactory = Callable[..., Any]


def _line(value: Any) -> str | None:
    return value.strip()[:120] if isinstance(value, str) and value.strip() else None


def _tool_lines(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    out: dict[str, str] = {}
    for name, text in list(value.items())[:32]:
        if isinstance(name, str) and re.fullmatch(r"[a-z0-9_]{1,40}", name) and (line := _line(text)):
            out[name] = line
    return out


@dataclass
class SpeechPrefs:
    """How this company's agent should sound. Style only; supplied by the runtime, validated here."""

    speaker: str | None = None
    speed: float = 1.0
    progress_line: str | None = None
    progress_knowledge: str | None = None
    progress_tools: dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_event(cls, raw: Any) -> "SpeechPrefs":
        if not isinstance(raw, dict):
            return cls()
        speaker = raw.get("speaker")
        speed = raw.get("speed")
        line = raw.get("progressLine")
        progress = raw.get("progress")
        return cls(
            speaker=speaker if isinstance(speaker, str) and re.fullmatch(r"[a-z0-9_]{1,40}", speaker) else None,
            speed=min(1.25, max(0.8, float(speed))) if isinstance(speed, (int, float)) and not isinstance(speed, bool) else 1.0,
            progress_line=_line(line),
            progress_knowledge=_line(progress.get("knowledge")) if isinstance(progress, dict) else None,
            progress_tools=_tool_lines(progress.get("tools")) if isinstance(progress, dict) else {},
        )


def _agent_stage_metrics(timings: dict[str, Any] | None) -> dict[str, float]:
    """Where the runtime spent the turn, from its own stage timings (numbers only, validated)."""
    if not timings or not isinstance(timings.get("stages"), list):
        return {}
    sums: dict[str, float] = {}
    first_token: float | None = None
    for st in timings["stages"][:64]:
        if not isinstance(st, dict) or not isinstance(st.get("ms"), (int, float)):
            continue
        key = {"understand": "agentUnderstandMs", "retrieve": "agentRetrieveMs", "llm": "agentLlmMs",
               "tool": "agentToolMs"}.get(st.get("stage"))
        if key:
            sums[key] = sums.get(key, 0.0) + float(st["ms"])
        ft = st.get("firstTokenMs")
        if st.get("stage") == "llm" and isinstance(ft, (int, float)) and first_token is None:
            first_token = float(st["startMs"]) + float(ft) if isinstance(st.get("startMs"), (int, float)) else None
    if first_token is not None:
        sums["agentFirstTokenMs"] = first_token  # from the start of the turn to the first word written
    total = timings.get("totalMs")
    if isinstance(total, (int, float)):
        sums["agentTotalMs"] = float(total)
    return sums


class _Acks:
    """The short spoken lines that cover a wait: at most one when a real step is taking a moment,
    and one more only if that same step is still running much later.

    Every line is started by an event that proves the step began (a tool or a policy search), says
    only what is being done (never that it succeeded), is dropped if the answer is ready first, and
    never talks over speech that has already started.
    """

    def __init__(self, session: "VoiceSession", turn: "_Turn", gen: int, phrases: "asyncio.Queue[str | None]") -> None:
        self._s, self._turn, self._gen, self._phrases = session, turn, gen, phrases
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._said = 0

    def start(self, key: str, line: str | None) -> None:
        if not line or key in self._tasks or self._said >= 2:
            return
        self._tasks[key] = asyncio.create_task(self._run(key, line))

    def done(self, key: str) -> None:
        task = self._tasks.get(key)
        if task is not None and not task.done():
            task.cancel()

    def cancel_all(self) -> None:
        for task in self._tasks.values():
            if not task.done():
                task.cancel()

    def _quiet(self) -> bool:
        s = self._s
        return self._gen == s._gen and not s._first_audio_sent and "first_text" not in self._turn.marks

    async def _run(self, key: str, line: str) -> None:
        cfg = self._s.s
        await asyncio.sleep(cfg.ack_after_s)
        if not self._quiet() or self._said >= 2:
            return
        self._said += 1
        self._phrases.put_nowait(speakable(line))
        self._s._metrics.count("progress_updates")
        # Still going after a long time: one more short update, only for this same step.
        await asyncio.sleep(cfg.ack_again_after_s)
        fallback = self._s._speech.progress_line
        if fallback and self._said < 2 and self._gen == self._s._gen and "first_text" not in self._turn.marks:
            self._said += 1
            self._phrases.put_nowait(speakable(fallback))
            self._s._metrics.count("progress_updates")


class VoiceSession:
    def __init__(
        self,
        *,
        session_id: str,
        client_id: str,
        conversation_id: str | None,
        settings: Settings,
        recognizer: Recognizer,
        synth: Synthesizer,
        agent: AgentRuntime,
        metrics: Metrics,
        send_json: SendJson,
        send_bytes: SendBytes,
        detector_factory: DetectorFactory,
        input_rate: int = SAMPLE_RATE,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.id = session_id
        self.client_id = client_id
        self.conversation_id = conversation_id
        self.s = settings
        self._rec = recognizer
        self._synth = synth
        self._agent = agent
        self._metrics = metrics
        self._send_json = send_json
        self._send_bytes = send_bytes
        self._input_rate = input_rate
        self._speech = SpeechPrefs()
        self._awaiting_approval = False
        self._frame_tokens = float(settings.max_frames_per_second) * 5
        self._frame_tokens_at = clock()
        self._clock = clock

        # Two detectors on the same audio: a sensitive one to start a turn, a strict one to decide
        # that the customer is interrupting the agent (so the agent's own voice or a cough is not).
        self._vad = detector_factory(
            threshold=settings.vad_threshold,
            min_speech_ms=settings.min_speech_ms,
            min_silence_ms=settings.end_silence_ms,
        )
        self._barge = detector_factory(
            threshold=settings.barge_in_threshold,
            min_speech_ms=settings.barge_in_min_ms,
            min_silence_ms=settings.end_silence_ms,
        )

        self.state = State.LISTENING
        self._started = clock()
        self._seq = 0
        self._turn_counter = 0
        self._turn: _Turn | None = None
        self._reply: _Turn | None = None  # the turn whose reply is being prepared or spoken
        self._response_turn = 0
        self._gen = 0
        self._tts_cancel = threading.Event()
        self._agent_task: asyncio.Task[None] | None = None
        self._playback_ended = asyncio.Event()

        # Last stretch of audio, so the start of a sentence is not lost while the detector decides.
        self._ring: deque[np.ndarray] = deque()
        self._ring_samples = 0
        self._ring_limit = int(SAMPLE_RATE * (settings.pre_roll_ms + settings.barge_in_min_ms + 400) / 1000)

        # Outbound: events first, audio second. Audio is bounded so a slow client slows synthesis
        # instead of growing memory; events never wait behind audio.
        self._events: asyncio.Queue[tuple[str, int | None, dict[str, Any]]] = asyncio.Queue()
        self._audio: asyncio.Queue[_Audio] = asyncio.Queue(maxsize=settings.outbound_queue_chunks)
        self._wake = asyncio.Event()
        self._writer_task: asyncio.Task[None] | None = None
        self._closed = False
        self._chunk_index = 0
        self._audio_seconds_sent = 0.0
        self._first_audio_sent = False
        self._frames_this_second = 0
        self._second_started = clock()
        self.last_audio_at = clock()
        self.audio_samples_total = 0

    # ------------------------------------------------------------------------------------------
    # lifecycle
    # ------------------------------------------------------------------------------------------

    async def start(self, limits: dict[str, Any]) -> None:
        self._writer_task = asyncio.create_task(self._writer(), name=f"voice-writer-{self.id}")
        self.emit(
            ev.SESSION_STARTED,
            protocol=ev.PROTOCOL_VERSION,
            inputSampleRate=self._input_rate,
            outputSampleRate=self._synth.sample_rate,
            conversationId=self.conversation_id,
            limits=limits,
        )

    async def close(self, reason: str = "closed") -> None:
        if self._closed:
            return
        self._closed = True
        self.state = State.CLOSED
        self._gen += 1
        self._tts_cancel.set()
        task = self._agent_task
        if task and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        self.emit(ev.SESSION_CLOSED, reason=reason)
        # Let the writer flush the closing event, then stop it.
        for _ in range(20):
            if self._events.empty():
                break
            await asyncio.sleep(0.01)
        if self._writer_task:
            self._writer_task.cancel()
            await asyncio.gather(self._writer_task, return_exceptions=True)

    # ------------------------------------------------------------------------------------------
    # outbound
    # ------------------------------------------------------------------------------------------

    def emit(self, type_: str, turn: int | None = None, **fields: Any) -> None:
        """Queue a JSON event. Never blocks, so the audio reader can always call it."""
        if self._closed and type_ != ev.SESSION_CLOSED:
            return
        self._events.put_nowait((type_, turn, fields))
        self._wake.set()

    async def _writer(self) -> None:
        try:
            while True:
                await self._wake.wait()
                self._wake.clear()
                while True:
                    if not self._events.empty():
                        type_, turn, fields = self._events.get_nowait()
                        self._seq += 1
                        t_ms = (self._clock() - self._started) * 1000
                        await self._send_json(ev.event(type_, self.id, self._seq, t_ms, turn, **fields))
                    elif not self._audio.empty():
                        item = self._audio.get_nowait()
                        # Stale audio (from a cancelled reply) is dropped here, before it can be sent.
                        if item.gen != self._gen or item.turn != self._response_turn:
                            self._metrics.count("stale_audio_dropped")
                            continue
                        await self._send_bytes(
                            pack_output(item.turn, self._next_chunk(), self._synth.sample_rate, item.data, item.last)
                        )
                    else:
                        break
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - a dead socket ends the writer; the endpoint cleans up
            log.debug("writer stopped", exc_info=True)

    def _next_chunk(self) -> int:
        i = self._chunk_index
        self._chunk_index += 1
        return i

    def _drain_audio(self) -> int:
        n = 0
        while not self._audio.empty():
            self._audio.get_nowait()
            n += 1
        return n

    # ------------------------------------------------------------------------------------------
    # inbound audio
    # ------------------------------------------------------------------------------------------

    def allow_frame(self) -> bool:
        """Token bucket: a steady `max_frames_per_second` is allowed, plus a burst of five seconds' worth.

        A healthy browser sends 50 frames a second, but frames can arrive in a clump when the page
        or this server stalls for a moment and then catches up. That is not misbehaviour; a
        sustained flood still runs the bucket dry and is refused.
        """
        now = self._clock()
        rate = float(self.s.max_frames_per_second)
        cap = rate * 5
        self._frame_tokens = min(cap, self._frame_tokens + (now - self._frame_tokens_at) * rate)
        self._frame_tokens_at = now
        if self._frame_tokens < 1:
            return False
        self._frame_tokens -= 1
        return True

    async def on_audio(self, pcm: bytes | memoryview) -> None:
        """Handle one frame of client audio (mono PCM16 at the declared rate)."""
        if self._closed:
            return
        now = self._clock()
        self.last_audio_at = now
        x = pcm16_to_float(pcm)
        if self._input_rate != SAMPLE_RATE:
            x = resample(x, self._input_rate, SAMPLE_RATE)
        if x.size == 0:
            return
        self.audio_samples_total += x.size
        self._remember(x)

        normal = self._vad.feed(x)
        strict = self._barge.feed(x)

        began = False  # a turn that begins now is fed from the look-back buffer, which includes x
        # 1. The customer is interrupting the agent (thinking or speaking). The strict detector must
        # hear speech AND it must be loud enough to be a person at the microphone, not a faint echo
        # of the agent's own voice. Checked on every frame, so someone who speaks up later still
        # gets through.
        if self.state in (State.THINKING, State.SPEAKING):
            if self._barge.in_speech and self._recent_rms(self.s.barge_in_rms_window_ms) >= self.s.barge_in_min_rms:
                await self._barge_in(now)
                began = True
        # 2. A new customer turn begins.
        elif self.state == State.LISTENING:
            if any(e.kind == "start" for e in normal):
                await self._begin_turn(now, self.s.min_speech_ms + self.s.pre_roll_ms)
                began = True

        if self.state == State.USER_SPEAKING and self._turn is not None:
            # a turn that began from the barge-in detector ends with whichever detector ends first
            ended = any(e.kind == "end" for e in normal) or (
                not self._vad.in_speech and any(e.kind == "end" for e in strict)
            )
            if not began:
                await self._feed(x, now)
            if self._turn is None:  # the recognizer failed while feeding
                return
            turn = self._turn
            turn_s = turn.fed_samples / SAMPLE_RATE
            if ended and self._hold_for_hanging_word(turn, now):
                ended = False
            elif turn.end_deadline is not None:
                if any(e.kind == "start" for e in normal):
                    turn.end_deadline = None  # they carried on: the normal silence rule applies again
                elif now >= turn.end_deadline:
                    ended = True
            if ended:
                await self._end_turn(now, silence_ms=self.s.end_silence_ms)
            elif turn_s >= self.s.max_turn_audio_s:
                self.emit(ev.SESSION_ERROR, self._turn.id, code=ev.E_TOO_LONG, fatal=False,
                          message="That was a very long turn, so I took it as finished")
                await self._end_turn(now, silence_ms=0)

    def _hold_for_hanging_word(self, turn: _Turn, now: float) -> bool:
        """Silence was detected, but the sentence ends on a word that cannot end a sentence."""
        extend = self.s.hold_for_hanging_word_ms
        if extend <= 0 or turn.held:
            return False
        words = turn.stream.partial().lower().split()
        if not words or words[-1].strip(".,?!") not in HANGING:
            return False
        turn.held = True
        turn.end_deadline = now + extend / 1000.0
        self._metrics.count("turns_held_open")
        return True

    def _remember(self, x: np.ndarray) -> None:
        self._ring.append(x)
        self._ring_samples += x.size
        while self._ring_samples - self._ring[0].size >= self._ring_limit:
            self._ring_samples -= self._ring.popleft().size

    def _recent_rms(self, ms: int) -> float:
        x = self._recent(ms)
        return float(np.sqrt(np.mean(x**2))) if x.size else 0.0

    def _recent(self, ms: int) -> np.ndarray:
        """The last `ms` of audio, including the frame being processed."""
        want = int(SAMPLE_RATE * ms / 1000)
        if not self._ring:
            return np.zeros(0, dtype=np.float32)
        joined = np.concatenate(list(self._ring))
        return joined[-want:] if joined.size > want else joined

    # ------------------------------------------------------------------------------------------
    # the customer's turn
    # ------------------------------------------------------------------------------------------

    async def _begin_turn(self, detected_at: float, lookback_ms: int) -> None:
        self._turn_counter += 1
        stream = self._rec.create_stream()
        turn = _Turn(id=self._turn_counter, stream=stream, detected_at=detected_at)
        turn.marks["speech_detected"] = detected_at
        self._turn = turn
        self.state = State.USER_SPEAKING
        self.emit(ev.SPEECH_STARTED, turn.id)
        # Start from before the detector fired, so the first word is not clipped.
        try:
            await self._feed(self._recent(lookback_ms), detected_at, from_ring=True)
        except Exception:  # noqa: BLE001
            await self._asr_failed(turn)

    async def _feed(self, x: np.ndarray, now: float, from_ring: bool = False) -> None:
        turn = self._turn
        if turn is None or x.size == 0:
            return
        try:
            await asyncio.to_thread(turn.stream.accept, x)
            turn.fed_samples += x.size
            # Partial transcripts, at most about every 150 ms and only when they changed.
            if now - turn.last_partial_at >= 0.15:
                text = turn.stream.partial()
                turn.last_partial_at = now
                if text and text != turn.last_partial:
                    turn.last_partial = text
                    if turn.first_partial_at is None:
                        turn.first_partial_at = now
                        turn.marks["first_partial"] = now
                    self.emit(ev.TRANSCRIPT_PARTIAL, turn.id, text=text)
        except Exception:  # noqa: BLE001
            log.exception("asr failed")
            await self._asr_failed(turn)

    async def _asr_failed(self, turn: _Turn) -> None:
        self.emit(ev.SESSION_ERROR, turn.id, code=ev.E_ASR_FAILED, fatal=False,
                  message="I could not process that audio, please try again")
        self._metrics.count("asr_failures")
        self._turn = None
        self.state = State.LISTENING
        self._vad.reset()
        self._barge.reset()

    async def _end_turn(self, now: float, silence_ms: int) -> None:
        turn = self._turn
        if turn is None:
            return
        self.state = State.TRANSCRIBING
        speech_end = now - silence_ms / 1000.0  # the customer actually stopped about here
        turn.marks["speech_end"] = speech_end
        try:
            t0 = self._clock()
            final = await asyncio.to_thread(turn.stream.finish)
            turn.marks["final"] = self._clock()
            asr_ms = (turn.marks["final"] - t0) * 1000
        except Exception:  # noqa: BLE001
            log.exception("asr finish failed")
            await self._asr_failed(turn)
            return
        self._turn = None
        text = normalize_spoken_codes(final.text.strip())  # "S K one zero zero one" -> "SK1001"
        spoken_ms = turn.fed_samples * 1000 / SAMPLE_RATE
        if not text or spoken_ms < MIN_TURN_SPEECH_MS:
            self.emit(ev.TURN_DISCARDED, turn.id, reason="no speech recognised")
            self._metrics.count("turns_discarded")
            self.state = State.LISTENING
            return
        low = self._is_doubtful(final)
        self._awaiting_approval = False  # this turn is the answer to any approval that was waiting
        self.emit(
            ev.TRANSCRIPT_FINAL,
            turn.id,
            text=text,
            confidence=round(final.confidence, 3),
            lowConfidence=low,
        )
        self._metrics.observe("speech_end_to_final_ms", (turn.marks["final"] - speech_end) * 1000)
        self._metrics.observe("final_asr_ms", asr_ms)
        if low:
            self._metrics.count("low_confidence_transcripts")
        self._start_reply(turn, text, low)

    def _is_doubtful(self, final: Any) -> bool:
        """Should the agent be told not to act on this transcript and to ask again?

        With only the live model, its own word probabilities decide. With the accurate second pass,
        that pass is trusted for ordinary turns (the live model is the weaker of the two and often
        disagrees on accents, which is not a reason to stop the customer from talking). The two
        passes disagreeing matters where a wrong word is costly: the answer to a change that is
        waiting for approval. Otherwise only a near-total disagreement counts.
        """
        if final.agreement is None:
            return final.confidence < LOW_CONFIDENCE or final.weakest < LOW_WEAKEST
        if self._awaiting_approval:
            return final.agreement < 0.8
        return final.agreement < 0.3

    # ------------------------------------------------------------------------------------------
    # the agent's reply
    # ------------------------------------------------------------------------------------------

    def _start_reply(self, turn: _Turn, text: str, low: bool) -> None:
        self._gen += 1
        self._response_turn = turn.id
        self._tts_cancel = threading.Event()
        self._chunk_index = 0
        self._audio_seconds_sent = 0.0
        self._first_audio_sent = False
        self._playback_ended = asyncio.Event()
        self._reply = turn
        self.state = State.THINKING
        self._agent_task = asyncio.create_task(
            self._run_reply(turn, text, low, self._gen, self._tts_cancel),
            name=f"voice-reply-{self.id}-{turn.id}",
        )

    async def _run_reply(self, turn: _Turn, text: str, low: bool, gen: int, cancel: threading.Event) -> None:
        phrases: asyncio.Queue[str | None] = asyncio.Queue()
        tts_task = asyncio.create_task(self._speak(turn, gen, phrases, cancel))
        chunker = Chunker()
        marks = turn.marks
        marks["agent_request"] = self._clock()
        status = "completed"
        acks = _Acks(self, turn, gen, phrases)
        try:
            events = self._agent.stream_turn(
                client_id=self.client_id,
                conversation_id=self.conversation_id,
                message=text,
                low_confidence=low,
            )
            async for event in events:
                if gen != self._gen:
                    await events.aclose()  # drop the connection: the runtime stops at its next safe point
                    return
                kind = event.get("type")
                if kind == "turn.started":
                    self._speech = SpeechPrefs.from_event(event.get("speech"))
                    cid = event.get("conversationId")
                    if isinstance(cid, str) and cid != self.conversation_id:
                        self.conversation_id = cid
                        self.emit(ev.SESSION_CONVERSATION, turn.id, conversationId=cid)
                elif kind == "agent.thinking":
                    self.emit(ev.AGENT_THINKING, turn.id)
                elif kind == "knowledge.used":
                    acks.done("knowledge")
                    self.emit(ev.KNOWLEDGE_USED, turn.id, sources=_strings(event.get("sources")))
                elif kind == "tool.started":
                    self.emit(ev.TOOL_STARTED, turn.id, tool=str(event.get("tool", ""))[:64])
                    tool = str(event.get("tool", ""))[:64]
                    acks.start(tool, self._speech.progress_tools.get(tool) or self._speech.progress_line)
                elif kind == "knowledge.searching":
                    self.emit(ev.KNOWLEDGE_SEARCHING, turn.id)
                    acks.start("knowledge", self._speech.progress_knowledge or self._speech.progress_line)
                elif kind == "turn.timing":
                    turn.agent_timings = event.get("timings") if isinstance(event.get("timings"), dict) else None
                elif kind == "tool.completed":
                    acks.done(str(event.get("tool", ""))[:64])
                    self.emit(ev.TOOL_COMPLETED, turn.id, tool=str(event.get("tool", ""))[:64],
                              status=str(event.get("status", "ok"))[:16])
                elif kind == "approval.required":
                    self._awaiting_approval = True
                    self.emit(ev.APPROVAL_REQUIRED, turn.id, summary=str(event.get("summary", ""))[:500],
                              expiresAt=str(event.get("expiresAt", ""))[:40])
                elif kind == "handoff.started":
                    self.emit(ev.HANDOFF_STARTED, turn.id, reason=str(event.get("reason", ""))[:200])
                elif kind == "agent.text.delta":
                    delta = str(event.get("text", ""))
                    if not delta:
                        continue
                    acks.cancel_all()  # the real answer is arriving: no filler needed
                    marks.setdefault("first_text", self._clock())
                    self.emit(ev.AGENT_TEXT_DELTA, turn.id, text=delta)
                    for phrase in chunker.push(delta):
                        cleaned = speakable(phrase)
                        if cleaned:
                            phrases.put_nowait(cleaned)
                elif kind == "turn.cancelled":
                    status = "cancelled"
                    break
                elif kind == "turn.error":
                    status = "error"
                    self.emit(ev.SESSION_ERROR, turn.id, code=ev.E_AGENT_FAILED, fatal=False,
                              message="The agent could not answer right now")
                    self._metrics.count("agent_errors")
                    phrases.put_nowait("Sorry, I'm having trouble answering right now. Please try again.")
                    break
            for phrase in chunker.flush():
                cleaned = speakable(phrase)
                if cleaned:
                    phrases.put_nowait(cleaned)
            phrases.put_nowait(None)
            await tts_task
            if gen != self._gen:
                return
            self.emit(ev.AGENT_SPEECH_COMPLETED, turn.id)
            await self._await_playback_end()
            if gen == self._gen:
                self._finish_reply(turn, status)
        except Exception:  # noqa: BLE001 (CancelledError is not an Exception: it propagates)
            log.exception("reply failed")
            if gen == self._gen:
                self.emit(ev.SESSION_ERROR, turn.id, code=ev.E_AGENT_FAILED, fatal=False,
                          message="Something went wrong while answering")
                self._finish_reply(turn, "error")
        finally:
            acks.cancel_all()
            if not tts_task.done():
                tts_task.cancel()
                await asyncio.gather(tts_task, return_exceptions=True)

    def _finish_reply(self, turn: _Turn, status: str) -> None:
        marks = turn.marks
        speech_end = marks.get("speech_end")
        metrics: dict[str, float] = {}
        if speech_end is not None:
            if "first_partial" in marks:
                metrics["firstPartialMs"] = (marks["first_partial"] - marks["speech_detected"]) * 1000
            if "final" in marks:
                metrics["speechEndToFinalMs"] = (marks["final"] - speech_end) * 1000
            if "first_text" in marks:
                metrics["speechEndToFirstTextMs"] = (marks["first_text"] - speech_end) * 1000
            if "first_audio" in marks:
                ms = (marks["first_audio"] - speech_end) * 1000
                metrics["speechEndToFirstAudioMs"] = ms
                self._metrics.observe("speech_end_to_first_audio_ms", ms)
            if "first_text" in marks:
                self._metrics.observe("speech_end_to_first_text_ms", metrics["speechEndToFirstTextMs"])
        metrics.update(_agent_stage_metrics(turn.agent_timings))
        for key, name in (("agentUnderstandMs", "agent_understand_ms"), ("agentRetrieveMs", "agent_retrieve_ms"),
                          ("agentLlmMs", "agent_llm_ms"), ("agentToolMs", "agent_tool_ms"),
                          ("agentFirstTokenMs", "agent_first_token_ms")):
            if key in metrics:
                self._metrics.observe(name, metrics[key])
        self.emit(ev.TURN_METRICS, turn.id, **{k: round(v) for k, v in metrics.items()})
        self.emit(ev.TURN_COMPLETED, turn.id, status=status)
        self._agent_task = None
        if self.state in (State.THINKING, State.SPEAKING):
            self.state = State.LISTENING

    async def _await_playback_end(self) -> None:
        """Stay in SPEAKING (still listening for an interruption) until the browser finished playing."""
        expected = max(0.0, self._audio_seconds_sent) + 1.5
        try:
            await asyncio.wait_for(self._playback_ended.wait(), timeout=expected)
        except asyncio.TimeoutError:
            pass

    # ---- speaking ----------------------------------------------------------------------------

    async def _speak(self, turn: _Turn, gen: int, phrases: "asyncio.Queue[str | None]", cancel: threading.Event) -> None:
        loop = asyncio.get_running_loop()
        failures = 0
        while True:
            phrase = await phrases.get()
            if phrase is None:
                break
            if gen != self._gen or cancel.is_set():
                continue  # drain: nothing more of this reply may be spoken
            try:
                await asyncio.to_thread(self._synthesize_blocking, phrase, turn, gen, cancel, loop)
            except Exception:  # noqa: BLE001 - one bad phrase must not end the call
                failures += 1
                log.exception("tts failed")
                self._metrics.count("tts_failures")
                if failures == 1:
                    self.emit(ev.SESSION_ERROR, turn.id, code=ev.E_TTS_FAILED, fatal=False,
                              message="I could not speak that part, but the text is on screen")
        if gen == self._gen:
            await self._enqueue_audio(turn.id, gen, b"", last=True)

    def _synthesize_blocking(
        self, phrase: str, turn: _Turn, gen: int, cancel: threading.Event, loop: asyncio.AbstractEventLoop
    ) -> None:
        frame_bytes = int(self._synth.sample_rate * OUT_FRAME_MS / 1000) * 2

        def sink(samples: np.ndarray) -> bool:
            if cancel.is_set() or gen != self._gen:
                return False
            pcm = float_to_pcm16(samples)
            for off in range(0, len(pcm), frame_bytes):
                if cancel.is_set() or gen != self._gen:
                    return False
                fut = asyncio.run_coroutine_threadsafe(
                    self._enqueue_audio(turn.id, gen, pcm[off : off + frame_bytes], last=False), loop
                )
                try:
                    fut.result(timeout=30)  # waits when the outbound queue is full: backpressure
                except Exception:  # noqa: BLE001 - loop is closing
                    return False
            return True

        pacer = Pacer(sink, self._synth.sample_rate, phrase, last_phrase=False,
                      sentence_ms=self.s.pause_sentence_ms, clause_ms=self.s.pause_clause_ms)
        done = self._synth.synthesize(phrase, pacer, cancel, speaker=self._speech.speaker, speed=self._speech.speed)
        if done is not False and not cancel.is_set() and gen == self._gen:
            pacer.finish()

    async def _enqueue_audio(self, turn: int, gen: int, data: bytes, last: bool) -> None:
        if gen != self._gen:
            return
        if data and not self._first_audio_sent:
            self._first_audio_sent = True
            if self._reply is not None and self._reply.id == turn:
                self._reply.marks["first_audio"] = self._clock()
            self.state = State.SPEAKING
            self.emit(ev.AGENT_SPEAKING, turn, sampleRate=self._synth.sample_rate)
        self._audio_seconds_sent += len(data) / 2 / self._synth.sample_rate
        await self._audio.put(_Audio(turn, gen, data, last))
        self._wake.set()

    # ------------------------------------------------------------------------------------------
    # interruption
    # ------------------------------------------------------------------------------------------

    async def _barge_in(self, detected_at: float) -> None:
        """The customer started talking over the agent: stop everything, then start their turn."""
        t0 = self._clock()
        await self._interrupt(ev.R_BARGE_IN, detected_at)
        await self._begin_turn(detected_at, self.s.barge_in_min_ms + self.s.pre_roll_ms)
        self._metrics.observe("barge_in_handling_ms", (self._clock() - t0) * 1000)

    async def _interrupt(self, reason: str, detected_at: float | None = None) -> bool:
        if self.state not in (State.THINKING, State.SPEAKING) and self._agent_task is None:
            return False
        turn = self._response_turn
        # 1. From this instant every queued or in-flight chunk of the old reply is stale.
        self._gen += 1
        self._tts_cancel.set()
        dropped = self._drain_audio()
        # 2. Tell the browser first (it silences playback on this event), before any slow cleanup.
        self.emit(ev.AGENT_INTERRUPTED, turn, reason=reason, droppedChunks=dropped)
        now = self._clock()
        self._metrics.count("interruptions")
        if detected_at is not None:
            self._metrics.observe("barge_in_decision_ms", (now - detected_at) * 1000)
        # 3. Cancel the request to the runtime and the synthesis; they clean up behind us.
        task = self._agent_task
        self._agent_task = None
        if task and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        self.state = State.LISTENING
        return True

    async def interrupt_from_client(self) -> None:
        """The user pressed stop. Same cancellation as speaking over the agent."""
        if await self._interrupt(ev.R_CLIENT):
            self._vad.reset()
            self._barge.reset()

    def on_playback_started(self, turn: int) -> None:
        pass

    def on_playback_stopped(self, turn: int, stop_ms: float | None) -> None:
        if stop_ms is not None:
            self._metrics.observe("client_playback_stop_ms", stop_ms)

    def on_playback_ended(self, turn: int) -> None:
        if turn == self._response_turn:
            self._playback_ended.set()


def _strings(value: Any) -> list[str]:
    return [str(v)[:64] for v in value[:10]] if isinstance(value, list) else []
