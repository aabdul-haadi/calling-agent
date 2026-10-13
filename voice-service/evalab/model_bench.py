"""Compare recognizers on the same audio: the streaming zipformer against offline re-decoders.

    python -m evalab.model_bench                       # zipformer-large vs every installed offline model
    python -m evalab.model_bench --models parakeet-tdt-0.6b-v2

Each clip is decoded by every model. Reports per condition: corpus WER, exact-match rate, "critical"
accuracy (clips whose reference holds a booking reference, name or time must match word for word),
decode time after the last sample, real-time factor, and the process memory afterwards.
Writes evalab/results/model_bench.json.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from collections import defaultdict
from pathlib import Path

import numpy as np

from app.asr.offline import OFFLINE_MODELS, OfflineRecognizer
from app.asr.streaming import MissingModelError, SherpaRecognizer
from app.tts.streaming import SherpaTts
from evalab import fixtures
from evalab.asr_compare import load_clips
from evalab.metrics import read_wav_mono16k
from app.asr.spoken import spoken_words


def _errors(ref: str, hyp: str) -> tuple[int, int]:
    """Word edit distance on SPOKEN forms (see app/asr/spoken.py): '1001' and 'one zero zero one' match,
    but a misheard word or digit still counts."""
    a, b = spoken_words(ref), spoken_words(hyp)
    prev = list(range(len(b) + 1))
    for i, p in enumerate(a, 1):
        cur = [i]
        for j, q in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (p != q)))
        prev = cur
    return prev[-1], len(a)


def wer(ref: str, hyp: str) -> float:
    e, n = _errors(ref, hyp)
    return e / n if n else float(bool(spoken_words(hyp)))


def corpus_wer(pairs: list[tuple[str, str]]) -> float:
    e = n = 0
    for r, h in pairs:
        a, b = _errors(r, h)
        e, n = e + a, n + b
    return e / n if n else 0.0

CRITICAL = {"ref", "ref_and_name", "ambiguous_time"}


def rss_mb() -> float:
    import psutil

    return psutil.Process().memory_info().rss / 1e6


def decode_streaming(rec: SherpaRecognizer, audio: np.ndarray) -> tuple[str, float]:
    x = np.concatenate([np.zeros(4800, np.float32), audio, np.zeros(16000, np.float32)])
    s = rec.create_stream()
    for i in range(0, x.size, 1600):
        s.accept(x[i : i + 1600])
    t0 = time.perf_counter()
    text = s.finish().text
    return text, (time.perf_counter() - t0) * 1000


def decode_offline(rec: OfflineRecognizer, audio: np.ndarray) -> tuple[str, float]:
    t0 = time.perf_counter()
    text = rec.transcribe(audio)
    return text, (time.perf_counter() - t0) * 1000


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--captures", action="store_true", help="also score labelled captures from diagnostics/ (real microphone audio)")
    ap.add_argument("--models", nargs="*", default=None, help="offline models to compare (default: all installed)")
    args = ap.parse_args(argv)

    tts = SherpaTts()
    fx = fixtures.build(tts)
    clips = [(f.name, f.condition, f.audio, f.reference) for f in fx]
    if args.captures:
        from app.observability.diagnostics import DIAG_DIR

        for meta in sorted(DIAG_DIR.glob("*.json")):
            d = json.loads(meta.read_text(encoding="utf-8"))
            if d.get("reference"):
                clips.append((f"capture.{meta.stem}", "capture", read_wav_mono16k(meta.with_suffix(".wav")), d["reference"]))
    base = SherpaRecognizer()
    base.warm_up()
    for name, audio, ref in load_clips(base.spec.folder):
        clips.append((f"librispeech.{name}", "real_speech", audio, ref))

    engines: dict[str, tuple[object, object]] = {base.name: (base, decode_streaming)}
    load: dict[str, float] = {base.name: base.load_seconds}
    for key in args.models or list(OFFLINE_MODELS):
        try:
            before = rss_mb()
            r = OfflineRecognizer(key)
            r.warm_up()
            load[r.name] = r.load_seconds
            print(f"loaded {r.name} in {r.load_seconds:.1f}s (+{rss_mb() - before:.0f} MB)")
            engines[r.name] = (r, decode_offline)
        except MissingModelError as e:
            print(f"skipped {key}: {e}")

    rows: dict[str, list[dict]] = {name: [] for name in engines}
    for clip, cond, audio, ref in clips:
        for name, (rec, fn) in engines.items():
            text, ms = fn(rec, audio)
            rows[name].append(
                {"clip": clip, "cond": cond, "ref": ref, "got": text, "ms": ms, "audio_s": audio.size / 16000,
                 "critical": clip.split(".")[0] in CRITICAL}
            )

    summary = {}
    for name, rs in rows.items():
        conds: dict[str, list[dict]] = defaultdict(list)
        for r in rs:
            conds[r["cond"]].append(r)
        crit = [r for r in rs if r["critical"]]
        # Field-level accuracy: the booking reference / the two clock times must be heard exactly.
        fields = [r for r in rs if r["clip"].split(".")[0] in ("ref", "ref_and_name")]
        times = [r for r in rs if r["clip"].split(".")[0] == "ambiguous_time"]

        def has(r: dict, phrase: str) -> bool:
            h, p = " ".join(spoken_words(r["got"])), " ".join(spoken_words(phrase))
            return p in h
        summary[name] = {
            "load_s": round(load[name], 2),
            "wer_all": round(corpus_wer([(r["ref"], r["got"]) for r in rs]), 3),
            "wer_by_condition": {c: round(corpus_wer([(r["ref"], r["got"]) for r in g]), 3) for c, g in conds.items()},
            "critical_exact": round(sum(wer(r["ref"], r["got"]) == 0 for r in crit) / max(1, len(crit)), 3),
            "critical_n": len(crit),
            "booking_ref_exact": round(sum(has(r, "s k one zero zero " + ("two" if "two" in r["ref"].lower().split("zero")[-1][:5] else "one")) for r in fields) / max(1, len(fields)), 3),
            "times_exact": round(sum(has(r, "three fifty") and has(r, "five fifteen") for r in times) / max(1, len(times)), 3),
            "decode_ms_p50": round(statistics.median(r["ms"] for r in rs)),
            "decode_ms_p95": round(sorted(r["ms"] for r in rs)[int(0.95 * (len(rs) - 1))]),
            "rtf": round(sum(r["ms"] for r in rs) / 1000 / sum(r["audio_s"] for r in rs), 3),
        }
    out = Path(__file__).resolve().parent / "results"
    out.mkdir(exist_ok=True)
    (out / "model_bench.json").write_text(json.dumps({"summary": summary, "rows": rows}, indent=1), encoding="utf-8")

    conds = sorted({r["cond"] for r in next(iter(rows.values()))})
    print(f"\n{'model':38} " + " ".join(f"{c[:9]:>9}" for c in conds) + f" {'ALL':>6} {'crit':>6} {'p50ms':>6} {'p95ms':>6} {'RTF':>6}")
    for name, s in summary.items():
        print(f"{name:38} " + " ".join(f"{s['wer_by_condition'].get(c, float('nan')):9.3f}" for c in conds)
              + f" {s['wer_all']:6.3f} {s['critical_exact']:6.2f} ref={s['booking_ref_exact']:.2f} time={s['times_exact']:.2f} {s['decode_ms_p50']:6} {s['decode_ms_p95']:6} {s['rtf']:6.3f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
