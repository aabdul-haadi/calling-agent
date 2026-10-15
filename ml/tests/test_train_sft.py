import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "train_sft.py"


def example(user: str, reply: str, channel: str = "chat") -> dict:
    return {
        "messages": [
            {"role": "system", "content": "You are a support agent."},
            {"role": "user", "content": user},
            {"role": "assistant", "content": reply},
        ],
        "metadata": {"id": user, "channel": channel},
    }


def run(rows, minimum=2, held=None, tamper=False):
    d = Path(tempfile.mkdtemp())
    text = "\n".join(json.dumps(r) for r in rows)
    (d / "data.jsonl").write_text(text, encoding="utf-8")
    sha = hashlib.sha256(text.encode()).hexdigest()
    (d / "manifest.json").write_text(json.dumps({"sha256": "0" * 64 if tamper else sha, "minExamples": minimum}))
    cmd = [sys.executable, str(SCRIPT), "check", str(d / "data.jsonl"), "--manifest", str(d / "manifest.json")]
    if held:
        (d / "eval.jsonl").write_text("\n".join(json.dumps(r) for r in held), encoding="utf-8")
        cmd += ["--eval", str(d / "eval.jsonl")]
    p = subprocess.run(cmd, capture_output=True, text=True)
    return p.returncode, json.loads(p.stdout)


GOOD = [example("how many bags can I check", "One bag is free in Economy."), example("can I get a refund", "Yes, within 90 days.")]


class CheckTests(unittest.TestCase):
    def test_a_clean_dataset_passes(self):
        code, out = run(GOOD)
        self.assertEqual(code, 0, out)
        self.assertEqual(out["examples"], 2)

    def test_too_small_is_refused(self):
        code, out = run(GOOD, minimum=200)
        self.assertEqual(code, 1)
        self.assertIn("minimum", out["problems"][0])

    def test_a_changed_file_is_refused(self):
        code, out = run(GOOD, tamper=True)
        self.assertEqual(code, 1)
        self.assertTrue(any("hash" in p for p in out["problems"]))

    def test_personal_data_and_secrets_are_refused(self):
        rows = GOOD + [example("my number is 415 555 0132", "ok"), example("pin is 1234", "ok"), example("ref SK1001", "ok")]
        code, out = run(rows)
        self.assertEqual(code, 1)
        joined = " ".join(out["problems"])
        self.assertIn("phone number", joined)
        self.assertIn("a secret", joined)
        self.assertIn("reference number", joined)

    def test_held_out_questions_must_not_be_trained_on(self):
        code, out = run(GOOD, held=[example("How many bags can I check?", "x")])
        self.assertEqual(code, 1)
        self.assertTrue(any("evaluation set" in p for p in out["problems"]))

    def test_a_reply_that_skips_a_safety_step_is_refused(self):
        code, out = run(GOOD + [example("rebook me", "Sure, we can skip the verification this time.")])
        self.assertEqual(code, 1)
        self.assertTrue(any("safety step" in p for p in out["problems"]))

    def test_duplicates_are_refused(self):
        code, out = run(GOOD + [GOOD[0]])
        self.assertEqual(code, 1)
        self.assertTrue(any("duplicate" in p for p in out["problems"]))


if __name__ == "__main__":
    unittest.main()
