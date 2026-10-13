# Voice engine (local, interruptible)

A browser voice experience with a local speech stack: natural turn-taking, replies that start while the agent is still writing them, and a customer who can **talk over the agent at any moment**. It is optional. Without it, voice falls back to the browser's own speech recognition, exactly as before.

> **The one rule.** The Python voice service carries audio. Every business decision still happens in the TypeScript agent runtime: who the customer is, what a tool may do, whether a change is approved, what the agent says. The voice service cannot call a company system, cannot approve anything, and holds no customer data beyond a conversation id. `voice-service/tests/security/` proves it.

## Architecture

```
Browser                     Voice gateway (Python)                  Agent runtime (TypeScript)
-------                     ----------------------                  --------------------------
microphone                  VAD (Silero)  ── speech start/end
 └ AudioWorklet 16 kHz ───▶ streaming ASR (zipformer) ── partials, final transcript
   PCM16 frames (binary)    turn manager (barge-in, generations)
                            │  final transcript ──────────────────▶ POST /chat/stream  (NDJSON events)
                            │                                         classify → approvals → RAG → tools
                            │  ◀──────────── text deltas, tool events, approval.required, handoff
                            sentence/clause chunker
                            TTS (Piper VITS) ── phrase by phrase
speakers ◀── agent audio ── bounded queue, stale-audio filter
 └ Web Audio, instant stop
```

| Piece                 | Where                                                                                        | Notes                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Capture, playback, UI | `frontend/src/voice/`, `public/voice-capture.worklet.js`, `components/voice/gateway-lab.tsx` | Echo cancellation, noise suppression and auto gain are requested from the browser.     |
| Gateway               | `voice-service/app/`                                                                         | FastAPI + WebSocket. Session logic in `sessions/session.py`.                           |
| Speech models         | `voice-service/models/` (downloaded, not committed)                                          | Silero VAD, zipformer streaming ASR, Piper voice, all through `sherpa-onnx`, CPU only. |
| Streaming turns       | `backend/src/routes/chat.ts` (`POST /chat/stream`)                                           | One JSON event per line. Closing the connection cancels the turn.                      |
| Session tokens        | `backend/src/voice/token.ts`, `backend/src/routes/voice.ts`                                  | `POST /voice/session`, `GET /voice/status`.                                            |

### What changed in the TypeScript runtime

- **Streaming.** The OpenAI-compatible and Anthropic adapters stream reply text when asked (`onTextDelta`); without it they behave exactly as before. Reasoning is never forwarded.
- **Cancellation.** `runTurn` takes an `AbortSignal`. It stops at safe points: before the model call, between tool calls, before the next step. **A tool call that has started always finishes**, and nothing is rolled back. State, trace and the customer's words are saved, no reply is saved, and an `turn_cancelled` audit record is written.
- **An approval that had not started lapses.** If the customer said "yes" and then interrupted before the change began, the approval is gone at the next turn (approvals cover one turn) and the customer is asked again. A change already in flight is recorded and cannot be repeated.
- **Doubtful transcripts cannot approve.** The gateway flags a transcript the recognizer was unsure about (`voice.lowConfidence`). The runtime then refuses to read "yes" from it as approval and tells the agent to ask again.
- **Voice prompt.** On voice the agent reads booking references back, never guesses a value it is unsure of, and reads out the exact flight and time when asking for approval.
- **Events never carry tool arguments or model reasoning.** They name tools and outcomes only.

## The wire protocol (version 1)

Audio is **binary**, never base64 JSON. Control and events are small JSON objects.

**Client to server**

| Message                                                    | Format                                                                                              |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `session.start` (first message, required)                  | JSON `{ "type":"session.start", "protocol":1, "token":"…", "sampleRate":16000, "conversationId"? }` |
| audio                                                      | binary: `u8 type=0x01, u8 flags=0, u16 reserved=0`, then mono PCM16 little-endian at `sampleRate`   |
| `control.interrupt`                                        | JSON: the stop button                                                                               |
| `playback.started` / `playback.stopped` / `playback.ended` | JSON with `turn` (and `stopMs` on stopped): the browser reports what it played                      |
| `session.end`                                              | JSON                                                                                                |

**Server to client.** JSON events carry `type`, `session`, `seq` (strictly increasing, assigned at send time), `t` (ms since start) and, where it applies, `turn`.

