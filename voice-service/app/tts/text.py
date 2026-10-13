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


_UNITS = ("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen "
          "sixteen seventeen eighteen nineteen").split()
_TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()
_ORDINAL_WORDS = {"one": "first", "two": "second", "three": "third", "five": "fifth", "eight": "eighth",
                  "nine": "ninth", "twelve": "twelfth"}


def number_words(n: int) -> str:
    """0..999,999,999 in plain English words ("one hundred twenty", "forty-five")."""
    if n < 0:
        return "minus " + number_words(-n)
    if n < 20:
        return _UNITS[n]
    if n < 100:
        t, o = divmod(n, 10)
        return _TENS[t] + (f"-{_UNITS[o]}" if o else "")
    if n < 1000:
        h, r = divmod(n, 100)
        return f"{_UNITS[h]} hundred" + (f" {number_words(r)}" if r else "")
    for size, name in ((10**6, "million"), (1000, "thousand")):
        if n >= size:
            q, r = divmod(n, size)
            return f"{number_words(q)} {name}" + (f" {number_words(r)}" if r else "")
    return str(n)


def ordinal_words(n: int) -> str:
    words = number_words(n)
    head, sep, last = words.rpartition("-" if "-" in words.split()[-1] else " ")
    last = _ORDINAL_WORDS.get(last, last[:-1] + "ieth" if last.endswith("y") else last + "th")
    return f"{head}{sep}{last}"


_CURRENCIES = {"$": ("dollar", "dollars", "cent", "cents"), "£": ("pound", "pounds", "pence", "pence"),
               "€": ("euro", "euros", "cent", "cents")}
_MONEY = re.compile(r"([$£€])\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\b")
_USD = re.compile(r"\b(USD|GBP|EUR)\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\b")
_PERCENT = re.compile(r"\b(\d+(?:\.\d+)?)\s?%")
_TIME = re.compile(r"\b(\d{1,2}):(\d{2})(?:\s?([AaPp](?:\.[Mm]\.|[Mm]\b)))?(?!\d)")
_TIME_DOT = re.compile(r"(\d{1,2})\.(\d{2})\s?([AaPp]\.?[Mm]\.?)(?![A-Za-z])")
_DAY_ORD = re.compile(r"\b(\d{1,2})(st|nd|rd|th)\b")
_WEEKDAYS = {"Mon": "Monday", "Tue": "Tuesday", "Tues": "Tuesday", "Wed": "Wednesday", "Thu": "Thursday",
             "Thur": "Thursday", "Thurs": "Thursday", "Fri": "Friday", "Sat": "Saturday", "Sun": "Sunday"}
_WEEKDAY = re.compile(r"\b(" + "|".join(sorted(_WEEKDAYS, key=len, reverse=True)) + r")\b(?=[,.]?\s+(?:[A-Z][a-z]{2}\b|\d))")
_SHORT_MONTHS = {"Jan": "January", "Feb": "February", "Mar": "March", "Apr": "April", "Jun": "June", "Jul": "July",
                 "Aug": "August", "Sep": "September", "Sept": "September", "Oct": "October", "Nov": "November",
                 "Dec": "December"}
_SHORT_MONTH = re.compile(r"\b(" + "|".join(sorted(_SHORT_MONTHS, key=len, reverse=True)) + r")\.?(?=\s+\d)")
_ABBREVIATION_WORDS = [
    (re.compile(r"\be\.g\.", re.I), "for example"),
    (re.compile(r"\bi\.e\.", re.I), "that is"),
    (re.compile(r"\betc\.", re.I), "and so on"),
    (re.compile(r"\bapprox\.", re.I), "approximately"),
    (re.compile(r"\bvs\.?(?=\s)", re.I), "versus"),
    (re.compile(r"\s&\s"), " and "),
    (re.compile(r"\bw/o\b", re.I), "without"),
    (re.compile(r"\bw/(?=\s)", re.I), "with"),
    (re.compile(r"\bmin\.?(?=\s*\))"), "minutes"),
    (re.compile(r"\bID\b"), "I D"),
    (re.compile(r"\bPNR\b"), "P N R"),
    (re.compile(r"\bSMS\b"), "S M S"),
    (re.compile(r"\bGB\b"), "gigabytes"),
    (re.compile(r"\bMB\b"), "megabytes"),
    (re.compile(r"\bkg\b"), "kilograms"),
    (re.compile(r"\bUTC\b"), "U T C"),
]


def _say_money(m: re.Match[str]) -> str:
    symbol = m.group(1)
    one, many, cent_one, cent_many = _CURRENCIES.get(symbol, _CURRENCIES["$"])
    whole = int(m.group(2).replace(",", ""))
    out = f"{number_words(whole)} {one if whole == 1 else many}"
    if m.group(3):
        cents = int(m.group(3).ljust(2, "0"))
        if cents:
            out += f" and {number_words(cents)} {cent_one if cents == 1 else cent_many}"
    return out


