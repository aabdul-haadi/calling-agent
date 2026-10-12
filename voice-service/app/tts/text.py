"""Turning an agent reply into something that sounds natural when read aloud.

Two steps: `speakable()` cleans the text (the reply is written for a screen), and `Chunker` splits a
growing stream of text into phrases so synthesis can start before the whole reply exists.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# --------------------------------------------------------------------------------------------
# Cleaning
# --------------------------------------------------------------------------------------------

_CITATION = re.compile(r"[\[【(]\s*Source:\s*[^\]】)]+[\]】)]", re.IGNORECASE)
_MARKDOWN_LINK = re.compile(r"\[([^\]]+)\]\((?:[^)]+)\)")
_URL = re.compile(r"https?://\S+")
_BOLD_ITALIC = re.compile(r"(\*{1,3}|_{1,3})(\S(?:.*?\S)?)\1")
_LIST_MARK = re.compile(r"^\s*(?:[-*•]|\d+[.)])\s+", re.MULTILINE)
_HEADING = re.compile(r"^\s*#{1,6}\s*", re.MULTILINE)
_EMOJI = re.compile("[\U0001F300-\U0001FAFF☀-➿️]")
# Reference codes such as SK1001 or NT2002: read letter by letter and digit by digit.
_CODE = re.compile(r"\b([A-Z]{2,3})[- ]?(\d{3,6})\b")
_FLIGHT = re.compile(r"\b([A-Z]{2})(\d{3})\b")
_DATE_ISO = re.compile(r"\b(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})[:\d.]*Z?)?\b")

_MONTHS = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]


def _spell(m: re.Match[str]) -> str:
    letters, digits = m.group(1), m.group(2)
    return " ".join(letters) + ", " + " ".join(digits)


def _say_date(m: re.Match[str]) -> str:
    y, mo, d, hh, mm = m.groups()
    month = _MONTHS[int(mo)] if 1 <= int(mo) <= 12 else mo
    out = f"{month} {int(d)}"
    if hh is not None:
        out += f" at {int(hh)}:{mm} UTC"
    return out


def speakable(text: str) -> str:
    """Plain spoken text: no markdown, links, citations, emoji; codes and dates made readable."""
    t = _CITATION.sub("", text)
    t = _MARKDOWN_LINK.sub(r"\1", t)
    t = _URL.sub("", t)
    t = _HEADING.sub("", t)
    t = _LIST_MARK.sub("", t)
    t = _BOLD_ITALIC.sub(r"\2", t)
    t = t.replace("`", "")
    t = _EMOJI.sub("", t)
    t = _DATE_ISO.sub(_say_date, t)
    t = _CODE.sub(_spell, t)
    t = t.replace("‑", "-").replace("–", ", ").replace("—", ", ")
    t = re.sub(r"\s*\n+\s*", ". ", t)
    t = re.sub(r"\s{2,}", " ", t)
    t = re.sub(r"\.\s*\.", ".", t)
    return t.strip()


# --------------------------------------------------------------------------------------------
# Chunking
# --------------------------------------------------------------------------------------------

_ABBREVIATIONS = {"mr", "mrs", "ms", "dr", "st", "vs", "etc", "e.g", "i.e", "no", "approx", "inc"}
_SENTENCE_END = re.compile(r"([.!?]+)(\s+|$)")
_CLAUSE_END = re.compile(r"([,;:])\s+")


def _words(s: str) -> int:
    return len(s.split())


@dataclass
class Chunker:
    """Feed text as it streams in, get back phrases that are safe to speak.

    A phrase ends at a sentence boundary, or at a comma/semicolon once it is long enough to
    sound natural on its own. The very first phrase is allowed to be shorter, so speech can start
    earlier. Punctuation always stays attached: it drives the voice's intonation.
    """

    first_clause_words: int = 4
    clause_words: int = 8
    max_words: int = 28
    _buf: str = ""
    _emitted: int = 0
    _out: list[str] = field(default_factory=list)

    def push(self, delta: str) -> list[str]:
        self._buf += delta
        return self._drain(final=False)

    def flush(self) -> list[str]:
        out = self._drain(final=True)
        rest = self._buf.strip()
        self._buf = ""
        if rest:
            out.append(rest)
            self._emitted += 1
        return out

    def _drain(self, final: bool) -> list[str]:
        out: list[str] = []
        while True:
            cut = self._find_cut(final)
            if cut is None:
                break
            piece, self._buf = self._buf[:cut].strip(), self._buf[cut:]
            if piece:
                out.append(piece)
                self._emitted += 1
        return out

    def _find_cut(self, final: bool) -> int | None:
        buf = self._buf
        if not final and (buf.count("[") > buf.count("]") or buf.count("(") > buf.count(")")):
            return None  # never cut inside a bracket: a citation like [Source: a, b] stays whole
        for m in _SENTENCE_END.finditer(buf):
            end = m.end()
            before = buf[: m.start()].rstrip()
            last = before.rsplit(None, 1)[-1].lower().strip(".") if before else ""
            if last in _ABBREVIATIONS:
                continue  # "Dr. Smith" is not a sentence end
            if re.search(r"\d$", before) and m.group(2) == "":
                if not final:
                    return None  # "3." might continue as "3.5": wait for more text
            if m.group(2) == "" and not final:
                return None  # the terminator is at the very end: more text may follow
            return end
        # no sentence end: look for a clause boundary, but only if the phrase is long enough
        threshold = self.first_clause_words if self._emitted == 0 else self.clause_words
        for m in _CLAUSE_END.finditer(buf):
            head = buf[: m.start()]
            if head.count("[") > head.count("]") or head.count("(") > head.count(")"):
                continue  # the comma or colon is inside a citation or parenthesis
            if _words(head) >= threshold:
                return m.end()
        if _words(buf) >= self.max_words:
            # last resort for run-on text: cut at the last space before the limit
            idx = buf.rfind(" ", 0, len(buf))
            return idx + 1 if idx > 0 else None
        return None