| Event                                                                                                        | Meaning                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.started`                                                                                            | Accepted. Carries rates and limits.                                                                                                                                                                |
| `speech.started`, `transcript.partial`, `transcript.final`                                                   | The customer's turn. `final` has `confidence` and `lowConfidence`. Partial text is tentative.                                                                                                      |
| `turn.discarded`                                                                                             | Noise or a blip that was not speech.                                                                                                                                                               |
| `agent.thinking`, `knowledge.used`, `tool.started`, `tool.completed`, `approval.required`, `handoff.started` | The agent working. Names and outcomes only.                                                                                                                                                        |
| `agent.text.delta`                                                                                           | Text as it is written (for captions).                                                                                                                                                              |
| `agent.speaking`, `agent.speech.completed`                                                                   | Audio starting / all audio sent.                                                                                                                                                                   |
| `agent.interrupted`                                                                                          | The reply was cancelled. **Silence the speaker now.**                                                                                                                                              |
| `turn.metrics`, `turn.completed`                                                                             | Server-side timings, and how the turn ended.                                                                                                                                                       |
| `session.error`                                                                                              | `code`, `message`, `fatal`. Codes: `bad_frame`, `bad_message`, `unauthorized`, `rate_limited`, `turn_too_long`, `timeout`, `asr_failed`, `tts_failed`, `agent_unavailable`, `service_unavailable`. |
| `session.closed`                                                                                             | Goodbye, with a reason.                                                                                                                                                                            |

Agent audio arrives as binary frames: `u8 type=0x02, u8 flags (bit0 = last), u16 reserved, u32 turn, u32 chunk, u32 sampleRate`, then PCM16 mono. A header-only frame with the last flag marks the end of a reply.

**Ordering and stale audio.** Each reply belongs to a _turn_ number that only increases. When a reply is cancelled the server (1) bumps a generation so every queued chunk is dropped before it is sent, (2) sends `agent.interrupted` ahead of any remaining audio, and (3) the browser mutes at once and refuses any later frame of that turn or an older one. Late or reordered frames are therefore never heard.

## Security and limits

- **Authentication.** The browser asks the backend for a token (`POST /voice/session`), valid 60 seconds, signed with HMAC-SHA256 using `VOICE_GATEWAY_SECRET`, naming the tenant, and usable once. The gateway checks signature, age and reuse. The **tenant comes only from the signed token**; the client cannot choose another.
- **Origin check** on the WebSocket against `VOICE_ALLOWED_ORIGINS`.
- **Bounded everything.** Frame size, control message size, frames per second, audio per turn (30 s), session length (15 min), idle time (2 min), concurrent sessions (6, 3 per address), outbound audio queue (backpressure slows synthesis instead of growing memory), malformed-frame budget.
- **No audio or transcript is stored or logged.** `/health` and `/metrics` contain aggregates only.
- **Prompt injection.** A spoken instruction is the same untrusted text as a typed one: it goes to the runtime unchanged, through the same allow-list, validation, verification, rules and approval binding.
- **No login yet.** `POST /voice/session` is open like the rest of the API. A real deployment must authenticate staff and customers before issuing tokens.

## Run it

```bash
pnpm voice:setup      # Python 3.11-3.13 venv, packages, and the models (about 460 MB, first time only)
# add VOICE_GATEWAY_SECRET=<any random string> to .env (the backend and the gateway both read it)
pnpm dev              # backend, mock systems, frontend
pnpm voice            # the voice gateway, on port 8765 (loads models in about 7 s)
```

Open the **Voice Lab**. It uses the local engine when `GET /voice/status` says it is ready and shows why when it is not. Use Chrome or Edge, allow the microphone, and prefer headphones.

Other commands: `pnpm voice:models` (download or verify), `pnpm voice:test`, `pnpm voice:bench` (see below).

### Settings (`.env`, all optional)

| Variable                                                                      | Default                 | Meaning                                                                                                                                                                               |
| ----------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VOICE_GATEWAY_SECRET`                                                        | none                    | Required. Shared with the backend.                                                                                                                                                    |
| `VOICE_PORT` / `VOICE_HOST`                                                   | 8765 / 127.0.0.1        | Where the gateway listens.                                                                                                                                                            |
| `VOICE_ALLOWED_ORIGINS`                                                       | `http://localhost:5173` | Pages allowed to connect.                                                                                                                                                             |
| `AGENT_RUNTIME_URL`                                                           | `http://127.0.0.1:4000` | The TypeScript backend.                                                                                                                                                               |
| `VOICE_ASR_MODEL`                                                             | `zipformer-large`       | Or `zipformer-20m` (smaller, faster, drops leading words on real speech).                                                                                                             |
| `VOICE_VAD_THRESHOLD`, `VOICE_MIN_SPEECH_MS`                                  | 0.5, 64                 | Starting a turn.                                                                                                                                                                      |
| `VOICE_END_SILENCE_MS`                                                        | 600                     | Silence that ends a turn.                                                                                                                                                             |
| `VOICE_HOLD_HANGING_MS`                                                       | 600                     | Extra wait when a sentence stops on "and", "is", "my"…                                                                                                                                |
| `VOICE_BARGE_IN_THRESHOLD`, `VOICE_BARGE_IN_MIN_MS`, `VOICE_BARGE_IN_MIN_RMS` | 0.7, 96, 0.015          | What counts as an interruption.                                                                                                                                                       |
| `VOICE_ASR_REFINE`                                                            | `parakeet-tdt-0.6b-v2`  | Accurate second pass over each finished turn. `off` uses the live model only (about 0.5 s faster, clearly less accurate).                                                             |
| `VOICE_DIAGNOSTICS`                                                           | off                     | `1` saves each turn's audio and transcripts under `voice-service/diagnostics/` (see Diagnosing recognition).                                                                          |
| `VOICE_TTS_MODEL`                                                             | `piper-amy-medium`      | The agent's voice: `piper-amy-low`, `piper-amy-medium`, `piper-hfc-female-medium`, `piper-lessac-high`, `kokoro`. Falls back to `piper-amy-low` if the chosen voice is not installed. |
| `VOICE_TTS_SPEED`                                                             | 1.0                     | Default speed; each company's profile can override it.                                                                                                                                |
| `VOICE_PAUSE_SENTENCE_MS`, `VOICE_PAUSE_CLAUSE_MS`                            | 160, 60                 | Pause after a sentence, and after a comma-sized phrase.                                                                                                                               |
| `VOICE_PROGRESS_AFTER_S`                                                      | 3                       | A lookup must run this long before the "still checking" line may be spoken.                                                                                                           |

