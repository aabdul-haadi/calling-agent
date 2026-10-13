"""The WebSocket endpoint: authentication, limits, and the read loop. See docs/VOICE.md for the
protocol. Audio arrives as binary frames, control messages as small JSON objects."""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid

from fastapi import APIRouter, WebSocket
from starlette.websockets import WebSocketDisconnect, WebSocketState

from app.auth import AuthError, TokenClaims
from app.audio.framing import FrameError, parse_input
from app.protocols import events as ev
from app.protocols import schemas
from app.sessions.manager import Engine
from app.sessions.session import VoiceSession

router = APIRouter()
log = logging.getLogger("voice.ws")

START_TIMEOUT_S = 5.0
MAX_BAD_FRAMES = 20


async def _reject(ws: WebSocket, code: str, message: str, ws_code: int = 1008) -> None:
    try:
        await ws.send_text(json.dumps({"type": ev.SESSION_ERROR, "seq": 1, "code": code, "message": message, "fatal": True}))
        await ws.close(code=ws_code)
    except Exception:  # noqa: BLE001 - the client may already be gone
        pass


@router.websocket("/ws")
async def voice_socket(ws: WebSocket) -> None:
    engine: Engine = ws.app.state.engine
    s = engine.settings

    # Browsers send an Origin header; refuse pages we do not know. (Non-browser clients send none.)
    origin = ws.headers.get("origin")
    if origin and origin not in s.allowed_origins:
        await ws.close(code=1008)
        return

    ip = ws.client.host if ws.client else "unknown"
    refusal = engine.admit(ip)
    if refusal:
        await ws.accept()
        await _reject(ws, ev.E_RATE_LIMIT, refusal, 1013)
        return

    await ws.accept()
    session: VoiceSession | None = None
    try:
        # --- handshake: the first message must be a valid session.start with a good token ------
        try:
            first = await asyncio.wait_for(ws.receive(), START_TIMEOUT_S)
        except asyncio.TimeoutError:
            await _reject(ws, ev.E_TIMEOUT, "session.start was not sent in time")
            return
        text = first.get("text")
        if first["type"] != "websocket.receive" or text is None or len(text) > s.max_control_bytes:
            await _reject(ws, ev.E_BAD_MESSAGE, "the first message must be session.start (JSON)")
            return
        try:
            start = schemas.parse_client_message(text)
        except schemas.MessageError as exc:
            await _reject(ws, ev.E_BAD_MESSAGE, str(exc))
            return
        if not isinstance(start, schemas.SessionStart):
            await _reject(ws, ev.E_BAD_MESSAGE, "the first message must be session.start")
            return
        try:
            claims: TokenClaims = engine.verifier.verify(start.token)
        except AuthError as exc:
            log.info("token refused: %s", exc)
            engine.metrics.count("auth_refused")
            await _reject(ws, ev.E_UNAUTHORIZED, "This voice session is not authorised")
            return
        if claims.conversation_id and start.conversationId and claims.conversation_id != start.conversationId:
            await _reject(ws, ev.E_UNAUTHORIZED, "This voice session is not authorised")
            return
        if not engine.ready or engine.recognizer is None or engine.synth is None or engine.agent is None:
            await _reject(ws, ev.E_UNAVAILABLE, engine.load_error or "The voice models are still loading", 1013)
            return

        async def send_json(obj: dict) -> None:
            if ws.application_state == WebSocketState.CONNECTED:
                await ws.send_text(json.dumps(obj, separators=(",", ":")))

        async def send_bytes(data: bytes) -> None:
            if ws.application_state == WebSocketState.CONNECTED:
                await ws.send_bytes(data)

        session = VoiceSession(
            session_id=uuid.uuid4().hex[:12],
            client_id=claims.client_id,
            conversation_id=claims.conversation_id or start.conversationId,
            settings=s,
            recognizer=engine.recognizer,
            synth=engine.synth,
            agent=engine.agent,
            metrics=engine.metrics,
            send_json=send_json,
            send_bytes=send_bytes,
            detector_factory=engine.detector_factory,
            input_rate=start.sampleRate,
        )
        await session.start(engine.limits())
        engine.metrics.count("sessions_started")

        # --- read loop -------------------------------------------------------------------------
        began = time.monotonic()
        bad_frames = 0
        reason = "client closed"
        while True:
            remaining = s.max_session_s - (time.monotonic() - began)
            if remaining <= 0:
                reason = "session time limit reached"
                session.emit(ev.SESSION_ERROR, code=ev.E_TIMEOUT, fatal=True, message=reason)
                break
            try:
                msg = await asyncio.wait_for(ws.receive(), min(remaining, s.idle_timeout_s))
            except asyncio.TimeoutError:
                idle = time.monotonic() - session.last_audio_at
                if idle >= s.idle_timeout_s:
                    reason = "no audio received"
                    session.emit(ev.SESSION_ERROR, code=ev.E_TIMEOUT, fatal=True, message=reason)
                    break
                continue
            if msg["type"] == "websocket.disconnect":
                break

            data = msg.get("bytes")
            if data is not None:
                if len(data) > s.max_frame_bytes:
                    session.emit(ev.SESSION_ERROR, code=ev.E_BAD_FRAME, fatal=True, message="audio frame too large")
                    reason = "frame too large"
                    break
                if not session.allow_frame():
                    session.emit(ev.SESSION_ERROR, code=ev.E_RATE_LIMIT, fatal=True, message="too many audio frames per second")
                    reason = "rate limited"
                    break
                try:
                    payload = parse_input(data)
                except FrameError as exc:
                    bad_frames += 1
                    session.emit(ev.SESSION_ERROR, code=ev.E_BAD_FRAME, fatal=False, message=str(exc))
                    if bad_frames > MAX_BAD_FRAMES:
                        reason = "too many malformed frames"
                        break
                    continue
                await session.on_audio(payload)
                continue

            text = msg.get("text")
            if text is None:
                continue
            if len(text) > s.max_control_bytes:
                session.emit(ev.SESSION_ERROR, code=ev.E_BAD_MESSAGE, fatal=True, message="control message too large")
                reason = "control message too large"
                break
            try:
                m = schemas.parse_client_message(text)
            except schemas.MessageError as exc:
                session.emit(ev.SESSION_ERROR, code=ev.E_BAD_MESSAGE, fatal=False, message=str(exc))
                continue
            if isinstance(m, schemas.Interrupt):
                await session.interrupt_from_client()
            elif isinstance(m, schemas.PlaybackStarted):
                session.on_playback_started(m.turn)
            elif isinstance(m, schemas.PlaybackStopped):
                session.on_playback_stopped(m.turn, m.stopMs)
            elif isinstance(m, schemas.PlaybackEnded):
                session.on_playback_ended(m.turn)
            elif isinstance(m, schemas.SessionEnd):
                reason = "client ended the session"
                break
            else:  # a second session.start
                session.emit(ev.SESSION_ERROR, code=ev.E_BAD_MESSAGE, fatal=False, message="session already started")

        await session.close(reason)
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001
        log.exception("voice session crashed")
    finally:
        if session is not None:
            await session.close("disconnected")
        engine.release(ip)
        try:
            if ws.application_state == WebSocketState.CONNECTED:
                await ws.close()
        except Exception:  # noqa: BLE001
            pass
