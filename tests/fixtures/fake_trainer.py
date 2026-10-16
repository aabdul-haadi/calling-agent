"""A stand-in for ml/train_sft.py used by the job-lifecycle tests.

`check` and `hardware` are the real ones (the dataset rules are what is being tested). `train` does no
learning: it counts steps slowly enough to be cancelled, writes the same files and progress lines the
real trainer writes, and honours --cancel-file and --resume.
"""

import argparse
import hashlib
import importlib.util
import json
import os
import sys
import time
from pathlib import Path

REAL = Path(__file__).resolve().parents[2] / "ml" / "train_sft.py"
spec = importlib.util.spec_from_file_location("real_trainer", REAL)
real = importlib.util.module_from_spec(spec)
sys.modules["real_trainer"] = real
spec.loader.exec_module(real)


def main() -> int:
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd in ("check", "hardware"):
        return real.main()
    p = argparse.ArgumentParser()
    p.add_argument("cmd")
    p.add_argument("dataset", nargs="?")
    p.add_argument("--manifest")
    p.add_argument("--eval")
    p.add_argument("--out")
    p.add_argument("--base", default="fake/base")
    p.add_argument("--progress")
    p.add_argument("--cancel-file", dest="cancel_file")
    p.add_argument("--resume", action="store_true")
    p.add_argument("--steps", type=int, default=int(os.environ.get("FAKE_STEPS", "6")))
    a, _ = p.parse_known_args()
    if a.cmd == "smoke":
        print(json.dumps({"status": "done", "smokeOnly": True}))
        return 0
    out = Path(a.out)
    (out / "adapter").mkdir(parents=True, exist_ok=True)
    marker = out / "checkpoints" / "step.txt"
    start = int(marker.read_text()) if a.resume and marker.exists() else 0
    delay = float(os.environ.get("FAKE_STEP_SECONDS", "0.2"))
    print(json.dumps({"event": "start", "examples": 0, "resumedFrom": start or None}), flush=True)
    for step in range(start + 1, a.steps + 1):
        time.sleep(delay)
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(str(step))
        print(json.dumps({"event": "step", "step": step, "of": a.steps, "loss": round(2.0 / step, 3)}), flush=True)
        if a.cancel_file and Path(a.cancel_file).exists():
            print(json.dumps({"event": "cancelled", "step": step}), flush=True)
            return 0
    weights = out / "adapter" / "adapter_model.safetensors"
    weights.write_bytes(b"fake-adapter-weights")
    meta = {
        "status": "done", "base": a.base, "examples": 0, "steps": a.steps, "trainLoss": 0.5, "validationLoss": 0.6,
        "seconds": a.steps * delay, "adapterSha256": hashlib.sha256(weights.read_bytes()).hexdigest(), "artifactLoads": True,
    }
    (out / "training.json").write_text(json.dumps(meta), encoding="utf-8")
    print(json.dumps({"event": "done", **{k: meta[k] for k in ("steps", "trainLoss", "validationLoss", "seconds", "adapterSha256")}}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
