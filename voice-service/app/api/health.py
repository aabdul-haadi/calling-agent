from __future__ import annotations

import time

from fastapi import APIRouter, Request

from app.sessions.manager import Engine

router = APIRouter()


@router.get("/health")
async def health(request: Request) -> dict:
    engine: Engine = request.app.state.engine
    return {
        "status": "ok" if engine.ready else ("error" if engine.load_error else "loading"),
        "ready": engine.ready,
        "error": engine.load_error,
        "asr": engine.recognizer.name if engine.recognizer else None,
        "tts": engine.synth.name if engine.synth else None,
        "sessions": engine.active_sessions,
        "uptimeSeconds": round(time.monotonic() - engine.started_at),
        "loadSeconds": engine.load_seconds,
    }


@router.get("/metrics")
async def metrics(request: Request) -> dict:
    """Rolling timings (ms) and counters since the service started. Aggregates only: no audio,
    no transcripts, no customer data."""
    engine: Engine = request.app.state.engine
    return {"activeSessions": engine.active_sessions, **engine.metrics.snapshot()}