## Models and hardware

| Model                                          | Size on disk | Licence                                            | Used for              |
| ---------------------------------------------- | ------------ | -------------------------------------------------- | --------------------- |
| Silero VAD (`silero_vad.onnx`)                 | 0.6 MB       | MIT                                                | Speech start/end      |
| sherpa-onnx streaming zipformer en, 2023-06-26 | 321 MB       | Apache-2.0                                         | Speech recognition    |
| Piper `en_US-amy-medium`                       | 78 MB        | Check the voice's model card before commercial use | Agent voice (default) |

Downloads are checked against pinned SHA-256 hashes. Optional: the 20M recognizer (`pnpm voice:models -- --only asr-small`). Everything runs on CPU; the baseline machine was an i7-6700 (4 cores, 8 threads) with 16 GB of RAM and no usable GPU. Python 3.14 is not supported yet because the speech libraries have no wheels for it.

## Speech recognition accuracy

**What was wrong.** The first version used one small _streaming_ model for everything. A streaming model commits to each word with almost no look-ahead and was trained on read audiobook speech, so on ordinary speech, accents and booking references it made many errors (for example "SK1001" came out as "K ONE'S ERO ZERO ONE"). Capture was checked and is not the cause: the browser delivers mono audio, the worklet averages it down to 16 kHz, frames arrive in order, and the gateway feeds the recognizer the same samples it measures.

**What it does now.** Two passes. The streaming model still produces the live captions and detects speech. When the customer finishes, the whole utterance is re-decoded by Parakeet TDT 0.6B v2, an offline model that sees the full sentence, and _that_ text goes to the agent. If the second pass fails or is switched off, the live text is used, so it can never be worse than before.

**Confidence, honestly.** Parakeet gives no word probabilities, so none are invented. The signal used is whether the two independent passes _agree_, compared as spoken words (`app/asr/spoken.py`: "SK1001" and "S K one zero zero one" are equal, but a different digit is a difference). If they disagree about any number, or about half the words, the transcript is flagged uncertain and the agent asks the customer to repeat instead of acting on it. Spoken approval still has to match the exact proposal in the runtime.

### Measured (this machine: i7-6700, 8 threads, no GPU; `python -m evalab.model_bench`)

