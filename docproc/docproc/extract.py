"""Turn a PDF into ordered, structured blocks, one page at a time.

Output is a stream of events (see cli.py): the document's start, then each page as soon as it is
read (so a 300-page manual never sits in memory as one object), then a summary. A page is a list of
blocks: headings (with a level), paragraphs, list items and tables (as pipe-separated rows).

Digital PDFs are read from their text layer. A page with no usable text layer (a scan) is rendered
to an image and read with OCR, but only when OCR is allowed. Nothing is guessed: a page that cannot
be read is reported as empty, never filled in.
"""

from __future__ import annotations

import re
import statistics
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterator

Emit = Callable[[dict[str, Any]], None]

MIN_TEXT_CHARS = 25  # fewer characters than this on a page = no text layer
BULLET = re.compile(r"^\s*(?:[••●▪\-–*]|\d{1,2}[.)]|\([a-z0-9]\))\s+")
PAGE_NUMBER_LINE = re.compile(r"^\s*(?:page\s+)?\d{1,4}(?:\s*(?:of|/)\s*\d{1,4})?\s*$", re.IGNORECASE)


class ExtractError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class Line:
    text: str
    top: float
    bottom: float
    size: float
    bold: bool
    x0: float = 0.0


@dataclass
class PageRead:
    number: int
    height: float
    lines: list[Line] = field(default_factory=list)
    tables: list[list[list[str]]] = field(default_factory=list)
    table_tops: list[float] = field(default_factory=list)
    chars: int = 0
    has_images: bool = False


# --------------------------------------------------------------------------------------------
# opening
# --------------------------------------------------------------------------------------------


def open_pdf(path: Path):
    """Validate the file and return (pypdf reader, password) or raise ExtractError."""
    from pypdf import PdfReader
    from pypdf.errors import PdfReadError

    try:
        reader = PdfReader(str(path), strict=False)
    except (PdfReadError, OSError, ValueError, KeyError, AssertionError, TypeError) as exc:
        raise ExtractError("CORRUPTED", f"The file is not a readable PDF ({type(exc).__name__}).") from exc
    except Exception as exc:  # noqa: BLE001 - pypdf can raise almost anything on a damaged file
        raise ExtractError("CORRUPTED", f"The file is not a readable PDF ({type(exc).__name__}).") from exc
    password = None
    if reader.is_encrypted:
        try:
            ok = reader.decrypt("")
        except Exception:  # noqa: BLE001
            ok = 0
        if not ok:
            raise ExtractError("PASSWORD_PROTECTED", "The PDF is password protected. Remove the password and upload it again.")
        password = ""
    try:
        pages = len(reader.pages)
    except Exception as exc:  # noqa: BLE001
        raise ExtractError("CORRUPTED", f"The PDF's page tree is damaged ({type(exc).__name__}).") from exc
    if pages == 0:
        raise ExtractError("EMPTY", "The PDF has no pages.")
    return reader, password


def metadata(reader) -> dict[str, Any]:
    try:
        m = reader.metadata or {}
    except Exception:  # noqa: BLE001
        m = {}
    def get(key: str) -> str | None:
        v = m.get(key) if hasattr(m, "get") else None
        return str(v).strip()[:200] if v else None
    return {"title": get("/Title"), "author": get("/Author"), "producer": get("/Producer"), "created": get("/CreationDate")}


# --------------------------------------------------------------------------------------------
# text layer
# --------------------------------------------------------------------------------------------


def _inside(x: float, y: float, boxes: list[tuple[float, float, float, float]]) -> bool:
    return any(x0 - 1 <= x <= x1 + 1 and top - 1 <= y <= bottom + 1 for x0, top, x1, bottom in boxes)


