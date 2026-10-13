import pytest

from app.tts.text import Chunker, speakable


def chunks(text: str, step: int = 5) -> list[str]:
    """Feed the text in small pieces, the way a streaming model delivers it."""
    c = Chunker()
    out: list[str] = []
    for i in range(0, len(text), step):
        out += c.push(text[i : i + step])
    return out + c.flush()


class TestSpeakable:
    def test_removes_markdown_citations_links_and_emoji(self):
        raw = "**Your flight** is [cancelled](https://x.test) [Source: refunds] \U0001F61E\n- Option one"
        out = speakable(raw)
        assert "*" not in out and "http" not in out and "Source" not in out and "\U0001F61E" not in out
        assert out.startswith("Your flight is cancelled")
        assert "Option one" in out

    def test_citation_variants(self):
        assert speakable("Refunds take 7 days 【Source: refunds】.") == "Refunds take 7 days ."
        assert "Source" not in speakable("Yes (Source: checked-baggage) you can.")

    def test_reference_codes_are_spelled_out(self):
        out = speakable("Booking SK1001 is on flight SK110.")
        assert "S K, 1 0 0 1" in out and "S K, 1 1 0" in out

    def test_iso_dates_become_words(self):
        assert speakable("It leaves 2026-11-10T11:00:00.000Z") == "It leaves November tenth at eleven A M U T C"

    def test_keeps_ordinary_sentences_untouched(self):
        s = "I can move you to the next flight, and there is no charge."
        assert speakable(s) == s


class TestChunker:
    def test_splits_on_sentences_and_keeps_punctuation(self):
        out = chunks("Your flight was cancelled. I can rebook you. Shall I go ahead?")
        assert out == ["Your flight was cancelled.", "I can rebook you.", "Shall I go ahead?"]

    def test_never_loses_or_reorders_text(self):
        text = "Hello there, my friend. This is a longer sentence, with a clause, and more words after it! Done."
        assert " ".join(chunks(text, 3)) == text

    def test_first_phrase_is_cut_early_at_a_clause_but_never_after_one_word(self):
        text = "Okay, let me look at your booking details for you and then explain what happens next, shall we?"
        out = chunks(text)
        # "Okay," alone would sound abrupt, so the first cut waits for a clause of at least 4 words.
        assert out[0].startswith("Okay, let me look") and out[0].endswith("what happens next,")
        assert out[1] == "shall we?"

    def test_later_clauses_need_more_words_than_the_first(self):
        out = chunks("First phrase is fine here, short bit, and then the rest of the sentence goes on and on, until the end.")
        assert out[0] == "First phrase is fine here,"
        assert out[1].startswith("short bit, and then")  # "short bit," is too short on its own

    def test_abbreviations_and_decimals_do_not_end_sentences(self):
        assert chunks("Dr. Smith will call you back.") == ["Dr. Smith will call you back."]
        assert chunks("The fee is 3.5 dollars today.") == ["The fee is 3.5 dollars today."]

    def test_trailing_terminator_waits_for_more_text(self):
        c = Chunker()
        assert c.push("The fee is 3.") == []  # could still become 3.5
        assert c.push("5 dollars.") == []  # terminator at the very end: wait
        assert c.flush() == ["The fee is 3.5 dollars."]

    def test_run_on_text_is_cut_at_a_word_boundary(self):
        words = " ".join(["word"] * 70)
        out = chunks(words, 7)
        assert all(len(o.split()) <= 28 for o in out)
        assert " ".join(out) == words

    def test_does_not_cut_inside_a_citation(self):
        out = chunks("Refunds take seven business days [Source: refunds, cancellations]. Anything else?")
        assert out == [
            "Refunds take seven business days [Source: refunds, cancellations].",
            "Anything else?",
        ]

    def test_empty_input(self):
        assert chunks("") == []
        assert Chunker().flush() == []

    @pytest.mark.parametrize("step", [1, 2, 7, 50])
    def test_same_result_whatever_the_delivery_granularity(self, step):
        text = "First sentence here. Second sentence follows, and it has a clause. Third?"
        assert chunks(text, step) == chunks(text, 1000)


class TestSpokenRendering:
    def test_money_percent_and_ordinals(self):
        out = speakable("The fee is $45.50, or $120 for two bags, 20% off on the 3rd.")
        assert "forty-five dollars and fifty cents" in out and "one hundred twenty dollars" in out
        assert "20 percent" in out and "the third" in out

    def test_clock_times_read_naturally(self):
        assert speakable("Boarding at 3:50 PM.") == "Boarding at three fifty P M."
        assert speakable("Departs 9:05 am.") == "Departs nine oh five A M."
        assert speakable("Arrives 15:05 today.") == "Arrives fifteen oh five today."

    def test_short_weekdays_months_and_abbreviations(self):
        assert speakable("Mon, Oct 12") == "Monday, October 12"
        assert speakable("Bring ID, e.g. a passport") == "Bring I D, for example a passport"

    def test_codes_stay_digit_by_digit(self):
        assert "S K, 1 1 0" in speakable("Flight SK110")

    def test_numbers_that_are_not_money_or_time_are_untouched(self):
        assert speakable("Refunds take 7 business days.") == "Refunds take 7 business days."

    def test_ordinal_words(self):
        from app.tts.text import ordinal_words
        assert [ordinal_words(n) for n in (1, 2, 3, 12, 20, 21, 30)] == [
            "first", "second", "third", "twelfth", "twentieth", "twenty-first", "thirtieth"]


class TestChunkingForNaturalSpeech:
    def test_a_restated_sentence_is_spoken_once(self):
        assert chunks("I can move you to flight one ten. I can move you to flight one ten. Shall I?") == [
            "I can move you to flight one ten.", "Shall I?"]

    def test_tiny_later_phrases_join_the_next_one(self):
        out = chunks("I found two flights for you today. Okay. Do you want the earlier one or the later one?")
        assert out == ["I found two flights for you today.", "Okay. Do you want the earlier one or the later one?"]

    def test_the_first_short_phrase_is_not_held_back(self):
        assert chunks("Sure. I can check that for you right now.")[0] == "Sure."


def test_money_glued_to_a_word_still_reads_as_money():
    assert speakable("The fee is$45.50") == "The fee is forty-five dollars and fifty cents"
