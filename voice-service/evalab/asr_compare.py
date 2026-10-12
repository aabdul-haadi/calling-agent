"""Compare the available streaming recognizers on the real LibriSpeech clips shipped inside each
model archive (each clip comes with its reference transcript in test_wavs/trans.txt).

    python -m evalab.asr_compare

Reports corpus WER, time to the first partial (audio seconds until the first non-empty partial),
time to final after the last audio chunk, real-time factor and load time. Only models that are
installed are compared. Three short clips are a sanity check, not a statistical benchmark.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np

from app.asr.streaming import ASR_MODELS, MissingModelError, SherpaRecognizer
from app.config import MODELS_DIR
from evalab.metrics import corpus_wer, read_wav_mono16k, wer

CHUNK_S = 0.1  # how the browser delivers audio: 100 ms at a time


def load_clips(folder: str) -> list[tuple[str, np.ndarray, str]]:
    wavs = MODELS_DIR / folder / "test_wavs"
    refs: dict[str, str] = {}
    trans = wavs / "trans.txt"
    if trans.exists():
        for line in trans.read_text(encoding="utf-8").splitlines():
            name, _, text = line.partition(" ")
            refs[name] = text
    clips = []
    for name, text in sorted(refs.items()):
        if name.startswith("8k") or not (wavs / name).exists():
            continue
        clips.append((name, read_wav_mono16k(wavs / name), text))
    return clips


def run_clip(rec: SherpaRecognizer, audio: np.ndarray) -> dict:
    step = int(CHUNK_S * rec.sample_rate)
    s = rec.create_stream()
    first_partial_at = None
    t_decode = 0.0
    for i in range(0, audio.size, step):
        t0 = time.perf_counter()
        s.accept(audio[i : i + step])
        text = s.partial()
        t_decode += time.perf_counter() - t0
        if text and first_partial_at is None:
            first_partial_at = (i + step) / rec.sample_rate
    t0 = time.perf_counter()
    final = s.finish()
    final_ms = (time.perf_counter() - t0) * 1000
    return {
        "final": final,
        "first_partial_audio_s": first_partial_at,
        "final_ms_after_last_chunk": round(final_ms, 1),
        "rtf": round(t_decode / (audio.size / rec.sample_rate), 3),
    }


def main() -> int:
    results = []
    for key, spec in ASR_MODELS.items():
        try:
            rec = SherpaRecognizer(key)
        except MissingModelError:
            print(f"- {key}: not installed, skipped", file=sys.stderr)
            continue
        rec.warm_up()
        clips = load_clips(spec.folder)
        runs = [(n, ref, run_clip(rec, audio)) for n, audio, ref in clips]
        results.append(
            {
                "model": key,
                "description": spec.description,
                "load_s": round(rec.load_seconds, 2),
                "clips": len(runs),
                "corpus_wer": round(corpus_wer([(ref, r["final"]) for _, ref, r in runs]), 3),
                "per_clip": [
                    {"clip": n, "wer": round(wer(ref, r["final"]), 3), "rtf": r["rtf"], "final_ms": r["final_ms_after_last_chunk"]}
                    for n, ref, r in runs
                ],
                "first_partial_audio_s": [r["first_partial_audio_s"] for _, _, r in runs],
            }
        )
    print(json.dumps(results, indent=1))
    out = Path(__file__).resolve().parents[1] / "evalab" / "results"
    out.mkdir(exist_ok=True)
    (out / "asr_compare.json").write_text(json.dumps(results, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