def read_text_page(plumber_page, number: int) -> PageRead:
    """Words with font sizes -> lines, with table regions read separately."""
    page = PageRead(number=number, height=float(plumber_page.height))
    try:
        page.has_images = bool(plumber_page.images)
    except Exception:  # noqa: BLE001
        page.has_images = False

    boxes: list[tuple[float, float, float, float]] = []
    try:
        for table in plumber_page.find_tables():
            rows = [[(c or "").replace("\n", " ").strip() for c in row] for row in table.extract()]
            rows = [r for r in rows if any(r)]
            if len(rows) >= 2 and max(len(r) for r in rows) >= 2:
                page.tables.append(rows)
                page.table_tops.append(float(table.bbox[1]))
                boxes.append(tuple(float(v) for v in table.bbox))  # type: ignore[arg-type]
    except Exception:  # noqa: BLE001 - table detection is best effort
        boxes = []
        page.tables = []
        page.table_tops = []

    try:
        words = plumber_page.extract_words(x_tolerance=1.5, y_tolerance=2, keep_blank_chars=False,
                                           extra_attrs=["size", "fontname"])
    except Exception:  # noqa: BLE001
        words = []
    words = [w for w in words if not _inside((w["x0"] + w["x1"]) / 2, (w["top"] + w["bottom"]) / 2, boxes)]
    page.chars = sum(len(w["text"]) for w in words) + sum(len(c) for t in page.tables for r in t for c in r)

    words.sort(key=lambda w: (round(w["top"]), w["x0"]))
    current: list[dict] = []
    for w in words:
        if current and abs(w["top"] - current[-1]["top"]) > max(2.5, 0.45 * current[-1]["size"]):
            page.lines.append(_line(current))
            current = []
        current.append(w)
    if current:
        page.lines.append(_line(current))
    page.lines.sort(key=lambda ln: ln.top)
    return page


_CID = re.compile(r"\(cid:\d+\)")


def _clean(text: str) -> str:
    """Symbol fonts leave "(cid:127)" where a bullet was: make it a bullet, or drop it mid-text."""
    if text.startswith("(cid:"):
        text = _CID.sub("•", text, count=1)
    return _CID.sub("", text).strip()


def _line(words: list[dict]) -> Line:
    words = sorted(words, key=lambda w: w["x0"])
    sizes = [float(w["size"]) for w in words]
    bold = sum("bold" in str(w["fontname"]).lower() or "black" in str(w["fontname"]).lower() for w in words) > len(words) / 2
    return Line(
        text=_clean(" ".join(w["text"] for w in words)),
        top=min(float(w["top"]) for w in words),
        bottom=max(float(w["bottom"]) for w in words),
        size=statistics.median(sizes),
        bold=bold,
        x0=float(words[0]["x0"]),
    )


# --------------------------------------------------------------------------------------------
# structure
# --------------------------------------------------------------------------------------------


def body_size(pages: list[PageRead]) -> float:
    counter: Counter[float] = Counter()
    for p in pages:
        for ln in p.lines:
            counter[round(ln.size * 2) / 2] += len(ln.text)
    return counter.most_common(1)[0][0] if counter else 10.0


def repeated_margin_lines(pages: list[PageRead]) -> set[str]:
    """Running headers and footers: the same text (digits ignored) near the page edge on many pages."""
    if len(pages) < 3:
        return set()
    seen: Counter[str] = Counter()
    for p in pages:
        for ln in p.lines:
            if ln.top < 0.09 * p.height or ln.bottom > 0.91 * p.height:
                seen[re.sub(r"\d+", "#", ln.text.strip().lower())] += 1
    return {t for t, n in seen.items() if n >= max(3, 0.4 * len(pages))}


def page_label(page: PageRead, margin: set[str]) -> str | None:
    """The page number printed on the page, if any (kept apart from the text so it can be cited)."""
    for ln in reversed(page.lines):
        key = re.sub(r"\d+", "#", ln.text.strip().lower())
        if (ln.bottom > 0.9 * page.height or ln.top < 0.1 * page.height) and (key in margin or PAGE_NUMBER_LINE.match(ln.text)):
            m = re.search(r"\d{1,4}", ln.text)
            if m and ("page" in ln.text.lower() or PAGE_NUMBER_LINE.match(ln.text)):
                return m.group(0)
    return None


