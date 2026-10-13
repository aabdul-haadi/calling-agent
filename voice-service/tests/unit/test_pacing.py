import numpy as np

from app.tts.pacing import Pacer, trim_silence

RATE = 16000


def tone(ms, amp=0.3):
    return (amp * np.sin(2 * np.pi * 200 * np.arange(int(RATE * ms / 1000)) / RATE)).astype(np.float32)


def quiet(ms):
    return np.zeros(int(RATE * ms / 1000), np.float32)


def ms(x):
    return round(1000 * x.size / RATE)


def test_trims_quiet_but_never_speech():
    x = np.concatenate([quiet(100), tone(300), quiet(200)])
    y = trim_silence(x, RATE, 20, 60)
    assert 20 <= ms(y) - 300 - 60 <= 21
    assert np.isclose(np.sum(y**2), np.sum(tone(300) ** 2), rtol=0.01)  # all the speech is still there


def test_never_makes_a_pause_longer_than_it_was():
    x = np.concatenate([tone(100), quiet(30)])
    assert ms(trim_silence(x, RATE, None, 200)) == 130


def play(phrase, chunks, **kw):
    out: list[np.ndarray] = []
    p = Pacer(lambda a: out.append(a) or True, RATE, phrase, last_phrase=False, sentence_ms=160, clause_ms=60, **kw)
    for c in chunks:
        assert p(c)
    p.finish()
    return np.concatenate(out)


def test_a_sentence_ends_with_a_longer_pause_than_a_clause():
    chunk = np.concatenate([quiet(80), tone(300), quiet(250)])
    sentence = play("That is all.", [chunk])
    clause = play("That is all,", [chunk])
    assert ms(sentence) - ms(clause) == 100
    assert 450 < ms(sentence) < 500


def test_speech_is_identical_across_split_chunks():
    whole = np.concatenate([tone(400), quiet(250)])
    parts = [whole[:5000], whole[5000:]]
    assert np.isclose(np.sum(play("Hello there friend.", parts) ** 2), np.sum(tone(400) ** 2), rtol=0.01)


def test_holds_nothing_back_when_empty():
    p = Pacer(lambda a: True, RATE, "x", last_phrase=False, sentence_ms=1, clause_ms=1)
    assert p.finish() is True
