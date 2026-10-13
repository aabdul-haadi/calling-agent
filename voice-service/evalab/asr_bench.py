"""Speech recognition benchmark on the generated fixtures plus the real clips.

    python -m evalab.asr_bench

Reports, per condition: corpus WER, the transcript confidence distribution, partial transcript
stability, time to the first partial and time to the final after the last chunk. Writes
evalab/results/asr_bench.json.
"""

from __future__ import annotations

import json
import statistics
import sys
import time
from collections import defaultdict
from pathlib import Path

import numpy as np

from app.asr.streaming import SherpaRecognizer
from app.observability.stats import percentile, summarize
from app.tts.streaming import SherpaTts
from evalab import fixtures
from evalab.asr_compare import load_clips
from evalab.metrics import corpus_wer, normalize_words, wer

CHUNK = 1600  # 100 ms, like the browser sends


def run(rec: SherpaRecognizer, audio: np.ndarray, lead: float = 0.3, tail: float = 1.0) -> dict:
    """Feed one clip in 100 ms pieces (with silence around it) and record what the recognizer does."""
    x = np.concatenate([np.zeros(int(16000 * lead), np.float32), audio, np.zeros(int(16000 * tail), np.float32)])
    onset = lead
    s = rec.create_stream()
    partials: list[tuple[float, str]] = []
    first = None
    for i in range(0, x.size, CHUNK):
        s.accept(x[i : i + CHUNK])
        text = s.partial()
        at = (i + CHUNK) / 16000
        if text and (not partials or partials[-1][1] != text):
            partials.append((at, text))
            if first is None:
                first = at - onset
    t0 = time.perf_counter()
    final = s.finish()
    return {
        "text": final.text,
        "confidence": final.confidence,
        "weakest": final.weakest,
        "first_partial_s": first,
        "final_ms": (time.perf_counter() - t0) * 1000,
        "stability": stability([p for _, p in partials]),
        "partials": len(partials),
    }


def stability(partials: list[str]) -> float:
    """Share of partial updates that only extend the previous one (no earlier word was rewritten).
    1.0 means the text on screen never changes under the reader's eyes."""
    if len(partials) < 2:
        return 1.0
    stable = 0
    for prev, cur in zip(partials, partials[1:]):
        a, b = normalize_words(prev), normalize_words(cur)
        stable += b[: len(a)] == a
    return stable / (len(partials) - 1)


def main() -> int:
    rec = SherpaRecognizer()
    rec.warm_up()
    tts = SherpaTts()
    fx = fixtures.build(tts)
    fixtures.write_manifest(fx)

    rows: list[dict] = []
    for f in fx:
        rows.append({"clip": f.name, "condition": f.condition, "ref": f.reference, "r": run(rec, f.audio)})
    for name, audio, ref in load_clips(rec.spec.folder):  # real recordings
        rows.append({"clip": f"librispeech.{name}", "condition": "real_speech", "ref": ref, "r": run(rec, audio)})

    by_cond: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        by_cond[row["condition"]].append(row)

    table = []
    for cond, group in by_cond.items():
        pairs = [(g["ref"], g["r"]["text"]) for g in group]
        conf = [g["r"]["confidence"] for g in group if g["r"]["text"]]
        table.append(
            {
                "condition": cond,
                "clips": len(group),
                "wer": round(corpus_wer(pairs), 3),
                "exact": round(sum(wer(a, b) == 0 for a, b in pairs) / len(pairs), 2),
                "confidence_mean": round(statistics.fmean(conf), 3) if conf else None,
                "stability": round(statistics.fmean(g["r"]["stability"] for g in group), 3),
                "first_partial_s": summarize([g["r"]["first_partial_s"] * 1000 for g in group if g["r"]["first_partial_s"] is not None]),
                "final_ms": summarize([g["r"]["final_ms"] for g in group]),
            }
        )

    # Is the recognizer's own confidence a useful alarm? For each threshold: how many correct
    # transcripts would be flagged (annoying) and how many wrong ones (WER > 20%) would be caught.
    talking = [g for g in rows if g["r"]["text"]]
    right = [g for g in talking if wer(g["ref"], g["r"]["text"]) == 0]
    wrong = [g for g in talking if wer(g["ref"], g["r"]["text"]) > 0.2]
    tradeoff = []
    for thr in (0.2, 0.3, 0.4, 0.5, 0.6, 0.7):
        tradeoff.append({
            "threshold": thr,
            "correct_flagged": round(sum(g["r"]["confidence"] < thr for g in right) / max(1, len(right)), 2),
            "wrong_caught": round(sum(g["r"]["confidence"] < thr for g in wrong) / max(1, len(wrong)), 2),
        })
    calibration = {"right_n": len(right), "wrong_n": len(wrong), "tradeoff": tradeoff}
    clips = [
        {"clip": g["clip"], "ref": g["ref"], "got": g["r"]["text"], "wer": round(wer(g["ref"], g["r"]["text"]), 3),
         "confidence": round(g["r"]["confidence"], 3), "weakest": round(g["r"]["weakest"], 3)}
        for g in rows
    ]
    result = {"model": rec.name, "chunk_ms": 100, "table": table, "calibration": calibration, "clips": clips}
    out = Path(__file__).resolve().parent / "results"
    out.mkdir(exist_ok=True)
    (out / "asr_bench.json").write_text(json.dumps(result, indent=1), encoding="utf-8")

    print(f"{'condition':12} {'clips':>5} {'WER':>6} {'exact':>6} {'conf':>6} {'stab':>6} {'1st partial ms (p50/p95)':>26} {'final ms (p50/p95)':>20}")
    for r in table:
        fp, fm = r["first_partial_s"], r["final_ms"]
        print(f"{r['condition']:12} {r['clips']:5} {r['wer']:6.3f} {r['exact']:6.2f} {str(r['confidence_mean']):>6} {r['stability']:6.3f} "
              f"{fp.get('p50', '-'):>12}/{fp.get('p95', '-'):<12} {fm.get('p50', '-'):>9}/{fm.get('p95', '-'):<9}")

    print("\nconfidence as an alarm (correct transcripts flagged / wrong transcripts caught):")
    for t in tradeoff:
        print(
            f"  below {t['threshold']}: {t['correct_flagged']:.0%} of correct flagged, "
            f"{t['wrong_caught']:.0%} of wrong caught"
        )
    print(f"\nsamples: {len(right)} exactly-right, {len(wrong)} wrong")
    print("\nworst clean-condition clips:")
    clean = [c for c in clips if c["clip"].endswith(".clean")]
    for c in sorted(clean, key=lambda c: -c["wer"])[:6]:
        print(f"  WER {c['wer']:.2f} conf {c['confidence']:.2f}")
        print(f"    REF: {c['ref']}")
        print(f"    GOT: {c['got']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
