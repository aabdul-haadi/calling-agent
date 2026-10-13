"""End-to-end voice benchmark against the real gateway (real VAD, recognizer and voice).

    python -m evalab.turn_bench               # full run (about 5 minutes)
    python -m evalab.turn_bench --quick       # fewer trials
    python -m evalab.turn_bench --runtime http://127.0.0.1:4000   # use the real TypeScript agent

By default the agent is a scripted stand-in that answers immediately, which isolates the cost of
the voice pipeline itself (listening, transcribing, speaking). Add --runtime to include the real
agent and model; model latency then dominates and varies with the provider.

A client sends audio exactly as a browser would (one 20 ms frame every 20 ms) and every timing is
taken from known positions in that audio, so the results do not depend on how the gateway
measures itself.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import platform
import threading
import time
from pathlib import Path

import httpx
import numpy as np
import psutil
import uvicorn

from app.config import Settings
from app.integrations.agent_runtime import HttpAgentRuntime
from app.main import create_app
from app.observability.stats import summarize
from app.sessions.manager import Engine
from app.tts.streaming import SherpaTts
from evalab import fixtures
from tests.fakes import FakeAgent, text
from tests.integration.conftest import SECRET, Client, Gateway, free_port, onset_seconds

RESULTS = Path(__file__).resolve().parent / "results"
SHORT_REPLY = text("Of course, I can help with that. ", "Which flight would you like to move?")
LONG_REPLY = text(*(["Here is another sentence of a rather long explanation about your options. "] * 14))


def end_seconds(samples: np.ndarray, fraction: float = 0.04) -> float:
    loud = np.flatnonzero(np.abs(samples) > fraction * np.max(np.abs(samples)))
    return float(loud[-1]) / 16000 if loud.size else 0.0


class Sampler:
    """Process CPU and memory, sampled while the benchmark runs."""

    def __init__(self) -> None:
        self.proc = psutil.Process(os.getpid())
        self.cpu: list[float] = []
        self.rss: list[float] = []
        self._stop = threading.Event()
        self._t = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        self.proc.cpu_percent(None)
        while not self._stop.wait(0.25):
            self.cpu.append(self.proc.cpu_percent(None))
            self.rss.append(self.proc.memory_info().rss / 1e6)

    def start(self) -> None:
        self._t.start()

    def stop(self) -> dict:
        self._stop.set()
        self._t.join(timeout=2)
        busy = [c for c in self.cpu if c > 5]
        return {
            "rss_mb_peak": round(max(self.rss), 0) if self.rss else None,
            "cpu_percent_mean_when_busy": round(float(np.mean(busy)), 0) if busy else None,
            "cpu_percent_peak": round(max(self.cpu), 0) if self.cpu else None,
            "logical_cpus": psutil.cpu_count(),
        }


def start_gateway(runtime: str | None) -> tuple[Gateway, uvicorn.Server, threading.Thread]:
    settings = Settings(
        gateway_secret=SECRET, allowed_origins=("http://localhost:5173",), max_sessions=12,
        max_sessions_per_ip=12, idle_timeout_s=60, agent_runtime_url=runtime or "http://127.0.0.1:4000",
    )
    agent = FakeAgent()
    engine = Engine(settings, agent=HttpAgentRuntime(runtime) if runtime else agent)
    app = create_app(settings, engine)
    port = free_port()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning",
                                           ws_max_size=settings.max_frame_bytes + 64))
    thread = threading.Thread(target=server.run, daemon=True)
    started = time.perf_counter()
    thread.start()
    while time.perf_counter() - started < 120:
        try:
            if httpx.get(f"http://127.0.0.1:{port}/health", timeout=1).json().get("ready"):
                break
        except httpx.HTTPError:
            pass
        time.sleep(0.25)
    else:
        raise SystemExit(f"gateway never became ready: {engine.load_error}")
    engine.load_seconds["ready_after_start"] = round(time.perf_counter() - started, 2)
    return Gateway(port, engine, agent, settings), server, thread


async def one_turn(gw: Gateway, c: Client, audio: np.ndarray, reply: list | None = None) -> dict:
    """Say one phrase to a connected session and time everything from known audio positions."""
    if not gw.engine.agent.__class__.__name__ == "HttpAgentRuntime":
        gw.agent.script(*(reply or SHORT_REPLY))
    n_final = len(c.of("transcript.final"))
    n_frames = len(c.frames)
    # send speech followed by silence; remember when each part started
    t_start = time.perf_counter()
    sender = asyncio.create_task(c.send_audio(np.concatenate([audio, np.zeros(int(16000 * 1.6), dtype=np.float32)])))
    onset_t = t_start + onset_seconds(audio)
    end_t = t_start + end_seconds(audio)
    final = await c.wait_for("transcript.final", 20, nth=n_final)
    first_audio = None
    deadline = time.perf_counter() + 40
    while time.perf_counter() < deadline and first_audio is None:
        if len(c.frames) > n_frames:
            first_audio = c.frames[n_frames][0]
        await asyncio.sleep(0.005)
    await sender
    last = c.of("turn.completed")
    # tell the gateway the browser finished playing (as the real client does)
    turn = final["turn"]
    await c.send_json({"type": "playback.ended", "turn": turn})
    await asyncio.sleep(0.15)
    started_t = [t for t, e in c.events if e["type"] == "speech.started"][-1]
    partials = [t for t, e in c.events if e["type"] == "transcript.partial" and e["turn"] == turn]
    final_t = [t for t, e in c.events if e["type"] == "transcript.final"][-1]
    text_t = next((t for t, e in c.events if e["type"] == "agent.text.delta" and e["turn"] == turn), None)
    return {
        "vad_onset_ms": (started_t - onset_t) * 1000,
        "first_partial_ms": (partials[0] - onset_t) * 1000 if partials else None,
        "speech_end_to_final_ms": (final_t - end_t) * 1000,
        "speech_end_to_first_text_ms": (text_t - end_t) * 1000 if text_t else None,
        "speech_end_to_first_audio_ms": (first_audio - end_t) * 1000 if first_audio else None,
        "text": final["text"], "low_confidence": final.get("lowConfidence"),
        "done": bool(last),
    }


async def barge_trial(gw: Gateway, rng: np.random.Generator, phrase_audio: np.ndarray, interrupter: np.ndarray) -> dict:
    c = await Client.connect(gw)
    await c.wait_for("session.started", 5)
    gw.agent.script(*LONG_REPLY, 30.0)
    await c.send_audio(np.concatenate([phrase_audio, np.zeros(int(16000 * 1.5), dtype=np.float32)]))
    await c.wait_for("agent.speaking", 40)
    await asyncio.sleep(float(rng.uniform(0.8, 3.0)))
    n_before = len(c.of("agent.interrupted"))
    t_start = time.perf_counter()
    sender = asyncio.create_task(c.send_audio(np.concatenate([interrupter, np.zeros(int(16000 * 1.6), dtype=np.float32)])))
    onset_t = t_start + onset_seconds(interrupter)
    try:
        await c.wait_for("agent.interrupted", 4, nth=n_before)
    except AssertionError:
        await sender
        await c.close()
        return {"missed": True}
    stop_t = [t for t, e in c.events if e["type"] == "agent.interrupted"][-1]
    # any audio of the interrupted reply arriving after the interruption was announced is stale
    await asyncio.sleep(0.6)
    stale = sum(1 for t, f in c.frames if t > stop_t and f.turn == 1)
    await sender
    understood = None
    try:
        final = await c.wait_for("transcript.final", 8, nth=1)
        understood = final["text"]
    except AssertionError:
        pass
    await c.close()
    return {"missed": False, "onset_to_stop_ms": (stop_t - onset_t) * 1000, "stale_frames": stale, "second_turn_text": understood}


def noise(kind: str, seconds: float, rng: np.random.Generator, voices: list[np.ndarray]) -> np.ndarray:
    n = int(16000 * seconds)
    if kind.startswith("white"):
        return (rng.standard_normal(n) * float(kind.split("_")[1])).astype(np.float32)
    if kind == "knocks":
        x = np.zeros(n, dtype=np.float32)
        for k in range(5):
            at = int(16000 * (0.2 + 0.4 * k))
            decay = np.exp(-np.arange(1600) / 250.0) * rng.standard_normal(1600)
            x[at : at + 1600] += (0.5 * decay).astype(np.float32)
        return np.clip(x, -1, 1)
    if kind.startswith("babble"):
        level = float(kind.split("_")[1])
        mix = np.zeros(n, dtype=np.float32)
        for v in voices:
            mix += np.tile(np.roll(v, -int(rng.integers(0, v.size))), int(np.ceil(n / v.size)))[:n]
        return (mix * level / (np.sqrt(np.mean(mix**2)) + 1e-9)).astype(np.float32)
    raise ValueError(kind)


async def false_interruption_trial(gw: Gateway, kind: str, rng: np.random.Generator, phrase_audio: np.ndarray, voices: list[np.ndarray]) -> bool:
    c = await Client.connect(gw)
    await c.wait_for("session.started", 5)
    gw.agent.script(*LONG_REPLY, 30.0)
    await c.send_audio(np.concatenate([phrase_audio, np.zeros(int(16000 * 1.5), dtype=np.float32)]))
    await c.wait_for("agent.speaking", 40)
    await asyncio.sleep(1.0)
    n = len(c.of("agent.interrupted"))
    if kind.startswith("echo"):
        # What the microphone would hear if the speakers were audible and nothing cancelled the echo:
        # the agent's own voice, quieter and a little late.
        db = float(kind.split("_")[1])
        pcm = np.concatenate([np.frombuffer(bytes(f.pcm), dtype="<i2") for _, f in c.frames[-60:]]).astype(np.float32) / 32768
        injected = np.concatenate([np.zeros(2400, np.float32), pcm * 10 ** (db / 20)])[: 16000 * 2]
    else:
        injected = noise(kind, 2.0, rng, voices)
    await c.send_audio(np.concatenate([injected, np.zeros(int(16000 * 0.5), dtype=np.float32)]))
    await asyncio.sleep(0.4)
    interrupted = len(c.of("agent.interrupted")) > n
    await c.close()
    return interrupted


async def run(args: argparse.Namespace) -> dict:
    n_turns, n_barge, n_false = (8, 6, 4) if args.quick else (30, 24, 8)
    sampler = Sampler()
    print("starting gateway and loading models ...")
    gw, server, thread = start_gateway(args.runtime)
    cold = dict(gw.engine.load_seconds)
    sampler.start()
    tts = SherpaTts()
    rng = np.random.default_rng(fixtures.SEED)
    phrases = ["greeting", "cancelled", "pick", "refund", "bags", "yes_please"]
    audio = {k: fixtures.synth(tts, fixtures.PHRASES[k]) for k in phrases}
    voices = [fixtures.synth(tts, fixtures.PHRASES[k]) for k in ("long", "cancelled", "refund")]
    interrupter = fixtures.synth(tts, fixtures.PHRASES["interrupter"])
    result: dict = {
        "environment": {
            "machine": platform.processor() or platform.machine(), "os": platform.platform(),
            "python": platform.python_version(), "logical_cpus": psutil.cpu_count(),
            "ram_gb": round(psutil.virtual_memory().total / 1e9, 1),
            "asr": gw.engine.recognizer.name, "tts": gw.engine.synth.name, "vad": "silero_vad (sherpa-onnx)",
            "input_sample_rate": 16000, "frame_ms": 20, "output_sample_rate": gw.engine.synth.sample_rate,
            "agent": args.runtime or "scripted stand-in (answers immediately)",
            "settings": {k: getattr(gw.settings, k) for k in ("vad_threshold", "min_speech_ms", "end_silence_ms",
                         "barge_in_threshold", "barge_in_min_ms", "hold_for_hanging_word_ms")},
        },
        "cold_start_seconds": cold,
    }

    # ---- 1. ordinary turns (one session, warm) ------------------------------------------------
    print(f"turns ({n_turns}) ...")
    c = await Client.connect(gw)
    await c.wait_for("session.started", 5)
    turns = []
    first = await one_turn(gw, c, audio["greeting"])  # the very first turn after start: not warmed by traffic
    result["first_turn_after_start"] = {k: round(v) if isinstance(v, float) else v for k, v in first.items() if k.endswith("_ms")}
    for i in range(n_turns):
        turns.append(await one_turn(gw, c, audio[phrases[i % len(phrases)]]))
    await c.close()
    result["turns"] = {k: summarize([t[k] for t in turns if t.get(k) is not None]) for k in
                       ("vad_onset_ms", "first_partial_ms", "speech_end_to_final_ms",
                        "speech_end_to_first_text_ms", "speech_end_to_first_audio_ms")}
    result["turns"]["transcripts_flagged_low_confidence"] = sum(bool(t["low_confidence"]) for t in turns)
    result["turns"]["n"] = len(turns)

    # ---- 2. barge-in --------------------------------------------------------------------------
    print(f"barge-in ({n_barge}) ...")
    trials = [await barge_trial(gw, rng, audio["greeting"], interrupter) for _ in range(n_barge)]
    got = [t for t in trials if not t["missed"]]
    result["barge_in"] = {
        "trials": len(trials), "missed": len(trials) - len(got),
        "onset_to_stop_signal_ms": summarize([t["onset_to_stop_ms"] for t in got]),
        "stale_frames_after_interrupt_total": sum(t["stale_frames"] for t in got),
        "new_turn_understood": sum(1 for t in got if t["second_turn_text"]),
    }
    snap = gw.engine.metrics.snapshot()
    result["barge_in"]["server_decision_ms"] = snap["timings_ms"].get("barge_in_decision_ms")

    # ---- 3. false interruptions ---------------------------------------------------------------
    print(f"false interruptions ({n_false} per kind) ...")
    kinds = ["white_0.02", "white_0.06", "knocks", "babble_0.01", "babble_0.03", "echo_-20", "echo_-10"]
    fi = {}
    for kind in kinds:
        hits = [await false_interruption_trial(gw, kind, rng, audio["greeting"], voices) for _ in range(n_false)]
        fi[kind] = {"trials": len(hits), "interrupted": sum(hits), "rate": round(sum(hits) / len(hits), 2)}
    result["false_interruptions"] = fi

    # ---- 4. concurrency -----------------------------------------------------------------------
    if not args.quick:
        print("concurrency ...")
        conc = {}
        for k in (2, 4):
            clients = [await Client.connect(gw) for _ in range(k)]
            for cl in clients:
                await cl.wait_for("session.started", 5)
            if not args.runtime:
                for _ in range(k * 5):
                    gw.agent.script(*SHORT_REPLY)
            rows: list[dict] = []
            for rnd in range(4):
                out = await asyncio.gather(*[one_turn(gw, cl, audio[phrases[(rnd + j) % 6]]) for j, cl in enumerate(clients)])
                rows += out
            conc[f"{k}_sessions"] = {
                "speech_end_to_final_ms": summarize([r["speech_end_to_final_ms"] for r in rows]),
                "speech_end_to_first_audio_ms": summarize([r["speech_end_to_first_audio_ms"] for r in rows if r["speech_end_to_first_audio_ms"]]),
            }
            for cl in clients:
                await cl.close()
        result["concurrency"] = conc

    result["resources"] = sampler.stop()
    result["server_metrics"] = gw.engine.metrics.snapshot()
    server.should_exit = True
    thread.join(timeout=10)
    return result


def evaluate(result: dict) -> list[tuple[str, str, bool | None]]:
    """The acceptance targets from the brief, checked against what was measured."""
    t, b = result["turns"], result["barge_in"]
    rows: list[tuple[str, str, bool | None]] = []

    def p(d: dict, key: str) -> float | None:
        return d.get(key) if d.get("n") else None

    v = p(t["vad_onset_ms"], "p95")
    rows.append(("VAD speech-onset detection p95 <= 200 ms", f"{v} ms", None if v is None else v <= 200))
    f = p(t["speech_end_to_final_ms"], "p95")
    rows.append(("Final transcript after end of speech p95 <= 800 ms", f"{f} ms", None if f is None else f <= 800))
    a50, a95 = p(t["speech_end_to_first_audio_ms"], "p50"), p(t["speech_end_to_first_audio_ms"], "p95")
    rows.append(("End of speech -> first audio p50 <= 1200 ms", f"{a50} ms", None if a50 is None else a50 <= 1200))
    rows.append(("End of speech -> first audio p95 <= 2500 ms", f"{a95} ms", None if a95 is None else a95 <= 2500))
    s95 = p(b["onset_to_stop_signal_ms"], "p95")
    rows.append(("Barge-in: speech onset -> stop signal p95 (user-perceived)", f"{s95} ms", None))
    d95 = (b.get("server_decision_ms") or {}).get("p95")
    rows.append(("Barge-in: confirmed -> stop signal queued p95 <= 150 ms", f"{d95} ms", None if d95 is None else d95 <= 150))
    rows.append(("Stale audio after interruption = 0", str(b["stale_frames_after_interrupt_total"]), b["stale_frames_after_interrupt_total"] == 0))
    rows.append(("Missed interruptions = 0", str(b["missed"]), b["missed"] == 0))
    return rows


def write_report(result: dict, rows: list[tuple[str, str, bool | None]]) -> None:
    RESULTS.mkdir(exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    (RESULTS / f"turn_bench-{stamp}.json").write_text(json.dumps(result, indent=1), encoding="utf-8")
    (RESULTS / "turn_bench-latest.json").write_text(json.dumps(result, indent=1), encoding="utf-8")
    print("\nTargets")
    for name, value, ok in rows:
        mark = "n/a " if ok is None else ("PASS" if ok else "FAIL")
        print(f"  [{mark}] {name}: {value}")
    print("\nFalse interruptions while the agent speaks:")
    for kind, v in result["false_interruptions"].items():
        print(f"  {kind:14} {v['interrupted']}/{v['trials']} interrupted")
    print("\nTurns:", json.dumps(result["turns"], indent=1))
    print("\nBarge-in:", json.dumps(result["barge_in"], indent=1))
    print("\nResources:", result["resources"], "\nCold start:", result["cold_start_seconds"])
    if "concurrency" in result:
        print("\nConcurrency:", json.dumps(result["concurrency"], indent=1))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--runtime", help="URL of the real TypeScript agent runtime (default: scripted stand-in)")
    args = ap.parse_args()
    result = asyncio.run(run(args))
    write_report(result, evaluate(result))


if __name__ == "__main__":
    main()
