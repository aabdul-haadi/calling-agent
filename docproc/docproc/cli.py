"""python -m docproc extract FILE.pdf [--ocr auto|off|force] [--max-pages N]

Writes one JSON object per line to stdout (start, progress, page, done, or error) so the caller can
show progress and store pages as they arrive. The exit code is 0 on success, 2 when the document
cannot be used (the error line says why).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from docproc.extract import ExtractError, extract


_OUT = sys.stdout


def emit(event: dict) -> None:
    _OUT.write(json.dumps(event, ensure_ascii=False) + "\n")
    _OUT.flush()


def main(argv: list[str] | None = None) -> int:
    _OUT.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    sys.stdout = sys.stderr  # libraries (OCR) print progress; keep stdout for events only
    ap = argparse.ArgumentParser(prog="docproc")
    sub = ap.add_subparsers(dest="command", required=True)
    ex = sub.add_parser("extract")
    ex.add_argument("file", type=Path)
    ex.add_argument("--ocr", choices=["auto", "off", "force"], default="auto")
    ex.add_argument("--max-pages", type=int, default=None)
    args = ap.parse_args(argv)
    try:
        if not args.file.is_file():
            raise ExtractError("NOT_FOUND", "The file does not exist.")
        extract(args.file, emit, ocr=args.ocr, max_pages=args.max_pages)
    except ExtractError as exc:
        emit({"type": "error", "code": exc.code, "message": exc.message})
        return 2
    except Exception as exc:  # noqa: BLE001
        emit({"type": "error", "code": "INTERNAL", "message": f"Unexpected error: {type(exc).__name__}"})
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
