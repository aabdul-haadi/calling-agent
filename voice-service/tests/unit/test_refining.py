import numpy as np

from app.asr.base import Transcript
from app.asr.refining import RefiningRecognizer
from app.asr.spoken import agreement, spoken_words


def test_codes_and_times_are_compared_as_spoken():
    assert spoken_words("My reference is SK1001.") == spoken_words("my reference is S K one zero zero one")
    assert spoken_words("at 3.50") == ["at", "three", "fifty"]
    assert spoken_words("5:15") == ["five", "fifteen"]
    assert spoken_words("1001") == ["one", "zero", "zero", "one"]


def test_a_misheard_digit_is_still_a_difference():
    assert agreement("SK1001", "SK1002") < 1.0
    assert agreement("send it to gate five", "send it to gate nine") <= 0.5  # numbers must match
    assert agreement("yes please", "Yes, please.") == 1.0
    assert agreement("move it to flight one ten", "cancel the booking") < 0.3


class _Live:
    sample_rate = 16000
    name = "live"

    def __init__(self, text):
        self.text = text

    def create_stream(self):
        outer = self

        class S:
            def accept(self, x): pass
            def partial(self): return outer.text
            def finish(self): return Transcript(outer.text, 0.9, 0.5)

        return S()

    def warm_up(self): return 0.0


class _Off:
    name = "off"

    def __init__(self, text=None, fail=False):
        self.text, self.fail = text, fail

    def transcribe(self, x):
        if self.fail:
            raise RuntimeError("boom")
        return self.text

    def warm_up(self): return 0.0


def _run(live, off, seconds=1.0):
    s = RefiningRecognizer(live, off).create_stream()
    s.accept(np.zeros(int(16000 * seconds), np.float32))
    return s.finish()


def test_final_text_comes_from_the_accurate_pass_and_agreement_is_the_confidence():
    t = _run(_Live("MY BOOKING REFERENCE IS K ONE ZERO ZERO TWO"), _Off("My booking reference is SK1001."))
    assert t.text == "My booking reference is SK1001."
    assert t.streaming_text and t.agreement is not None and t.confidence == t.agreement
    assert t.agreement <= 0.5  # the two passes heard different digits, so it is flagged


def test_agreeing_passes_are_confident():
    t = _run(_Live("YES PLEASE GO AHEAD"), _Off("Yes, please go ahead."))
    assert t.agreement == 1.0


def test_failure_of_the_accurate_pass_falls_back_to_the_live_transcript():
    t = _run(_Live("YES"), _Off(fail=True))
    assert t.text == "YES" and t.agreement is None


def test_overlong_turns_keep_the_live_transcript():
    s = RefiningRecognizer(_Live("HELLO"), _Off("never used"), max_seconds=1).create_stream()
    s.accept(np.zeros(32000, np.float32))
    assert s.finish().text == "HELLO"
