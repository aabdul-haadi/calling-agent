#!/usr/bin/env python3
"""Supervised fine-tuning (LoRA) on a frozen, reviewed dataset exported from the Learning console.

    python ml/train_sft.py hardware [--base MODEL]
    python ml/train_sft.py check  DATASET.jsonl --manifest MANIFEST.json [--eval EVAL.jsonl]
    python ml/train_sft.py smoke  [--base MODEL]
    python ml/train_sft.py train  DATASET.jsonl --manifest MANIFEST.json --out DIR [options]

`hardware` and `check` need only the standard library (and report what is missing). `smoke` and
`train` need torch, transformers, peft and datasets (see docs/MACHINE_LEARNING.md; `ml/.venv` holds a
CPU-only install). `check` refuses a dataset that is too small, does not match its recorded hash,
contains personal data or secrets, mixes in held-out evaluation examples, or teaches a reply to skip a
safety step. `train` runs the same checks first.

`smoke` trains for a few steps on a tiny synthetic fixture to prove the toolchain works. Its output is
never a candidate: only `train` on a dataset that passed `check` can produce one.

Nothing here deploys anything. A trained adapter is a candidate: it must pass the evaluation suite and
be released from the Learning console like every other change.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import signal
import sys
import tempfile
import time
from pathlib import Path

MIN_EXAMPLES_DEFAULT = 200
DEFAULT_BASE = "Qwen/Qwen2.5-0.5B-Instruct"  # Apache-2.0; 0.5B parameters; runs on a CPU
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
PHONE = re.compile(r"\+?\(?\d[\d\s().-]{7,}\d")
REFERENCE = re.compile(r"\b[A-Z]{2}\s?\d{4,6}\b")
SECRET = re.compile(r"\b(?:password|passcode|pin(?:\s+code)?|cvv|cvc|otp|security code|card number)\b", re.I)
UNSAFE = re.compile(r"\b(?:skip|no need for|without|bypass)\b[^.]{0,30}\b(?:verif\w+|confirm\w*|identity|approval)\b", re.I)
NORMALIZE = re.compile(r"[^a-z0-9\s]")

# Approximate bytes per parameter while training with LoRA in float32 (weights + activations headroom).
BYTES_PER_PARAM_FP32 = 4
KNOWN_PARAMS_B = {"Qwen/Qwen2.5-0.5B-Instruct": 0.5, "HuggingFaceTB/SmolLM2-135M-Instruct": 0.135, "Qwen/Qwen2.5-1.5B-Instruct": 1.5, "HuggingFaceTB/SmolLM2-360M-Instruct": 0.36}


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", NORMALIZE.sub(" ", re.sub(r"\[[a-z_]+\]", " ", text.lower()))).strip()


def user_of(row: dict) -> str:
    return next((m["content"] for m in reversed(row.get("messages") or []) if m.get("role") == "user"), "")


def load_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


# ---- hardware ---------------------------------------------------------------------------------


def total_ram_gb() -> float | None:
    try:
        import psutil  # type: ignore

        return psutil.virtual_memory().total / 2**30
    except Exception:  # noqa: BLE001
        pass
    if os.name == "nt":
        try:
            import ctypes

            class MS(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong), ("ullTotalPhys", ctypes.c_ulonglong),
                            ("ullAvailPhys", ctypes.c_ulonglong), ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong), ("sullAvailExtendedVirtual", ctypes.c_ulonglong)]

            s = MS()
            s.dwLength = ctypes.sizeof(MS)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(s))  # type: ignore[attr-defined]
            return s.ullTotalPhys / 2**30
        except Exception:  # noqa: BLE001
            return None
    try:
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 2**30
    except Exception:  # noqa: BLE001
        return None


def available_ram_gb() -> float | None:
    try:
        import psutil  # type: ignore

        return psutil.virtual_memory().available / 2**30
    except Exception:  # noqa: BLE001
        return None


def hardware(base: str) -> dict:
    info: dict = {"os": platform.platform(), "python": platform.python_version(), "cpuThreads": os.cpu_count(), "ramGb": total_ram_gb(),
                  "ramAvailableGb": available_ram_gb(),
                  "libraries": {}, "gpu": None, "base": base}
    for lib in ("torch", "transformers", "peft", "datasets", "accelerate"):
        try:
            mod = __import__(lib)
            info["libraries"][lib] = getattr(mod, "__version__", "installed")
        except Exception:  # noqa: BLE001
            info["libraries"][lib] = None
    try:
        import torch  # type: ignore

        if torch.cuda.is_available():
            major, minor = torch.cuda.get_device_capability(0)
            info["gpu"] = {"name": torch.cuda.get_device_name(0), "capabilityMajor": major, "capabilityMinor": minor,
                           "memoryGb": torch.cuda.get_device_properties(0).total_memory / 2**30}
    except Exception:  # noqa: BLE001
        pass
    params_b = KNOWN_PARAMS_B.get(base)
    need_gb = round(params_b * BYTES_PER_PARAM_FP32 * 1.8, 1) if params_b else None  # weights plus activations and optimizer state of the adapter
    info["estimatedTrainingMemoryGb"] = need_gb
    missing = [k for k, v in info["libraries"].items() if v is None]
    if missing:
        verdict, why = "not_ready", f"missing libraries: {', '.join(missing)}"
    elif info["gpu"] and info["gpu"]["memoryGb"] >= (need_gb or 99) / 2:
        verdict, why = "gpu", "a usable GPU was found"
    elif (info["ramAvailableGb"] or info["ramGb"] or 0) >= (need_gb or 99):
        verdict, why = "cpu_slow", f"no usable GPU; the CPU has enough free memory (needs about {need_gb} GB) but training is slow (seconds to minutes per step)"
    else:
        free = info["ramAvailableGb"] or info["ramGb"]
        verdict, why = "not_ready", f"only {free:.1f} GB of memory is free and this model needs about {need_gb} GB while training: close other programs, choose a smaller base, or train on another machine"
    info["verdict"] = verdict
    info["reason"] = why
    return info


# ---- dataset checks ---------------------------------------------------------------------------


def problems(rows: list[dict], manifest: dict, text: str, held_out: set[str]) -> list[str]:
    out: list[str] = []
    minimum = int(manifest.get("minExamples", MIN_EXAMPLES_DEFAULT))
    if len(rows) < minimum:
        out.append(f"only {len(rows)} examples; the recorded minimum is {minimum}. Gather more approved examples; do not pad the dataset.")
    recorded = manifest.get("sha256")
    if recorded and hashlib.sha256(text.encode("utf-8")).hexdigest() != recorded:
        out.append("the file does not match the hash recorded when the dataset was frozen")
    seen: set[str] = set()
    for i, row in enumerate(rows, 1):
        msgs = row.get("messages") or []
        if not msgs or msgs[-1].get("role") != "assistant" or not msgs[-1].get("content", "").strip():
            out.append(f"line {i}: the last message must be the approved assistant reply")
            continue
        user = user_of(row)
        reply = msgs[-1]["content"]
        blob = "\n".join(m.get("content", "") for m in msgs)
        for name, pattern in (("an email address", EMAIL), ("a phone number", PHONE), ("a reference number", REFERENCE), ("a secret", SECRET)):
            if pattern.search(blob):
                out.append(f"line {i}: contains {name}")
        if UNSAFE.search(reply):
            out.append(f"line {i}: the reply tells the customer a safety step can be skipped")
        if normalize(user) in held_out:
            out.append(f"line {i}: this question is in the evaluation set")
        key = normalize(user) + "|" + normalize(reply)
        if key in seen:
            out.append(f"line {i}: duplicate example")
        seen.add(key)
    return out


def check_files(dataset: str, manifest_path: str, eval_path: str | None) -> tuple[list[dict], list[str], str]:
    text = Path(dataset).read_text(encoding="utf-8")
    rows = [json.loads(line) for line in text.splitlines() if line.strip()]
    manifest = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    held = {normalize(user_of(r)) for r in load_jsonl(Path(eval_path))} if eval_path else set()
    return rows, problems(rows, manifest, text, held), text


def cmd_check(args: argparse.Namespace) -> int:
    rows, found, _ = check_files(args.dataset, args.manifest, args.eval)
    by_channel: dict[str, int] = {}
    for r in rows:
        ch = r.get("metadata", {}).get("channel", "chat")
        by_channel[ch] = by_channel.get(ch, 0) + 1
    print(json.dumps({"examples": len(rows), "byChannel": by_channel, "problems": found[:20], "problemCount": len(found)}, indent=1))
    return 0 if not found else 1


# ---- training ---------------------------------------------------------------------------------


def split_validation(rows: list[dict], fraction: float) -> tuple[list[dict], list[dict]]:
    """A fixed share of questions is held back for validation; the same question always lands on the same side."""
    if fraction <= 0:
        return rows, []
    cut = int(fraction * 1000)
    val = [r for r in rows if int(hashlib.sha256(normalize(user_of(r)).encode()).hexdigest()[:8], 16) % 1000 < cut]
    train = [r for r in rows if r not in val]
    return train, val


def run_training(rows: list[dict], *, base: str, out: Path, epochs: float, seed: int, lr: float, rank: int, max_len: int,
                 batch: int, accum: int, val_fraction: float, progress: Path | None, resume: bool, max_steps: int, threads: int | None,
                 cancel_file: Path | None = None) -> dict:
    import torch  # type: ignore
    from datasets import Dataset  # type: ignore
    from peft import LoraConfig, PeftModel, get_peft_model  # type: ignore
    from transformers import AutoModelForCausalLM, AutoTokenizer, Trainer, TrainerCallback, TrainingArguments, set_seed  # type: ignore

    if threads:
        torch.set_num_threads(threads)
    set_seed(seed)
    started = time.time()
    out.mkdir(parents=True, exist_ok=True)

    def emit(event: str, **fields) -> None:
        line = json.dumps({"event": event, "t": round(time.time() - started, 1), **fields})
        print(line, flush=True)
        if progress:
            with progress.open("a", encoding="utf-8") as f:
                f.write(line + "\n")

    tok = AutoTokenizer.from_pretrained(base)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    model = AutoModelForCausalLM.from_pretrained(base, torch_dtype=torch.float32)
    model = get_peft_model(model, LoraConfig(r=rank, lora_alpha=2 * rank, lora_dropout=0.05, task_type="CAUSAL_LM", target_modules="all-linear"))
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    train_rows, val_rows = split_validation(rows, val_fraction)

    def encode(row: dict) -> dict:
        # Loss only on the final assistant reply: the customer's words and earlier turns are context.
        context = tok.apply_chat_template(row["messages"][:-1], tokenize=False, add_generation_prompt=True)
        full = context + row["messages"][-1]["content"] + (tok.eos_token or "")
        ids = tok(full, truncation=True, max_length=max_len)["input_ids"]
        n_ctx = min(len(tok(context)["input_ids"]), len(ids))
        return {"input_ids": ids, "labels": [-100] * n_ctx + ids[n_ctx:]}

    def collate(items: list[dict]) -> dict:
        width = max(len(b["input_ids"]) for b in items)
        pad = tok.pad_token_id
        return {
            "input_ids": torch.tensor([b["input_ids"] + [pad] * (width - len(b["input_ids"])) for b in items]),
            "labels": torch.tensor([b["labels"] + [-100] * (width - len(b["labels"])) for b in items]),
            "attention_mask": torch.tensor([[1] * len(b["input_ids"]) + [0] * (width - len(b["input_ids"])) for b in items]),
        }

    data = Dataset.from_list([encode(r) for r in train_rows])
    val = Dataset.from_list([encode(r) for r in val_rows]) if val_rows else None
    stop = {"flag": False}

    class Watch(TrainerCallback):
        def on_log(self, a, state, control, logs=None, **kw):  # noqa: ANN001
            if logs and "loss" in logs:
                emit("step", step=state.global_step, of=state.max_steps, loss=round(float(logs["loss"]), 4))

        def on_step_end(self, a, state, control, **kw):  # noqa: ANN001
            if cancel_file is not None and cancel_file.exists():
                stop["flag"] = True
            if stop["flag"]:
                control.should_save = True
                control.should_training_stop = True
            return control

    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.__setitem__("flag", True))

    ckpt = out / "checkpoints"
    args = TrainingArguments(output_dir=str(ckpt), num_train_epochs=epochs, max_steps=max_steps if max_steps > 0 else -1,
                             per_device_train_batch_size=batch, gradient_accumulation_steps=accum, learning_rate=lr, logging_steps=1,
                             save_strategy="steps", save_steps=25, save_total_limit=2, seed=seed, data_seed=seed, report_to=[],
                             eval_strategy="no", use_cpu=not torch.cuda.is_available(), dataloader_num_workers=0)
    trainer = Trainer(model=model, args=args, train_dataset=data, data_collator=collate, callbacks=[Watch()])
    last = None
    if resume and ckpt.exists():
        found = sorted(ckpt.glob("checkpoint-*"), key=lambda p: int(p.name.split("-")[1]))
        last = str(found[-1]) if found else None
    emit("start", examples=len(train_rows), validation=len(val_rows), trainable=trainable, resumedFrom=last)
    result = trainer.train(resume_from_checkpoint=last)
    cancelled = stop["flag"]
    val_loss = None
    if val is not None and not cancelled:
        model.eval()
        losses = []
        with torch.no_grad():
            for i in range(0, len(val), batch):
                b = collate([val[j] for j in range(i, min(i + batch, len(val)))])
                losses.append(float(model(**b).loss))
        val_loss = round(sum(losses) / len(losses), 4)
    if cancelled:
        emit("cancelled", step=trainer.state.global_step)
        return {"status": "cancelled", "step": trainer.state.global_step, "checkpointDir": str(ckpt)}

    adapter = out / "adapter"
    model.save_pretrained(adapter)
    tok.save_pretrained(adapter)
    # The artifact must load and produce text before it is called a candidate.
    reloaded = PeftModel.from_pretrained(AutoModelForCausalLM.from_pretrained(base, torch_dtype=torch.float32), adapter)
    probe = tok("Hello", return_tensors="pt")
    generated = reloaded.generate(**probe, max_new_tokens=4, do_sample=False)
    ok = generated.shape[-1] > probe["input_ids"].shape[-1]
    digest = hashlib.sha256((adapter / "adapter_model.safetensors").read_bytes()).hexdigest()
    try:
        import resource  # type: ignore

        peak_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
    except Exception:  # noqa: BLE001
        try:
            import psutil  # type: ignore

            peak_mb = psutil.Process().memory_info().peak_wset / 2**20  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001
            peak_mb = None
    meta = {
        "status": "done" if ok else "invalid",
        "base": base, "baseLicense": "Apache-2.0 (Qwen2.5-0.5B-Instruct)" if "Qwen2.5" in base else "see the model card",
        "examples": len(train_rows), "validationExamples": len(val_rows), "epochs": epochs, "seed": seed, "learningRate": lr, "loraRank": rank,
        "steps": trainer.state.global_step, "trainLoss": round(float(result.training_loss), 4), "validationLoss": val_loss,
        "seconds": round(time.time() - started, 1), "peakMemoryMb": round(peak_mb) if peak_mb else None, "device": "cuda" if torch.cuda.is_available() else "cpu",
        "adapterSha256": digest, "artifactLoads": ok,
    }
    (out / "training.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
    emit("done", **{k: meta[k] for k in ("steps", "trainLoss", "validationLoss", "seconds", "adapterSha256")})
    return meta


def cmd_train(args: argparse.Namespace) -> int:
    rows, found, text = check_files(args.dataset, args.manifest, args.eval)
    if found:
        print(json.dumps({"status": "refused", "problems": found[:20]}, indent=1), file=sys.stderr)
        return 1
    hw = hardware(args.base)
    if hw["verdict"] == "not_ready":
        print(json.dumps({"status": "not_ready", "reason": hw["reason"]}, indent=1), file=sys.stderr)
        return 2
    meta = run_training(rows, base=args.base, out=Path(args.out), epochs=args.epochs, seed=args.seed, lr=args.lr, rank=args.rank, max_len=args.max_len,
                        batch=args.batch, accum=args.accum, val_fraction=args.val_fraction, progress=Path(args.progress) if args.progress else None,
                        resume=args.resume, max_steps=args.max_steps, threads=args.threads,
                        cancel_file=Path(args.cancel_file) if args.cancel_file else None)
    meta["datasetSha256"] = hashlib.sha256(text.encode("utf-8")).hexdigest()
    (Path(args.out) / "training.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
    return 0 if meta["status"] in ("done", "cancelled") else 1


# Synthetic, labelled as such, used only to prove the toolchain runs. Never registered as a candidate.
SMOKE = [
    ("What is the checked bag allowance?", "One checked bag is included on Economy fares."),
    ("Can I change my flight?", "Yes. Tell me the new date and I will check what is available."),
    ("How long does a refund take?", "Refunds to a card take about seven days."),
    ("Is there a fee to change?", "That depends on your fare. Do you know which fare you booked?"),
] * 3


def cmd_smoke(args: argparse.Namespace) -> int:
    hw = hardware(args.base)
    if hw["verdict"] == "not_ready":
        print(json.dumps({"status": "not_ready", "reason": hw["reason"], "hardware": hw}, indent=1))
        return 2
    rows = [{"messages": [{"role": "system", "content": "SMOKE TEST FIXTURE"}, {"role": "user", "content": q}, {"role": "assistant", "content": a}]} for q, a in SMOKE]
    with tempfile.TemporaryDirectory() as d:
        meta = run_training(rows, base=args.base, out=Path(d), epochs=1, seed=7, lr=2e-4, rank=8, max_len=256, batch=2, accum=1,
                            val_fraction=0, progress=None, resume=False, max_steps=args.steps, threads=args.threads)
    meta["smokeOnly"] = True
    print(json.dumps(meta, indent=1))
    return 0 if meta["status"] == "done" else 1


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    h = sub.add_parser("hardware")
    h.add_argument("--base", default=DEFAULT_BASE)
    for name in ("check", "train"):
        s = sub.add_parser(name)
        s.add_argument("dataset")
        s.add_argument("--manifest", required=True, help='JSON with {"sha256": "...", "minExamples": 200}')
        s.add_argument("--eval", help="JSONL of held-out evaluation examples that must not appear in the dataset")
        if name == "train":
            s.add_argument("--out", required=True)
            s.add_argument("--base", default=DEFAULT_BASE)
            s.add_argument("--epochs", type=float, default=2)
            s.add_argument("--seed", type=int, default=7)
            s.add_argument("--lr", type=float, default=2e-4)
            s.add_argument("--rank", type=int, default=16)
            s.add_argument("--max-len", type=int, default=768, dest="max_len")
            s.add_argument("--batch", type=int, default=2)
            s.add_argument("--accum", type=int, default=4)
            s.add_argument("--val-fraction", type=float, default=0.1, dest="val_fraction")
            s.add_argument("--progress", help="append JSON lines of progress to this file")
            s.add_argument("--resume", action="store_true", help="continue from the newest checkpoint in --out")
            s.add_argument("--max-steps", type=int, default=0, dest="max_steps")
            s.add_argument("--threads", type=int)
            s.add_argument("--cancel-file", dest="cancel_file", help="training stops cleanly (checkpoint saved) when this file appears")
    sm = sub.add_parser("smoke")
    sm.add_argument("--base", default=DEFAULT_BASE)
    sm.add_argument("--steps", type=int, default=3)
    sm.add_argument("--threads", type=int)
    args = p.parse_args()
    if args.cmd == "hardware":
        print(json.dumps(hardware(args.base), indent=1))
        return 0
    return {"check": cmd_check, "train": cmd_train, "smoke": cmd_smoke}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
