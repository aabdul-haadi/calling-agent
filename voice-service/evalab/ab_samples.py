"""Side-by-side listening samples: the previous voice experience against the current one.

    python -m evalab.ab_samples

Writes evalab/results/ab/NN_before.wav and NN_after.wav plus a ratings sheet. "Before" is the old
default voice (Piper amy-low), the old robotic phrasing and phrases joined exactly as synthesized.
"After" is the current default voice, the conversational phrasing, the spoken-rendering layer
(times, money, codes) and the pacing layer. The texts are the style examples from the task: only the
audio is generated here, so the comparison isolates wording, rendering and voice together.
Ratings are for a person to fill in; nothing here scores naturalness.
"""

from __future__ import annotations

import sys
import threading
import time
from pathlib import Path

import numpy as np

from app.config import load_settings
from app.tts.pacing import Pacer
from app.tts.streaming import SherpaTts
from app.tts.text import Chunker, speakable
from evalab.tts_bench import write_wav

PAIRS = [
    ("Your request has been successfully processed.", "All set. I've updated your booking."),
    ("Please provide the required booking reference number.", "Could you give me your booking reference?"),
    ("I apologize for the inconvenience caused.", "Sorry about that. Let me check what happened."),
    ("There are three available alternatives that satisfy your criteria.",
     "I found three alternatives. Would you like to hear them?"),
    ("I can move booking SK1001 from flight SK100 to flight SK110 departing on 2026-11-10T11:00:00Z at no charge. "
     "Please reply yes to confirm.",
     "I can move you to flight SK110, leaving November 10 at 11:00 AM, with no charge. Do you want me to go ahead?"),
    ("Your bill is $58.00 this month. This includes the $40.00 plan charge and an $18.00 roaming charge.",
     "Your bill is $58 this month. That's the $40 plan plus an $18 roaming charge."),
]


def phrases(text: str, rendered: bool) -> list[str]:
    chunker = Chunker()
    out = chunker.push(text) + chunker.flush()
    return [speakable(p) if rendered else p for p in out]


def render(tts: SherpaTts, text: str, *, new: bool, speaker: str | None = None) -> np.ndarray:
    parts: list[np.ndarray] = []
    for phrase in phrases(text, rendered=new):
        if new:
            pacer = Pacer(lambda a: parts.append(a) or True, tts.sample_rate, phrase, last_phrase=False,
                          sentence_ms=160, clause_ms=60)
            tts.synthesize(phrase, pacer, threading.Event(), speaker=speaker)
            pacer.finish()
        else:
            tts.synthesize(phrase, lambda a: parts.append(a) or True, threading.Event())
    return np.concatenate(parts) if parts else np.zeros(0, np.float32)


def main() -> int:
    s = load_settings()
    out = Path(__file__).resolve().parent / "results" / "ab"
    before_tts = SherpaTts("piper-amy-low", 4)
    after_tts = SherpaTts(s.tts_model, 4)
    sheet = ["# A/B listening sheet (a person fills this in; 1 = robotic, 5 = natural)", "",
             f"before = piper-amy-low, old wording. after = {s.tts_model}, new wording, rendering and pacing.", "",
             "| # | before text | after text | better (A/B) | before 1-5 | after 1-5 | notes |", "| --- | --- | --- | --- | --- | --- | --- |"]
    for i, (old, new) in enumerate(PAIRS, 1):
        t0 = time.perf_counter()
        write_wav(out / f"{i:02d}_before.wav", render(before_tts, old, new=False), before_tts.sample_rate)
        write_wav(out / f"{i:02d}_after.wav", render(after_tts, new, new=True), after_tts.sample_rate)
        sheet.append(f"| {i} | {old} | {new} |  |  |  |  |")
        print(f"{i:02d} rendered in {time.perf_counter() - t0:.1f}s")
    (out / "ab_listening_sheet.md").write_text("\n".join(sheet), encoding="utf-8")
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
