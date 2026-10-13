"""The PDF reader against the generated corpus (python -m tests.corpus makes it)."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

CORPUS = Path(__file__).resolve().parent / "corpus"
ROOT = Path(__file__).resolve().parents[1]

pytestmark = pytest.mark.skipif(not (CORPUS / "facts.json").exists(), reason="run: python -m tests.corpus")


def read(name: str, *extra: str) -> tuple[list[dict], int]:
    p = subprocess.run([sys.executable, "-m", "docproc", "extract", str(CORPUS / f"{name}.pdf"), *extra],
                       cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
    return [json.loads(line) for line in p.stdout.splitlines() if line.strip()], p.returncode


def pages(events: list[dict]) -> dict[int, dict]:
    return {e["number"]: e for e in events if e["type"] == "page"}


def test_a_digital_handbook_keeps_structure_page_numbers_and_tables():
    events, code = read("skylink-handbook-v2")
    assert code == 0
    assert events[0]["type"] == "start" and events[0]["pages"] == 55
    assert events[-1] == {"type": "done", "pages": 55, "totalPages": 55, "ocrPages": 0, "emptyPages": 0, "truncated": False}
    p = pages(events)
    assert len(p) == 55
    p2 = p[2]
    kinds = [b["type"] for b in p2["blocks"]]
    assert "heading" in kinds and "table" in kinds
    table = next(b for b in p2["blocks"] if b["type"] == "table")
    assert "Fare class | Free checked bags | Maximum weight per bag" in table["text"]
    assert "Economy | 1 | 23 kg" in table["text"]
    h1 = [b["text"] for b in p2["blocks"] if b["type"] == "heading" and b["level"] == 1]
    assert h1 == ["1. Baggage"]
    # the printed page number is reported but is not part of the text
    assert p2["label"] == "2"
    assert not any("Page 2" in b["text"] for b in p2["blocks"])
    # running headers are removed from the body
    assert not any("Passenger Handbook - Edition" in b["text"] for b in p2["blocks"])


def test_bullets_become_list_items_without_font_garbage():
    events, _ = read("skylink-handbook-v2")
    items = [b["text"] for b in pages(events)[1]["blocks"] if b["type"] == "list"]
    assert items and all(t.startswith("• ") and "cid:" not in t for t in items)


def test_a_scanned_pdf_is_read_with_ocr():
    events, code = read("skylink-scan")
    assert code == 0
    assert events[-1]["ocrPages"] == 5
    first = pages(events)[1]
    assert first["ocr"] is True and first["ocrConfidence"] > 0.8
    text = " ".join(b["text"] for b in first["blocks"]).lower()
    assert "baggage" in text and "23" in text


def test_ocr_can_be_switched_off():
    events, code = read("skylink-scan", "--ocr", "off")
    assert code == 2
    assert events[-1]["code"] == "NO_TEXT"


@pytest.mark.parametrize("name, code", [("encrypted", "PASSWORD_PROTECTED"), ("corrupted", "CORRUPTED"), ("empty", "EMPTY"),
                                         ("not-a-pdf", "CORRUPTED"), ("blank-page", "NO_TEXT")])
def test_unusable_files_are_refused_with_a_reason(name, code):
    events, rc = read(name)
    assert rc == 2
    assert events[-1]["type"] == "error" and events[-1]["code"] == code
    assert events[-1]["message"]


def test_page_limit_is_respected():
    events, _ = read("skylink-handbook-v2", "--max-pages", "3")
    assert len(pages(events)) == 3
    assert events[-1]["truncated"] is True


def test_stdout_carries_events_only():
    p = subprocess.run([sys.executable, "-m", "docproc", "extract", str(CORPUS / "skylink-scan.pdf")],
                       cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
    for line in p.stdout.splitlines():
        json.loads(line)  # OCR libraries print progress, which must not end up here
