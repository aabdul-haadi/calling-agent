#!/usr/bin/env python3
"""Serves a fine-tuned LoRA adapter (or the plain base model) over HTTP on this machine only.

    ml/.venv/Scripts/python.exe ml/serve_local.py --adapter <run>/out/adapter [--base MODEL] [--port 8790]

POST /generate  {"system": str, "messages": [{"role","content"}], "max_tokens": int} -> {"text", "tokens", "ms"}
GET  /health    {"ok", "base", "adapterSha256"}

It binds to 127.0.0.1, writes text only and has no access to tools or the database. One request is
generated at a time (a CPU cannot do more), so callers queue.
"""

from __future__ import annotations

import argparse
import hashlib
import threading
import time
from pathlib import Path

import torch
import uvicorn
from fastapi import FastAPI
from pydantic import BaseModel
from transformers import AutoModelForCausalLM, AutoTokenizer

DEFAULT_BASE = "Qwen/Qwen2.5-0.5B-Instruct"


class Message(BaseModel):
    role: str
    content: str


class Request(BaseModel):
    system: str = ""
    messages: list[Message]
    max_tokens: int = 200


def build(base: str, adapter: str | None):
    tok = AutoTokenizer.from_pretrained(adapter or base)
    model = AutoModelForCausalLM.from_pretrained(base, torch_dtype=torch.float32)
    digest = None
    if adapter:
        from peft import PeftModel

        model = PeftModel.from_pretrained(model, adapter)
        weights = Path(adapter) / "adapter_model.safetensors"
        digest = hashlib.sha256(weights.read_bytes()).hexdigest()
    model.eval()
    return tok, model, digest


def make_app(base: str, adapter: str | None) -> FastAPI:
    tok, model, digest = build(base, adapter)
    lock = threading.Lock()
    app = FastAPI()

    @app.get("/health")
    def health() -> dict:
        return {"ok": True, "base": base, "adapterSha256": digest}

    @app.post("/generate")
    def generate(req: Request) -> dict:
        msgs = ([{"role": "system", "content": req.system}] if req.system else []) + [m.model_dump() for m in req.messages]
        prompt = tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
        ids = tok(prompt, return_tensors="pt", truncation=True, max_length=2048)
        started = time.time()
        with lock, torch.no_grad():
            out = model.generate(**ids, max_new_tokens=min(req.max_tokens, 300), do_sample=False, pad_token_id=tok.eos_token_id)
        new = out[0][ids["input_ids"].shape[-1]:]
        return {"text": tok.decode(new, skip_special_tokens=True).strip(), "tokens": int(new.shape[-1]), "ms": round((time.time() - started) * 1000)}

    return app


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--base", default=DEFAULT_BASE)
    p.add_argument("--adapter")
    p.add_argument("--port", type=int, default=8790)
    a = p.parse_args()
    uvicorn.run(make_app(a.base, a.adapter), host="127.0.0.1", port=a.port, log_level="warning")
