# ADK voice service

The local speech engine behind the Voice Lab: voice activity detection, streaming speech recognition, speech synthesis and barge-in, as a FastAPI WebSocket gateway. It carries audio only. Every business decision stays in the TypeScript agent runtime, which this service reaches through `POST /chat/stream`.

Full documentation (architecture, wire protocol, security, settings, measured performance): [`../docs/VOICE.md`](../docs/VOICE.md).

```bash
# from the repository root
pnpm voice:setup      # venv + packages + models (first time)
pnpm voice            # run the gateway on :8765
pnpm voice:test       # all tests
pnpm voice:bench      # benchmarks (evalab/)
```

Or by hand, inside `voice-service/`:

```bash
python -m venv .venv && .venv/Scripts/activate        # use .venv/bin/activate on macOS and Linux
pip install -e ".[dev]"
python -m app.tools.download_models                    # verifies SHA-256 hashes
python -m app.main                                     # or: uvicorn app.main:create_app --factory
pytest                                                 # tests/unit, tests/security, tests/integration
python -m evalab.asr_bench                             # recognition accuracy by condition
python -m evalab.turn_bench                            # latency, barge-in, false interruptions
```

Layout: `app/api` (WebSocket, health), `app/sessions` (turn taking, barge-in), `app/audio` (framing, VAD, resampling), `app/asr` and `app/tts` (swappable engines behind small protocols), `app/protocols` (events, schemas), `app/integrations/agent_runtime.py` (the only outbound call), `evalab/` (fixtures and benchmarks), `tests/`.
