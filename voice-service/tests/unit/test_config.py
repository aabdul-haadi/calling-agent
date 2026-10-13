import os

from app.config import load_env_file


def test_only_voice_settings_are_taken_from_the_env_file(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text(
        "# comment\nVOICE_GATEWAY_SECRET=abc123\nAGENT_RUNTIME_URL='http://example:4000'\n"
        "OPENAI_API_KEY=sk-should-not-be-read\nANTHROPIC_API_KEY=also-not\nVOICE_PORT=\n",
        encoding="utf-8",
    )
    for k in ("VOICE_GATEWAY_SECRET", "AGENT_RUNTIME_URL", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "VOICE_PORT"):
        monkeypatch.delenv(k, raising=False)
    assert load_env_file(env) == 2
    assert os.environ["VOICE_GATEWAY_SECRET"] == "abc123"
    assert os.environ["AGENT_RUNTIME_URL"] == "http://example:4000"
    assert "OPENAI_API_KEY" not in os.environ and "ANTHROPIC_API_KEY" not in os.environ
    assert "VOICE_PORT" not in os.environ  # an empty value is ignored


def test_a_real_environment_variable_wins_over_the_file(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text("VOICE_GATEWAY_SECRET=from-file\n", encoding="utf-8")
    monkeypatch.setenv("VOICE_GATEWAY_SECRET", "from-environment")
    assert load_env_file(env) == 0
    assert os.environ["VOICE_GATEWAY_SECRET"] == "from-environment"


def test_a_missing_file_is_fine(tmp_path):
    assert load_env_file(tmp_path / "nope.env") == 0
