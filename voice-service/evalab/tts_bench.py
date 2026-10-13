"""Compare local voices on the same sentences, through the same spoken-rendering layer the gateway uses.

    python -m evalab.tts_bench                    # every installed voice
    python -m evalab.tts_bench --voices kokoro piper-amy-low

Measured per voice: model load time and memory, first-synthesis (cold) and warm latency to the first
audio sample, real-time factor, loudness steadiness across chunks (voice consistency), trailing
silence per chunk (it adds to the pause between phrases), and intelligibility: the audio is
transcribed by the accurate recognizer and compared, as spoken words, with what was meant (so dates,
amounts and booking references are checked, not just easy words).

What this CANNOT measure is how natural a voice sounds. It writes WAV files to
evalab/results/tts_samples/ and a ratings sheet for a person to fill in; no automatic score is
presented as "naturalness".
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import threading
import time
import wave
from pathlib import Path

import numpy as np

from app.asr.offline import OfflineRecognizer
from app.asr.spoken import spoken_words
from app.audio.resampling import resample
from app.tts.streaming import VOICES, SherpaTts, installed
from app.tts.text import speakable

SENTENCES = [
    "Sorry about that. Let me check what happened.",
    "All set. I've updated your booking.",
    "Could you give me your booking reference?",
    "I found three alternatives. Would you like to hear them?",
    "Your booking reference is SK1001, is that right?",
    "I can move you to flight SK110, leaving at 3:50 PM on Monday, October 12th. Shall I go ahead?",
    "The change fee is $45.50, and the fare difference is $120.",
    "Refunds take 7 business days to reach your card.",
    "Your last name is Okafor, and the flight lands at 15:05.",
    "Your bill went up by $12.99 this month because the plan changed on the 3rd.",
    "I'm not sure about that one, so I'd rather connect you with a person who can help.",
    (
        "Your flight to London was cancelled, so I can offer you the next available flight tomorrow morning, "
        "or a full refund if you would rather not travel, and either way there is no extra charge."
    ),
]
# Speakers tried on the multi-speaker Kokoro model.
KOKORO_TRY = ["af_heart", "af_bella", "af_nicole", "af_sarah", "bf_emma", "am_adam"]


def rss_mb() -> float:
    import psutil

    return psutil.Process().memory_info().rss / 1e6


def synth(tts: SherpaTts, text: str, speaker: str | None = None) -> tuple[np.ndarray, float, float]:
    """(samples, seconds to first audio, total seconds)"""
    parts: list[np.ndarray] = []
    first: list[float] = []
    t0 = time.perf_counter()

    def sink(x: np.ndarray) -> bool:
        if not first:
            first.append(time.perf_counter() - t0)
        parts.append(x)
        return True

    tts.synthesize(text, sink, threading.Event(), speaker=speaker)
    total = time.perf_counter() - t0
    return (np.concatenate(parts) if parts else np.zeros(0, np.float32)), (first[0] if first else total), total


def trailing_silence_ms(x: np.ndarray, rate: int) -> float:
    if x.size == 0:
        return 0.0
    loud = np.where(np.abs(x) > 0.01)[0]
    return (x.size - 1 - (loud[-1] if loud.size else 0)) * 1000 / rate


def pitch_hz(x: np.ndarray, rate: int) -> float:
    """Median fundamental frequency by autocorrelation, only to sanity-check male/female labels."""
    hop, win = int(0.03 * rate), int(0.04 * rate)
    f0s = []
    for i in range(0, x.size - win, hop):
        seg = x[i : i + win] - x[i : i + win].mean()
        if np.sqrt(np.mean(seg**2)) < 0.02:
            continue
        ac = np.correlate(seg, seg, "full")[win - 1 :]
        lo, hi = int(rate / 400), int(rate / 70)
        lag = lo + int(np.argmax(ac[lo:hi]))
        if ac[lag] > 0.4 * ac[0]:
            f0s.append(rate / lag)
    return float(np.median(f0s)) if f0s else 0.0


def write_wav(path: Path, x: np.ndarray, rate: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())


def wer_spoken(ref: str, hyp: str) -> tuple[int, int]:
    a, b = spoken_words(ref), spoken_words(hyp)
    prev = list(range(len(b) + 1))
    for i, p in enumerate(a, 1):
        cur = [i]
        for j, q in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (p != q)))
        prev = cur
    return prev[-1], len(a)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--voices", nargs="*", default=None)
    ap.add_argument("--speakers", nargs="*", default=KOKORO_TRY, help="Kokoro speakers to try")
    ap.add_argument("--threads", type=int, default=4)
    args = ap.parse_args(argv)

    judge = OfflineRecognizer("parakeet-tdt-0.6b-v2")
    judge.warm_up()
    rendered = [speakable(s) for s in SENTENCES]
    out_dir = Path(__file__).resolve().parent / "results" / "tts_samples"
    results = []

    for key in args.voices or list(VOICES):
        if not installed(key):
            print(f"skipped {key}: not installed")
            continue
        speakers = args.speakers if VOICES[key].kind == "kokoro" else [None]
        before = rss_mb()
        tts = SherpaTts(key, args.threads)
        load_mb = rss_mb() - before
        for spk in speakers:
            label = f"{key}:{spk}" if spk else key
            # cold: the very first synthesis after load, no warm-up
            _, cold_first, cold_total = synth(tts, rendered[0], spk) if spk == speakers[0] else (None, None, None)
            firsts, totals, audio_s, tails, rms_db, errs, words, per_clip = [], [], 0.0, [], [], 0, 0, []
            for i, text in enumerate(rendered):
                x, first, total = synth(tts, text, spk)
                firsts.append(first * 1000)
                totals.append(total)
                audio_s += x.size / tts.sample_rate
                tails.append(trailing_silence_ms(x, tts.sample_rate))
                voiced = x[np.abs(x) > 0.01]
                if voiced.size:
                    rms_db.append(20 * np.log10(float(np.sqrt(np.mean(voiced**2))) + 1e-9))
                heard = judge.transcribe(resample(x, tts.sample_rate, 16000).astype(np.float32))
                e, n = wer_spoken(text, speakable(heard))  # both sides in the same spoken form
                errs, words = errs + e, words + n
                per_clip.append({"text": SENTENCES[i], "heard": heard, "errors": e})
                write_wav(out_dir / f"{label.replace(':', '_')}_{i + 1:02d}.wav", x, tts.sample_rate)
            all_x = np.concatenate([synth(tts, t, spk)[0] for t in rendered[:3]])
            res = {
                "voice": label,
                "sample_rate": tts.sample_rate,
                "licence": VOICES[key].licence,
                "load_s": round(tts.load_seconds, 2),
                "load_mb": round(load_mb),
                "cold_first_audio_ms": round(cold_first * 1000) if cold_first else None,
                "warm_first_audio_ms_p50": round(statistics.median(firsts)),
                "warm_first_audio_ms_p95": round(sorted(firsts)[int(0.95 * (len(firsts) - 1))]),
                "rtf": round(sum(totals) / audio_s, 3),
                "loudness_spread_db": round(float(np.std(rms_db)), 2),
                "trailing_silence_ms_mean": round(statistics.fmean(tails)),
                "intelligibility_wer": round(errs / max(1, words), 3),
                "pitch_hz": round(pitch_hz(all_x, tts.sample_rate)) if spk else None,
                "clips": per_clip,
            }
            results.append(res)
            print(f"{label:34} rate {res['sample_rate']:5}  cold {str(res['cold_first_audio_ms']):>5} ms  warm p50 "
                  f"{res['warm_first_audio_ms_p50']:5} p95 {res['warm_first_audio_ms_p95']:5} ms  RTF {res['rtf']:.2f}  "
                  f"WER {res['intelligibility_wer']:.3f}  spread {res['loudness_spread_db']:.1f} dB  "
                  f"tail {res['trailing_silence_ms_mean']} ms  +{res['load_mb']} MB  pitch {res['pitch_hz']}")
        del tts

    out = Path(__file__).resolve().parent / "results"
    (out / "tts_bench.json").write_text(json.dumps(results, indent=1), encoding="utf-8")
    sheet = ["# Listening sheet (fill in by ear; 1 = robotic, 5 = natural). Nothing here is automatic.", "",
             "| voice | clip | naturalness 1-5 | clear? | notes |", "| --- | --- | --- | --- | --- |"]
    for r in results:
        for i in range(len(SENTENCES)):
            sheet.append(f"| {r['voice']} | {i + 1:02d} |  |  |  |")
    (out / "tts_listening_sheet.md").write_text("\n".join(sheet), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