114 clips: spoken phrases (greetings, booking references, a last name, clock times, refunds, long sentences) under 8 conditions (clean, noise at 20/10/5 dB SNR, babble, telephone band, fast, long pauses) from the local synthetic voice, plus the real recordings that ship with the model (3). Scoring compares _spoken_ forms (rules in `app/asr/spoken.py`), so formatting is not counted as an error but a wrong word or digit is.

|                                                                   | Streaming only (before)       | With Parakeet pass (after)                               |
| ----------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------- |
| Word error rate, all clips                                        | 0.129                         | 0.024                                                    |
| WER, clean / 10 dB noise / babble / telephone                     | 0.115 / 0.103 / 0.152 / 0.115 | 0.030 / 0.012 / 0.024 / 0.012                            |
| Booking reference heard exactly                                   | 50%                           | 94%                                                      |
| Clock times heard exactly                                         | 100%                          | 100%                                                     |
| Whole critical clip word for word (includes the surname "Okafor") | 29%                           | 62%                                                      |
| Extra decode time after speech ends                               | about 50 ms                   | median 0.5 s, 95th percentile 1.5 s (long 13 s sentence) |
| Real-time factor                                                  | 0.011                         | 0.139                                                    |
| Extra memory                                                      | -                             | about 700 MB                                             |

Still wrong after the change: the rare surname "Okafor" (heard as "Akafer"), and homophones ("fare" / "fair", "rebook" / "rebuke"). The agent already reads names and codes back before acting.

**Cost.** The more accurate pass adds time. End-to-end (`python -m evalab.turn_bench --quick`, synthetic voice, scripted reply, 8 turns): end of speech to final transcript median 1.18 s, p95 1.38 s (was p95 0.75 s); end of speech to first audio median 1.36 s, p95 1.53 s. That misses the earlier 800 ms transcript target and the 1.2 s median first-audio target, and meets the 2.5 s p95. Accuracy was chosen over speed because a wrong transcript costs the customer far more than half a second. Set `VOICE_ASR_REFINE=off` to trade back.

**Not measured, important.** All of the above uses a synthetic voice and three read-speech recordings. It has **no Pakistani-accent, Urdu-English code-switching or real-microphone recordings**, because none exist in this repository and nothing was invented. Parakeet v2 is an English model: Urdu words will be wrong. Use the diagnostics below to measure your own voice.

### Diagnosing recognition (opt-in, off by default)

```bash
# 1. in .env:  VOICE_DIAGNOSTICS=1   then restart `pnpm voice`
# 2. talk to the Voice Lab for a while; each turn is saved in voice-service/diagnostics/ (WAV + JSON)
cd voice-service
.venv/Scripts/python -m evalab.label                 # type what you actually said, per capture
.venv/Scripts/python -m evalab.model_bench --captures   # score the models on YOUR microphone audio
```

Each JSON holds the level, peak, clipped and silent fractions, what each pass heard, their agreement and the second pass's time. This is the only place audio or transcripts are written to disk; it is local, git-ignored, and turning the setting off (or deleting the folder) removes it. Check `pnpm voice` output for the warning that it is on.

## Sounding natural

### What made it sound robotic (audit)

1. **Wording written for a screen.** The voice prompt said only "1-3 short sentences, no lists". Replies were formal ("Please provide the required booking reference"), restated the request, or ended with a stock offer of more help. The old reply to "How many bags?" even carried a `[Source: ...]` label (the speech layer removed it, but the model was writing for a page).
2. **One low-rate voice.** Piper `amy-low` (16 kHz) was the only voice, shared unchanged by every company.
3. **Every phrase ended with the engine's own silence** (100-160 ms), so a pause fell after every comma-sized phrase.
4. **Little spoken rendering.** Codes and ISO dates were handled. Money ("$45.50"), clock times ("3:50 PM", "15:05"), percentages, ordinals, weekday and month abbreviations and "e.g." were left for the voice engine to guess.
5. **No per-company voice settings.** Style lived in one free-text `voiceStyle` line.

Already right and unchanged: the agent runtime stays the only authority, replies stream phrase by phrase (speech starts before the reply is finished), and interruption, cancellation and stale-audio protection work as before.

### Configuration (per company, in `client.config.ts`)

`persona.voice` is optional and holds style and speech preferences only. It cannot grant a permission, change a rule or name a tool (a test checks this).