def build_blocks(page: PageRead, body: float, margin: set[str], levels: dict[float, int]) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    paragraph: list[Line] = []
    items: list[tuple[float, dict[str, Any]]] = []  # (top, block) so tables land in reading order

    def flush() -> None:
        nonlocal paragraph
        if not paragraph:
            return
        text = _join(paragraph)
        if text:
            items.append((paragraph[0].top, {"type": "paragraph", "text": text}))
        paragraph = []

    prev: Line | None = None
    for ln in page.lines:
        key = re.sub(r"\d+", "#", ln.text.strip().lower())
        near_edge = ln.top < 0.09 * page.height or ln.bottom > 0.91 * page.height
        if near_edge and (key in margin or PAGE_NUMBER_LINE.match(ln.text)):
            continue
        size_key = round(ln.size * 2) / 2
        is_heading = (
            len(ln.text) <= 140
            and not ln.text.rstrip().endswith((".", ",", ";"))
            and (size_key in levels or (ln.bold and ln.size >= body - 0.5 and len(ln.text.split()) <= 12 and size_key >= body))
        )
        if is_heading:
            flush()
            level = levels.get(size_key, 3)
            if items and items[-1][1]["type"] == "heading" and items[-1][1]["level"] == level and prev is not None \
                    and abs(ln.top - prev.bottom) < ln.size:
                items[-1][1]["text"] += " " + ln.text  # a heading that wraps onto two lines
            else:
                items.append((ln.top, {"type": "heading", "level": level, "text": ln.text}))
        elif BULLET.match(ln.text):
            flush()
            paragraph = [ln]
            flush()
            items[-1][1]["type"] = "list"
        else:
            gap = ln.top - prev.bottom if prev else 0
            if paragraph and gap > 0.55 * body:
                flush()
            paragraph.append(ln)
        prev = ln
    flush()
    for rows, top in zip(page.tables, page.table_tops):
        items.append((top, {"type": "table", "text": "\n".join(" | ".join(r) for r in rows), "rows": len(rows)}))
    items.sort(key=lambda t: t[0])
    blocks = [b for _, b in items]
    return blocks


def _join(lines: list[Line]) -> str:
    out = ""
    for ln in lines:
        t = ln.text.strip()
        if not out:
            out = t
        elif out.endswith("-") and t[:1].islower():
            out = out[:-1] + t  # re-join a word split across lines
        else:
            out += " " + t
    return re.sub(r"\s{2,}", " ", out).strip()


def heading_levels(pages: list[PageRead], body: float) -> dict[float, int]:
    sizes: Counter[float] = Counter()
    for p in pages:
        for ln in p.lines:
            s = round(ln.size * 2) / 2
            if s >= body * 1.12 and len(ln.text) <= 140:
                sizes[s] += 1
    ranked = sorted(sizes, reverse=True)[:3]
    return {s: i + 1 for i, s in enumerate(ranked)}


# --------------------------------------------------------------------------------------------
# OCR
# --------------------------------------------------------------------------------------------


class Ocr:
    """RapidOCR (PaddleOCR models on onnxruntime). Loaded on first use: most PDFs never need it."""

    def __init__(self, dpi: int = 200) -> None:
        self.dpi = dpi
        self._engine = None
        self._pdf = None

    def read(self, path: Path, index: int, password: str | None) -> tuple[list[dict[str, Any]], float, str | None]:
        import numpy as np
        import pypdfium2 as pdfium

        if self._engine is None:
            import logging

            from rapidocr import RapidOCR

            logging.getLogger("RapidOCR").setLevel(logging.ERROR)
            self._engine = RapidOCR(params={"Global.log_level": "error"})
        if self._pdf is None:
            self._pdf = pdfium.PdfDocument(str(path), password=password or None)
        image = self._pdf[index].render(scale=self.dpi / 72).to_pil().convert("RGB")
        result = self._engine(np.asarray(image))
        if result is None or result.boxes is None or not len(result.txts):
            return [], 0.0, None
        lines: list[Line] = []
        scores: list[float] = []
        for box, text, score in zip(result.boxes, result.txts, result.scores):
            ys = [p[1] for p in box]
            xs = [p[0] for p in box]
            lines.append(Line(text=str(text).strip(), top=min(ys), bottom=max(ys), size=max(ys) - min(ys), bold=False, x0=min(xs)))
            scores.append(float(score))
        lines = [ln for ln in lines if ln.text]
        lines.sort(key=lambda ln: (round(ln.top / 8), ln.x0))
        # glue boxes on the same visual line, then reuse the same structure logic
        merged: list[Line] = []
        for ln in lines:
            if merged and abs(ln.top - merged[-1].top) < 0.5 * max(ln.size, merged[-1].size):
                m = merged[-1]
                m.text += " " + ln.text
                m.bottom = max(m.bottom, ln.bottom)
                m.size = max(m.size, ln.size)
            else:
                merged.append(ln)
        pg = PageRead(number=index + 1, height=float(image.height), lines=merged, chars=sum(len(ln.text) for ln in merged))
        body = statistics.median([ln.size for ln in merged]) if merged else 10.0
        levels: dict[float, int] = {}
        big = sorted({round(ln.size) for ln in merged if ln.size >= 1.3 * body}, reverse=True)[:3]
        for i, s in enumerate(big):
            levels[s] = i + 1
        # OCR sizes are in pixels: key by rounded size instead of half points
        for ln in pg.lines:
            ln.size = float(round(ln.size))
        blocks = build_blocks(pg, float(round(body)), set(), {float(k): v for k, v in levels.items()})
        return blocks, sum(scores) / len(scores), None


