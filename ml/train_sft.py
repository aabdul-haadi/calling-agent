#!/usr/bin/env python3
"""Supervised fine-tuning (LoRA) on a frozen, reviewed dataset exported from the Learning console.

    python ml/train_sft.py check  DATASET.jsonl --manifest MANIFEST.json [--eval EVAL.jsonl]
    python ml/train_sft.py train  DATASET.jsonl --manifest MANIFEST.json --out ADAPTER_DIR [--base MODEL] [--epochs 2]

`check` needs only the Python standard library. It refuses a dataset that is too small, that does not
match its recorded hash, that contains personal data or secrets, that mixes in held-out evaluation
examples, or that teaches a reply to skip a safety step. `train` runs the same checks, then needs a
GPU (or a lot of patience) and: pip install torch transformers peft datasets accelerate.

The hosted model the agents use today (a Groq-hosted model) cannot be fine-tuned, so a trained adapter
applies to an open model you run yourself. Nothing here deploys anything: the adapter must pass the
evaluation suite and be released from the Learning console like every other change.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

MIN_EXAMPLES_DEFAULT = 200
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
PHONE = re.compile(r"\+?\(?\d[\d\s().-]{7,}\d")
REFERENCE = re.compile(r"\b[A-Z]{2}\s?\d{4,6}\b")
SECRET = re.compile(r"\b(?:password|passcode|pin(?:\s+code)?|cvv|cvc|otp|security code|card number)\b", re.I)
UNSAFE = re.compile(r"\b(?:skip|no need for|without|bypass)\b[^.]{0,30}\b(?:verif\w+|confirm\w*|identity|approval)\b", re.I)
NORMALIZE = re.compile(r"[^a-z0-9\s]")


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", NORMALIZE.sub(" ", re.sub(r"\[[a-z_]+\]", " ", text.lower()))).strip()


def load_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def problems(rows: list[dict], manifest: dict, text: str, held_out: set[str]) -> list[str]:
    out: list[str] = []
    minimum = int(manifest.get("minExamples", MIN_EXAMPLES_DEFAULT))
    if len(rows) < minimum:
        out.append(f"only {len(rows)} examples; the recorded minimum is {minimum}")
    recorded = manifest.get("sha256")
    if recorded and hashlib.sha256(text.encode("utf-8")).hexdigest() != recorded:
        out.append("the file does not match the hash recorded when the dataset was frozen")
    seen: set[str] = set()
    for i, row in enumerate(rows, 1):
        msgs = row.get("messages") or []
        if not msgs or msgs[-1].get("role") != "assistant" or not msgs[-1].get("content", "").strip():
            out.append(f"line {i}: the last message must be the approved assistant reply")
            continue
        user = next((m["content"] for m in reversed(msgs) if m.get("role") == "user"), "")
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


def check(args: argparse.Namespace) -> int:
    path = Path(args.dataset)
    text = path.read_text(encoding="utf-8")
    rows = [json.loads(line) for line in text.splitlines() if line.strip()]
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    held: set[str] = set()
    if args.eval:
        for r in load_jsonl(Path(args.eval)):
            msgs = r.get("messages") or []
            user = next((m["content"] for m in reversed(msgs) if m.get("role") == "user"), "")
            held.add(normalize(user))
    found = problems(rows, manifest, text, held)
    by_channel = {"voice": 0, "chat": 0}
    for r in rows:
        by_channel[r.get("metadata", {}).get("channel", "chat")] = by_channel.get(r.get("metadata", {}).get("channel", "chat"), 0) + 1
    print(json.dumps({"examples": len(rows), "byChannel": by_channel, "problems": found[:20], "problemCount": len(found)}, indent=1))
    return 0 if not found else 1


def train(args: argparse.Namespace) -> int:
    if check(args) != 0:
        print("Not training: fix the problems above first.", file=sys.stderr)
        return 1
    try:
        import torch  # type: ignore
        from datasets import Dataset  # type: ignore
        from peft import LoraConfig, get_peft_model  # type: ignore
        from transformers import AutoModelForCausalLM, AutoTokenizer, Trainer, TrainingArguments  # type: ignore
    except ImportError as err:
        print(f"Training needs: pip install torch transformers peft datasets accelerate ({err})", file=sys.stderr)
        return 2
    if not torch.cuda.is_available():
        print("No GPU found. Training a language model on a CPU is possible for a 0.5B model but very slow; continuing.", file=sys.stderr)
    rows = load_jsonl(Path(args.dataset))
    tok = AutoTokenizer.from_pretrained(args.base)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    model = AutoModelForCausalLM.from_pretrained(args.base)
    model = get_peft_model(model, LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05, task_type="CAUSAL_LM", target_modules="all-linear"))

    def encode(row: dict) -> dict:
        # Loss only on the final assistant reply: the customer's words and earlier turns are context.
        context = tok.apply_chat_template(row["messages"][:-1], tokenize=False, add_generation_prompt=True)
        full = context + row["messages"][-1]["content"] + (tok.eos_token or "")
        ids = tok(full, truncation=True, max_length=1024)["input_ids"]
        n_ctx = min(len(tok(context)["input_ids"]), len(ids))
        return {"input_ids": ids, "labels": [-100] * n_ctx + ids[n_ctx:]}

    data = Dataset.from_list([encode(r) for r in rows])

    def collate(batch: list[dict]) -> dict:
        width = max(len(b["input_ids"]) for b in batch)
        pad = tok.pad_token_id
        ids = [b["input_ids"] + [pad] * (width - len(b["input_ids"])) for b in batch]
        labels = [b["labels"] + [-100] * (width - len(b["labels"])) for b in batch]
        att = [[1] * len(b["input_ids"]) + [0] * (width - len(b["input_ids"])) for b in batch]
        return {"input_ids": torch.tensor(ids), "labels": torch.tensor(labels), "attention_mask": torch.tensor(att)}

    out = Path(args.out)
    Trainer(
        model=model,
        args=TrainingArguments(output_dir=str(out), num_train_epochs=args.epochs, per_device_train_batch_size=4,
                               learning_rate=2e-4, logging_steps=10, save_strategy="no", seed=args.seed, report_to=[]),
        train_dataset=data,
        data_collator=collate,
    ).train()
    model.save_pretrained(out)
    (out / "training.json").write_text(json.dumps({
        "base": args.base, "epochs": args.epochs, "seed": args.seed, "examples": len(rows),
        "datasetSha256": hashlib.sha256(Path(args.dataset).read_bytes()).hexdigest(),
    }, indent=1), encoding="utf-8")
    print(f"Adapter saved to {out}. It is a candidate: evaluate it before any release.")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("check", "train"):
        s = sub.add_parser(name)
        s.add_argument("dataset")
        s.add_argument("--manifest", required=True, help='JSON with {"sha256": "...", "minExamples": 200}')
        s.add_argument("--eval", help="JSONL of held-out evaluation examples that must not appear in the dataset")
        if name == "train":
            s.add_argument("--out", required=True)
            s.add_argument("--base", default="Qwen/Qwen2.5-0.5B-Instruct")
            s.add_argument("--epochs", type=int, default=2)
            s.add_argument("--seed", type=int, default=7)
    args = p.parse_args()
    return check(args) if args.cmd == "check" else train(args)


if __name__ == "__main__":
    sys.exit(main())
