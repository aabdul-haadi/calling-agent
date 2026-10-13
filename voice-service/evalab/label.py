"""Add the correct text to captured turns (VOICE_DIAGNOSTICS=1), so they can be scored.

    python -m evalab.label            # shows each unlabelled capture with what each model heard
Type exactly what you SAID (blank = skip, 'q' = quit). Nothing is guessed from a model's output.
"""

from __future__ import annotations

import json

from app.observability.diagnostics import DIAG_DIR


def main() -> int:
    for meta in sorted(DIAG_DIR.glob("*.json")):
        d = json.loads(meta.read_text(encoding="utf-8"))
        if d.get("reference"):
            continue
        print(f"\n{meta.stem}  {d['audio'].get('seconds')} s  rms {d['audio'].get('rms')}  clipped {d['audio'].get('clipped_fraction')}")
        print(f"  streaming heard: {d.get('streaming')}\n  accurate heard : {d.get('final')}")
        ref = input("  what you said > ").strip()
        if ref.lower() == "q":
            break
        if ref:
            d["reference"] = ref
            meta.write_text(json.dumps(d, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