# --------------------------------------------------------------------------------------------
# driver
# --------------------------------------------------------------------------------------------


def extract(path: Path, emit: Emit, ocr: str = "auto", max_pages: int | None = None) -> None:
    """Emit start / page / done events. ocr is "auto" (scanned pages only), "off" or "force"."""
    import pdfplumber

    reader, password = open_pdf(path)
    total = len(reader.pages)
    limit = min(total, max_pages) if max_pages else total
    meta = metadata(reader)
    emit({"type": "start", "pages": total, "meta": meta})

    try:
        plumber = pdfplumber.open(str(path), password=password or "")
    except Exception as exc:  # noqa: BLE001
        raise ExtractError("CORRUPTED", f"The PDF could not be opened for reading ({type(exc).__name__}).") from exc

    reads: list[PageRead] = []
    with plumber:
        for i in range(limit):
            try:
                reads.append(read_text_page(plumber.pages[i], i + 1))
            except Exception:  # noqa: BLE001 - one bad page must not lose the others
                reads.append(PageRead(number=i + 1, height=792.0))
            if i % 10 == 9:
                emit({"type": "progress", "stage": "reading", "page": i + 1, "pages": limit})
            plumber.pages[i].flush_cache()

    text_pages = [p for p in reads if p.chars >= MIN_TEXT_CHARS]
    body = body_size(text_pages)
    levels = heading_levels(text_pages, body)
    margin = repeated_margin_lines(text_pages)

    ocr_engine = Ocr() if ocr != "off" else None
    ocr_pages = empty_pages = 0
    for i, page in enumerate(reads):
        blocks: list[dict[str, Any]] = []
        warnings: list[str] = []
        used_ocr = False
        confidence: float | None = None
        needs_ocr = ocr == "force" or page.chars < MIN_TEXT_CHARS
        if needs_ocr and ocr_engine is not None and (ocr == "force" or page.has_images or page.chars == 0):
            try:
                blocks, confidence, _ = ocr_engine.read(path, i, password)
                used_ocr = True
                ocr_pages += 1
                if confidence < 0.6:
                    warnings.append("low OCR confidence")
            except Exception as exc:  # noqa: BLE001
                warnings.append(f"OCR failed ({type(exc).__name__})")
        if not used_ocr:
            blocks = build_blocks(page, body, margin, levels)
            if needs_ocr and ocr == "off":
                warnings.append("no text layer; OCR is off")
        if not blocks:
            empty_pages += 1
        emit({
            "type": "page", "number": page.number, "label": page_label(page, margin),
            "blocks": blocks, "ocr": used_ocr,
            "ocrConfidence": None if confidence is None else round(confidence, 3), "warnings": warnings,
        })
        if i % 10 == 9 or used_ocr:
            emit({"type": "progress", "stage": "structuring", "page": i + 1, "pages": limit})
    emit({"type": "done", "pages": limit, "totalPages": total, "ocrPages": ocr_pages, "emptyPages": empty_pages,
          "truncated": limit < total})
    if empty_pages == limit:
        raise ExtractError("NO_TEXT", "No text could be read from any page (a scan with OCR switched off, or an image-only file).")