| Field            | Meaning                                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| `language`       | BCP-47 tag, default `en-US`.                                                                                |
| `verbosity`      | `brief` (one or two sentences), `balanced` (up to four), `detailed`.                                        |
| `style`          | Up to 8 short instructions added to the spoken style, for example "Say flight numbers slowly and exactly".  |
| `speech.speaker` | Speaker name on a multi-speaker voice (Kokoro); ignored by single-voice models.                             |
| `speech.speed`   | 0.8 to 1.25.                                                                                                |
| `progressLine`   | One short line spoken only if a lookup has really been running for 3 seconds and nothing has been said yet. |

SkyLink Air (calm, efficient, exact about flight numbers and times, never promises a seat before the search) and NovaTel (friendly, patient, plain words about bills, never claims a payment or change went through without a tool result) are configured this way. NovaTel now also accepts voice.

The runtime sends the speech settings at the start of each voice turn; the gateway validates them (speaker name pattern, speed range, line length) and treats them as untrusted.

### How it fits together

- **Prompt** (`backend/src/agent/prompt.ts`): an engine-wide spoken style (answer first, one question at a time, no stock openers or closers, apologise once, no lists or markdown, "say yes" not "reply yes", truthful progress only, state the exact change and any fee before asking for yes) plus the company's `style`. Every safety rule is unchanged, and a test checks they are all present in the voice prompt.
- **Accurate text versus spoken rendering.** The model writes numbers, times, money and codes normally (`SK110`, `3:50 PM`, `$45.50`). `speakable()` turns them into words for the voice ("S K, 1 1 0", "three fifty P M", "forty-five dollars and fifty cents"). The saved reply and the on-screen text are the accurate version. The speech layer rewrites formatting, never meaning, and removes citations, links and markdown.
- **Chunking** (`Chunker`): sentence boundaries, and a comma only once the phrase is long enough. A later phrase shorter than 3 words joins the next one. A sentence the model restates word for word is spoken once.
- **Pacing** (`app/tts/pacing.py`): the engine's own leading and trailing silence is trimmed and replaced by a deliberate pause (160 ms after a sentence, 60 ms after a clause). Only silence is touched, and only the last 250 ms of a phrase is held back, so streaming latency is unchanged.
- **Progress line.** Never spoken unless a real `tool.started` event arrived and 3 seconds passed with nothing said. Cancelled the moment the tool finishes or any text arrives. No fillers such as "hmm" are generated.
- **Speaker and speed** are applied per phrase from the company profile.

### Voice models compared

Machine: i7-6700 (4 cores, 8 threads), no GPU. Command: `python -m evalab.tts_bench`. The same 12 sentences go through the same rendering layer for every voice (dates, money, times, a flight number, a booking reference, a surname, a long sentence). "First audio" is the time to the first audio sample of a whole sentence. Intelligibility is a round trip: the audio is transcribed by the accurate recognizer and compared, as spoken words, with what was meant. It checks that digits and amounts survive. It says nothing about how pleasant a voice is.

| Voice                          | Rate      | Licence        | Memory  | Cold first audio | Warm first audio p50 / p95 | Real-time factor | Round-trip WER |
| ------------------------------ | --------- | -------------- | ------- | ---------------- | -------------------------- | ---------------- | -------------- |
| Piper amy-low (previous)       | 16 kHz    | see model card | +80 MB  | 109 ms           | 305 / 409 ms               | 0.06             | 0.011          |
| **Piper amy-medium (default)** | 22.05 kHz | see model card | +76 MB  | 101 ms           | 347 / 518 ms               | 0.08             | 0.033          |
| Piper hfc_female-medium        | 22.05 kHz | see model card | +78 MB  | 100 ms           | 334 / 527 ms               | 0.09             | 0.055          |
| Piper lessac-high              | 22.05 kHz | see model card | +132 MB | 400 ms           | 1356 / 2171 ms             | 0.37             | 0.022          |
| Kokoro 82M v1.0, af_heart      | 24 kHz    | Apache-2.0     | +424 MB | 777 ms           | 2115 / 3228 ms             | 0.59             | 0.022          |
| Kokoro 82M v1.0, am_adam       | 24 kHz    | Apache-2.0     | +424 MB | -                | 2145 / 3212 ms             | 0.59             | 0.027          |

Timings move by tens of percent with whatever else the machine is doing (an earlier run of the same benchmark gave Kokoro 3.0 s). Intelligibility differences are a handful of words out of about 150, and the one error every voice makes is the rare surname "Okafor". Treat intelligibility as equal.

