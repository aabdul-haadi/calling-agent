"""Compare transcripts as they would be SAID, so formatting is not mistaken for a recognition error.

One recognizer writes "SK1001" or "3.50", another writes "S K one zero zero one" or "three fifty":
the same words, spoken. `spoken_words` turns either into the same list of spoken words. It only
rewrites formatting. It never fixes a wrong word, so a misheard digit is still a difference.

Rules (documented in docs/VOICE.md):
  * lower case, punctuation dropped (apostrophes inside words are kept);
  * a code that mixes letters and digits ("sk1001") is read one character at a time:
    "s k one zero zero one";
  * a plain digit string is read one digit at a time ("1001" -> "one zero zero one"), except a
    clock time or price written "h.mm" / "h:mm", which is read as "h mm" ("3.50" -> "three fifty");
  * numbers up to 99 are spelled in full ("fifty").
"""

from __future__ import annotations

import re

_ONES = ("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen "
         "sixteen seventeen eighteen nineteen").split()
_TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()
_NUMBER_WORDS = frozenset(_ONES) | frozenset(_TENS[2:])
_TOKEN = re.compile(r"[a-z]+\d+[a-z\d]*|\d+[.:]\d+|\d+|[a-z]+(?:'[a-z]+)*")


def _upto_99(n: int) -> list[str]:
    if n < 20:
        return [_ONES[n]]
    tens, ones = divmod(n, 10)
    return [_TENS[tens]] + ([_ONES[ones]] if ones else [])


def _digits(s: str) -> list[str]:
    return [_ONES[int(c)] for c in s]


def spoken_words(text: str) -> list[str]:
    out: list[str] = []
    for tok in _TOKEN.findall(text.lower()):
        if tok[0].isdigit() and (":" in tok or "." in tok):
            hours, _, minutes = tok.replace(":", ".").partition(".")
            out += _upto_99(int(hours)) if len(hours) <= 2 else _digits(hours)
            if minutes.strip("0") != "":
                out += (["oh"] if minutes.startswith("0") and len(minutes) == 2 else []) + (
                    _upto_99(int(minutes)) if len(minutes) <= 2 else _digits(minutes)
                )
        elif tok.isdigit():
            out += _digits(tok) if len(tok) > 2 else _upto_99(int(tok))
        elif any(c.isdigit() for c in tok):
            for c in tok:
                out += [_ONES[int(c)]] if c.isdigit() else [c]
        else:
            out.append(tok)
    return out


def agreement(a: str, b: str) -> float:
    """1.0 when two transcripts say the same words, falling towards 0 as they differ."""
    x, y = spoken_words(a), spoken_words(b)
    if not x and not y:
        return 1.0
    prev = list(range(len(y) + 1))
    for i, p in enumerate(x, 1):
        cur = [i]
        for j, q in enumerate(y, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (p != q)))
        prev = cur
    score = max(0.0, 1.0 - prev[-1] / max(len(x), len(y)))
    # Two independent passes that hear different numbers have not agreed about the part that matters
    # most (references, times, amounts), however similar the rest of the sentence is.
    if [w for w in x if w in _NUMBER_WORDS] != [w for w in y if w in _NUMBER_WORDS]:
        score = min(score, 0.5)
    return score


# --------------------------------------------------------------------------------------------
# Spoken codes written out in words -> the code itself
# --------------------------------------------------------------------------------------------

_DIGIT_WORD = {"zero": "0", "oh": "0", "one": "1", "two": "2", "three": "3", "four": "4", "five": "5",
               "six": "6", "seven": "7", "eight": "8", "nine": "9"}
_DW = "|".join(_DIGIT_WORD)
_DIGIT_TOKEN = rf"(?:(?:double|triple)\s+)?(?:{_DW}|\d+)"
_SPOKEN_CODE = re.compile(
    rf"(?<![A-Za-z0-9])"
    rf"(?P<letters>(?:[A-Za-z][\s.\-]+){{1,3}}[A-Za-z]|(?-i:[A-Z]{{2,3}}))"      # S K  |  S.K.  |  SK (capitals only, so "is one two" is not a code)
    rf"[\s.\-]+"
    rf"(?P<digits>{_DIGIT_TOKEN}(?:[\s,.\-]+{_DIGIT_TOKEN}){{1,7}}|\d{{3,}})"
    rf"(?![A-Za-z0-9])",
    re.IGNORECASE,
)


def _digits_of(run: str) -> str:
    out: list[str] = []
    mult = 1
    for tok in re.findall(r"[A-Za-z]+|\d+", run.lower()):
        if tok == "double":
            mult = 2
        elif tok == "triple":
            mult = 3
        else:
            out.append((_DIGIT_WORD.get(tok) or tok) * mult)
            mult = 1
    return "".join(out)


def normalize_spoken_codes(text: str) -> str:
    """"my reference is S K one zero zero one" -> "my reference is SK1001".

    Speech recognizers often write a code letter by letter and digit by digit. The tools need the
    code itself. Only a run of letters directly followed by at least three digits is joined, so
    ordinary sentences ("I have two bags") are left alone. This changes formatting, never a letter or
    digit: what was heard is what is written.
    """

    def join(m: re.Match[str]) -> str:
        digits = _digits_of(m.group("digits"))
        letters = re.sub(r"[^A-Za-z]", "", m.group("letters"))
        # "a" / "I" followed by numbers is usually a word ("I two..."), so require 2+ letters
        if len(digits) < 3 or len(letters) < 2:
            return m.group(0)
        return letters.upper() + digits

    return _SPOKEN_CODE.sub(join, text)