def _say_iso_money(m: re.Match[str]) -> str:
    symbol = {"USD": "$", "GBP": "£", "EUR": "€"}[m.group(1)]
    fake = re.match(_MONEY, f"{symbol}{m.group(2)}" + (f".{m.group(3)}" if m.group(3) else ""))
    return _say_money(fake) if fake else m.group(0)


def _say_time(m: re.Match[str]) -> str:
    hh, mm, ap = int(m.group(1)), int(m.group(2)), m.group(3)
    if hh > 24 or mm > 59:
        return m.group(0)
    if ap:
        hour = hh if 1 <= hh <= 12 else hh
        minutes = "" if mm == 0 else (f"oh {number_words(mm)}" if mm < 10 else number_words(mm))
        suffix = "A M" if ap[0].lower() == "a" else "P M"
        return " ".join(x for x in (number_words(hour), minutes, suffix) if x)
    # 24-hour clock, as the schedule systems write it
    if mm == 0:
        return f"{number_words(hh)} hundred" if hh >= 13 else f"{number_words(hh)} o'clock"
    return f"{number_words(hh)} " + (f"oh {number_words(mm)}" if mm < 10 else number_words(mm))


def _spell(m: re.Match[str]) -> str:
    letters, digits = m.group(1), m.group(2)
    return " ".join(letters) + ", " + " ".join(digits)


def _say_date(m: re.Match[str]) -> str:
    y, mo, d, hh, mm = m.groups()
    month = _MONTHS[int(mo)] if 1 <= int(mo) <= 12 else mo
    out = f"{month} {ordinal_words(int(d))}"
    if hh is not None:
        h24, minute = int(hh), int(mm)
        h12 = h24 % 12 or 12
        minutes = "" if minute == 0 else (f"oh {number_words(minute)}" if minute < 10 else number_words(minute))
        out += " at " + " ".join(x for x in (number_words(h12), minutes, "A M" if h24 < 12 else "P M", "U T C") if x)
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
    t = re.sub(r"(?<=[A-Za-z])(?=[$£€]\d)", " ", t)  # "is$45" -> "is $45"
    t = _MONEY.sub(_say_money, t)
    t = _USD.sub(_say_iso_money, t)
    t = _PERCENT.sub(lambda m: f"{m.group(1)} percent", t)
    t = _TIME_DOT.sub(_say_time, t)
    t = _TIME.sub(_say_time, t)
    t = _WEEKDAY.sub(lambda m: _WEEKDAYS[m.group(1)], t)
    t = _SHORT_MONTH.sub(lambda m: _SHORT_MONTHS[m.group(1)], t)
    t = _DAY_ORD.sub(lambda m: ordinal_words(int(m.group(1))), t)
    for pattern, words in _ABBREVIATION_WORDS:
        t = pattern.sub(words, t)
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
    min_words: int = 3  # later phrases shorter than this are joined to the next one
    _buf: str = ""
    _carry: str = ""
    _last: str = ""
    _emitted: int = 0
    _out: list[str] = field(default_factory=list)

    def push(self, delta: str) -> list[str]:
        self._buf += delta
        return self._drain(final=False)

    def flush(self) -> list[str]:
        out = self._drain(final=True)
        rest = (self._carry + " " + self._buf).strip()
        self._buf = self._carry = ""
        if rest and not self._is_repeat(rest):
            out.append(rest)
            self._emitted += 1
        return out

    @staticmethod
    def _norm(s: str) -> str:
        return " ".join(re.findall(r"[a-z0-9']+", s.lower()))

    def _is_repeat(self, piece: str) -> bool:
        """The model sometimes restates its last sentence word for word; speak it once."""
        if not re.search(r"[.!?][\"')\]]*$", piece.strip()) or _words(piece) < 3:
            self._last = ""  # only whole sentences can repeat; a clause or a cut run-on cannot
            return False
        n = self._norm(piece)
        repeat = n == self._last
        self._last = n
        return repeat

    def _drain(self, final: bool) -> list[str]:
        out: list[str] = []
        while True:
            cut = self._find_cut(final)
            if cut is None:
                break
            piece, self._buf = self._buf[:cut].strip(), self._buf[cut:]
            if not piece:
                continue
            if self._carry:
                piece, self._carry = f"{self._carry} {piece}", ""
            if self._emitted > 0 and _words(piece) < self.min_words and not final:
                self._carry = piece  # too short to sound natural alone: wait for the next phrase
                continue
            if self._is_repeat(piece):
                continue
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