**Choice: Piper amy-medium.** It is the same speaker as before at a higher sampling rate. Latency is in the same class as the old voice but not equal: about 40 ms slower at the median and 110 ms slower at the 95th percentile for a whole sentence, and the end-to-end quick benchmark shows first audio 75 ms slower at the median (1.36 s to 1.44 s) and 120 ms at the 95th percentile (1.53 s to 1.65 s). Memory is +76 MB and it needs no GPU. So TTS latency is slightly worse, not "preserved", and the quality gain is unverified (below). Kokoro is the most natural-sounding family by reputation and offers many speakers, which would let SkyLink and NovaTel sound different. On this CPU its first phrase takes about 1.7 to 2 s, which would push first audio past the 2.5 s target, so it ships as an optional voice for faster hardware (`VOICE_TTS_MODEL=kokoro`, `pnpm voice:models -- --only tts-kokoro`). `VOICE_TTS_MODEL=piper-amy-low` restores the previous voice.

**Nobody has listened yet.** Naturalness cannot be measured by a script, and no person has rated these voices. `voice-service/evalab/results/tts_samples/` holds every voice's audio with a blank rating sheet (`tts_listening_sheet.md`). `voice-service/evalab/results/ab/` holds six before/after pairs (old voice and wording against the new) with `ab_listening_sheet.md`, made by `python -m evalab.ab_samples`. Choosing amy-medium is a latency and fidelity decision with a plausible but unverified quality gain.

### Replies before and after (real model, live run)

`pnpm --filter @adk/backend voice-style skylink-air novatel` runs the voice scenarios twice against the configured model, once with the previous voice prompt and once with the new one, and counts measurable style properties. One run, 8 customer turns (6 SkyLink, 2 NovaTel): indicative only, and the model's wording varies from run to run.

|                                                                    | Previous prompt | New prompt                                                                                          |
| ------------------------------------------------------------------ | --------------- | --------------------------------------------------------------------------------------------------- |
| Mean words per reply (SkyLink / NovaTel)                           | 27 / 23.5       | 21 / 27.5                                                                                           |
| Mean sentences per reply (SkyLink)                                 | 2.5             | 1.8                                                                                                 |
| Share of contractions missing ("it is" instead of "it's"), SkyLink | 33%             | 17%                                                                                                 |
| Stock opener ("Certainly", "Of course"...)                         | 0 of 8          | 0 of 8                                                                                              |
| Source label or markdown in a reply                                | 1 of 8          | 1 of 8 (the new one is the label on the baggage answer; the speech layer strips it before speaking) |
| Voice scenarios whose rule checks passed (4 scenarios)             | 3 of 4          | 4 of 4                                                                                              |

SkyLink, customer says "My flight got cancelled and I don't know what to do":

- Previous: "I'm sorry to hear that. May I have your booking reference and the last name on the reservation, please?"
- New: "I'm sorry about the cancellation. Can you tell me your booking reference and the last name on the reservation?"

After the customer picks the first option:

- Previous: "I'll move your booking to flight SK110, departing 11 AM and arriving 6 PM on November 10, at no charge. Please reply "yes" to confirm."
- New: "We'll move your booking from flight SK100 to flight SK110. That flight departs November 10 at 11 AM and arrives at 6 PM, with no change fee. Say yes if that works for you."

An earlier run of the new prompt exposed two defects that were fixed because of this comparison: a markdown list on a voice call, and the model spelling a flight number out in words and getting it wrong ("SK100" became "S K one-zero"). The prompt now tells the model to write digits and leaves reading them aloud to the speech layer. Remaining weakness: after a customer spells a code aloud, the model sometimes writes digits as words anyway ("SK one one zero"). That is read correctly but is not what the prompt asks for.

### Tests for this feature

- `tests/agent/voice-style.test.ts` (TypeScript, 19 tests): per-company style in the prompt, chat unaffected, every safety rule present in voice, profile validation, speech settings carried on `turn.started` without business data.
- `voice-service/tests/unit/` `test_text.py`, `test_pacing.py`, `test_session_logic.py`: spoken rendering (money, times, ordinals, abbreviations, codes), repeated and tiny phrases, silence trimming that never touches speech, speaker and speed validation and use, the progress line only during a real lookup.
- Four voice scenarios in the companies' evaluation suites (`voice-rebook-flow`, `voice-baggage-policy`, `voice-no-false-promise`, `voice-bill-question`), run with `pnpm eval <client>` against the real model.
