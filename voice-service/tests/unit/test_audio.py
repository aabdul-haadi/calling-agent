import numpy as np

from app.audio.resampling import float_to_pcm16, pcm16_to_float, resample
from evalab.metrics import corpus_wer, normalize_words, percentile, wer, word_errors


def tone(rate: int, seconds: float = 0.5, freq: float = 440.0) -> np.ndarray:
    t = np.arange(int(rate * seconds)) / rate
    return (0.5 * np.sin(2 * np.pi * freq * t)).astype(np.float32)


class TestResampling:
    def test_length_follows_the_rate_ratio(self):
        for src in (8000, 22050, 24000, 44100, 48000):
            out = resample(tone(src), src, 16000)
            assert abs(out.size - 8000) <= 2, src

    def test_same_rate_is_a_no_op(self):
        x = tone(16000)
        assert np.array_equal(resample(x, 16000, 16000), x)

    def test_a_tone_keeps_its_frequency(self):
        out = resample(tone(48000, 1.0, 1000.0), 48000, 16000)
        spectrum = np.abs(np.fft.rfft(out))
        assert abs(np.argmax(spectrum) * 16000 / out.size - 1000) < 5

    def test_pcm16_round_trip_and_clipping(self):
        x = np.array([0.0, 0.5, -0.5, 1.5, -1.5], dtype=np.float32)
        back = pcm16_to_float(float_to_pcm16(x))
        assert np.allclose(back[:3], x[:3], atol=1e-3)
        assert back[3] > 0.99 and back[4] < -0.99  # clipped, never wrapped to the opposite sign

    def test_odd_byte_count_is_tolerated(self):
        assert pcm16_to_float(b"\x01\x00\x02").size == 1


class TestMetrics:
    def test_wer_basics(self):
        assert wer("the cat sat", "the cat sat") == 0.0
        assert wer("the cat sat", "the cat") == 1 / 3
        assert wer("the cat sat", "a cat sat down") == 2 / 3
        assert word_errors("a b", "") == (2, 2)

    def test_wer_ignores_case_and_punctuation(self):
        assert wer("Hello, World!", "hello world") == 0.0
        assert normalize_words("It's 3 o'clock.") == ["it's", "3", "o'clock"]

    def test_corpus_wer_weights_by_length(self):
        assert corpus_wer([("a b c d", "a b c d"), ("e", "x")]) == 1 / 5

    def test_percentile_and_empty(self):
        assert percentile([1, 2, 3, 4, 5], 50) == 3
        assert percentile([1, 2, 3, 4, 5], 95) == 5
        assert np.isnan(percentile([], 95))  # a missing measurement is never reported as zero
