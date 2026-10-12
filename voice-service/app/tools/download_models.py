"""Download the default local speech models into ./models (nothing is downloaded at import time).

    python -m app.tools.download_models            # default set: VAD + ASR + TTS (~460 MB)
    python -m app.tools.download_models --verify   # only check files and hashes
    python -m app.tools.download_models --only asr

Every download is checked against the SHA-256 pinned in MANIFEST so a changed or corrupted file is
refused. Licences are recorded here because they matter before anyone ships this.
"""

from __future__ import annotations

import argparse
import hashlib
import shutil
import sys
import tarfile
import urllib.request
from dataclasses import dataclass
from pathlib import Path

RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download"
MODELS_DIR = Path(__file__).resolve().parents[2] / "models"


@dataclass(frozen=True)
class Model:
    key: str
    url: str
    sha256: str
    # Path (relative to MODELS_DIR) that must exist once installed.
    expect: str
    licence: str
    note: str
    archive: bool = True
    # Not part of the default install: only downloaded when asked for with --only.
    optional: bool = False


# sha256 values were computed from the files downloaded on 2026-10-12 and are re-checked on every run.
MANIFEST: tuple[Model, ...] = (
    Model(
        key="vad",
        url=f"{RELEASES}/asr-models/silero_vad.onnx",
        sha256="9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6",
        expect="silero_vad.onnx",
        licence="MIT (Silero VAD)",
        note="Voice activity detector, 0.6 MB",
        archive=False,
    ),
    Model(
        key="asr-small",
        url=f"{RELEASES}/asr-models/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17.tar.bz2",
        sha256="9c559283e8498d3fe95913c79ca1cb454bb26281ac2b102b41306c7d752765d9",
        expect="sherpa-onnx-streaming-zipformer-en-20M-2023-02-17/tokens.txt",
        licence="Apache-2.0 (icefall streaming zipformer, trained on LibriSpeech)",
        note="Optional fast fallback, 20M parameters (122 MB download). Drops first words on real speech: see docs/VOICE.md",
        optional=True,
    ),
    Model(
        key="asr",
        url=f"{RELEASES}/asr-models/sherpa-onnx-streaming-zipformer-en-2023-06-26.tar.bz2",
        sha256="639e25b578e9e997131402199419c13a941f8e4e198e2da1ce57dbf5cf401282",
        expect="sherpa-onnx-streaming-zipformer-en-2023-06-26/tokens.txt",
        licence="Apache-2.0 (icefall streaming zipformer, trained on GigaSpeech/LibriSpeech)",
        note="Default streaming English recognizer (296 MB download, about 320 MB on disk)",
    ),
    Model(
        key="tts",
        url=f"{RELEASES}/tts-models/vits-piper-en_US-amy-low.tar.bz2",
        sha256="c70f5284a09a7fd4ed203b39b2ff51cac1432b422b852eb647b481dade3cf639",
        expect="vits-piper-en_US-amy-low/tokens.txt",
        licence="Piper voice 'amy' (check MODEL_CARD inside the archive before commercial use)",
        note="English female voice, 16 kHz, VITS via sherpa-onnx",
    ),
)


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _fetch(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "adk-voice-service/0.1"})
    with urllib.request.urlopen(req, timeout=60) as resp, dest.open("wb") as out:
        total = int(resp.headers.get("Content-Length") or 0)
        done = 0
        while chunk := resp.read(1 << 20):
            out.write(chunk)
            done += len(chunk)
            if total:
                print(f"\r  {done / 1e6:7.1f} / {total / 1e6:.1f} MB", end="", flush=True)
    print()


def install(model: Model, force: bool = False) -> bool:
    target = MODELS_DIR / model.expect
    if target.exists() and not force:
        print(f"[ok] {model.key}: already installed ({model.expect})")
        return True
    print(f"[..] {model.key}: downloading {model.url.rsplit('/', 1)[-1]}  ({model.note})")
    tmp = MODELS_DIR / ".download" / model.url.rsplit("/", 1)[-1]
    _fetch(model.url, tmp)
    digest = sha256_of(tmp)
    if model.sha256 == "PENDING":
        print(f"[!!] {model.key}: no pinned hash yet. sha256={digest}")
    elif digest != model.sha256:
        tmp.unlink(missing_ok=True)
        print(f"[xx] {model.key}: hash mismatch (got {digest}), refusing to install", file=sys.stderr)
        return False
    if model.archive:
        with tarfile.open(tmp, "r:bz2") as tar:
            # Refuse paths that would escape the models folder.
            for member in tar.getmembers():
                if not (MODELS_DIR / member.name).resolve().is_relative_to(MODELS_DIR.resolve()):
                    raise RuntimeError(f"unsafe path in archive: {member.name}")
            tar.extractall(MODELS_DIR, filter="data")
    else:
        shutil.move(str(tmp), target)
    tmp.unlink(missing_ok=True)
    ok = target.exists()
    print(f"[{'ok' if ok else 'xx'}] {model.key}: installed to {MODELS_DIR / model.expect}")
    return ok


def verify() -> bool:
    ok = True
    for m in MANIFEST:
        present = (MODELS_DIR / m.expect).exists()
        ok &= present or m.optional
        print(f"[{'ok' if present else 'missing'}] {m.key:4} {m.expect}   licence: {m.licence}")
    return ok


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--verify", action="store_true", help="only check what is installed")
    ap.add_argument("--only", choices=[m.key for m in MANIFEST], help="install one model")
    ap.add_argument("--force", action="store_true", help="download again")
    args = ap.parse_args(argv)
    if args.verify:
        return 0 if verify() else 1
    ok = True
    for m in MANIFEST:
        if args.only and m.key != args.only:
            continue
        if m.optional and not args.only:
            continue
        ok &= install(m, args.force)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
