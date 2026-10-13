import threading
import time

import numpy as np

from app.asr.base import Transcript
from app.asr.refining import RefiningRecognizer

AUDIO = np.ones(8000, np.float32) * 0.1


class Live:
    sample_rate = 16000
    name = "live"

    def create_stream(self):
        class S:
            def accept(self, x): pass
            def partial(self): return "YES PLEASE GO AHEAD"
            def finish(self): return Transcript("YES PLEASE GO AHEAD", 0.9, 0.5)
        return S()

    def warm_up(self): return 0.0


class Offline:
    name = "off"

    def __init__(self, delay=0.0, fail_first=False):
        self.calls = 0
        self.delay = delay
        self.fail_first = fail_first
        self.sizes: list[int] = []

    def transcribe(self, x):
        self.calls += 1
        self.sizes.append(x.size)
        if self.delay:
            time.sleep(self.delay)
        if self.fail_first and self.calls == 1:
            raise RuntimeError("boom")
        return "Yes, please go ahead."

    def warm_up(self): return 0.0


def stream(off):
    s = RefiningRecognizer(Live(), off).create_stream()
    s.accept(AUDIO)
    return s


def test_a_finished_prefetch_means_no_second_decode():
    off = Offline()
    s = stream(off)
    s.prefetch()
    s.accept(np.zeros(4800, np.float32))  # the silence that followed
    t = s.finish()
    assert off.calls == 1 and t.prefetched is True
    assert t.text == "Yes, please go ahead." and t.agreement == 1.0


def test_finish_waits_for_a_prefetch_that_is_still_running_instead_of_decoding_twice():
    off = Offline(delay=0.3)
    s = stream(off)
    worker = threading.Thread(target=s.prefetch)
    worker.start()
    time.sleep(0.05)
    t0 = time.perf_counter()
    t = s.finish()
    waited = time.perf_counter() - t0
    worker.join()
    assert off.calls == 1 and t.prefetched is True
    assert 0.15 < waited < 0.45  # it waited for the rest of the decode, not for a whole new one


def test_a_discarded_prefetch_is_never_used():
    off = Offline()
    s = stream(off)
    s.prefetch()
    s.discard_prefetch()
    s.accept(AUDIO)  # the customer carried on
    t = s.finish()
    assert off.calls == 2 and t.prefetched is False
    assert off.sizes[1] == 16000  # the final decode saw ALL the audio, including what was said after the pause


def test_a_failed_prefetch_falls_back_to_decoding_again():
    off = Offline(fail_first=True)
    s = stream(off)
    s.prefetch()
    t = s.finish()
    assert off.calls == 2 and t.prefetched is False and t.text == "Yes, please go ahead."


def test_without_a_prefetch_it_behaves_as_before():
    off = Offline()
    t = stream(off).finish()
    assert off.calls == 1 and t.prefetched is False


def test_only_one_prefetch_runs_at_a_time_and_nothing_starts_without_audio():
    off = Offline()
    empty = RefiningRecognizer(Live(), off).create_stream()
    empty.prefetch()
    assert off.calls == 0
    s = stream(off)
    s.prefetch()
    s.prefetch()
    assert off.calls == 1
