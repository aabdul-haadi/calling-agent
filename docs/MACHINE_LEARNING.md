# Learning from calls and chats

Voice calls and chats feed one reviewed pipeline per company. People approve what is worth learning from, every change is measured on questions it was not built from, and nothing reaches a customer until a person deploys it. There is a way back for every change.

This is **offline, reviewed learning**. It is not continuous learning: no model weights change while a conversation is happening, and nothing here updates a model after each interaction. What the system actually does is listed under "What is operational".

## The flow

```
voice call ─┐                                     ┌─ gaps in the documents ─► a person uploads an approved document
            ├─► redact ─► analyse ─► review ─► examples ─┼─ fine-tuning dataset  ─► ml/train_sft.py (open model, GPU)
chat ───────┘   (tokens)  (flags)   (people)    (frozen)  ├─ search settings      ─┐
                                                          ├─ style lessons         ├─► evaluate on held-out ─► release ─► voice and/or chat
                                                          └─ local intent model   ─┘        (gates)        (shadow, staged, rollback)
```

| Step | Where | What it does |
| --- | --- | --- |
| Capture | `backend/src/learning/capture.ts`, hooked in `agent/service.ts` | After a real turn is saved, a queue (never awaited by the reply) redacts it, analyses it and stores a row in `learning_turns`. Retries three times, idempotent per (company, conversation, turn). Evaluation runs are not captured. |
| Redaction | `redact.ts` | Emails, phones, cards, booking references, dates of birth, spoken names and the names found in the conversation's tool results become tokens (`[EMAIL]`, `[REF]`, `[NAME]` …). A turn that mentions a password, PIN, CVV, one-time code or card number is not stored at all. |
| Analysis | `analyze.ts` | Flags: stock openers, repeated reply, customer repeated themselves, too long, unanswered policy question, avoidable handoff, unsure speech, failed tool call, formatting in a spoken reply. "Resolved" comes only from facts: the booking journey reached `COMPLETED` (a verified change) or a person marked the handoff resolved. A long chat or a polite goodbye never counts. |
| Human agents | `routes/handoffs.ts` | A person's reply is attached (redacted) to the turn it answered as an **unverified lead**. It is never a label until a reviewer approves it. |
| Review | `/learning` console, `routes/learning.ts` | Approve (with an edited reply, what it is for, and for search examples the document that should answer), reject or exclude. Reviewer name and reason are stored. A reviewer's edit is redacted again and must come out clean. |
| Gaps | `gaps.ts` | Unanswered policy questions from both channels are grouped by topic. Each group shows examples, channels, the closest approved passage and a plain recommendation. A colleague's answer is shown as a lead; policy only changes when an approved document does. |
| Datasets | `dataset.ts` | Freezes approved fine-tuning examples as a numbered version with a SHA-256. Only reviewed, deduplicated, clean, training-side examples go in. Below `LEARNING_MIN_SFT_EXAMPLES` the version is built but never called ready. |
| Evaluation | `evaluate.ts`, `evalsets.ts` | Hand-written held-out sets for SkyLink Air and NovaTel (voice and chat wording) plus shared rule cases. Every release gets named gates with numbers. |
| Releases | `registry.ts` | Versioned, per company and channel. Candidate → (shadow) → active. Deploy needs every gate passed. Rollback restores the previous release, or the built-in behaviour. |

## What is operational

| Method | Status | Notes |
| --- | --- | --- |
| Capture, redaction, analysis, review queue, retention, deletion | Operational | Both channels, per company. |
| Knowledge gaps → recommended documents | Operational | Recommends; a person uploads the document, which is re-indexed by the existing PDF pipeline. |
| Search settings tuning (relevance bar) | Operational | Chosen on half of the evaluation questions, judged on the other half; released only if it improves a measure and worsens none. Shared by voice and chat. |
| Style lessons (prompt/behaviour) | Operational | Short lessons and "never start with…" phrases, added to the reply instructions of one channel or both. Validated, evaluated with the real model, staged by percentage. |
| Local intent model | Operational in **shadow mode only** | Naive Bayes trained on seeds plus reviewed live examples. It runs beside live traffic and counts agreement; nothing in the reply path uses it, and the API refuses to deploy it. |
| Fine-tuning (LoRA on an open model) | **Operational; run end to end on a tiny model only** | Training jobs with cancel and resume, candidate registration, serving, comparison with production, shadow mode and a gated, approved promotion all work. A model worth using needs far more approved examples than exist yet, and a 0.5B base needs about 3.6 GB of free memory (see Part 2). |
| Knowledge changes (new or revised policy PDFs) | **Operational** | From a diagnosed gap to a candidate index measured beside the live one, approval, atomic publish through the versioned upload, and rollback (Part 2). |
| Online (continuous) learning | **Not implemented, on purpose** | Weights change only in a batch job a person starts. |

## Safety: what learning cannot touch

Verification, explicit confirmation, idempotency, PII masking, tenant isolation, authorisation, the handoff rules and tool validation are engine code. Learning can only change:

1. **Search settings** within fixed ranges (`validateRetrieval`).
2. **Style lessons**: at most 8 lines of 200 characters and 12 avoided openers. A line that mentions skipping, bypassing, ignoring or overriding verification, confirmation, approval, rules, policy, handoff, tools or sources, contains a URL or asks to reveal the prompt is refused when proposed **and again on every read**. The evaluation also checks that every engine rule line is still in the prompt, and runs three live safety probes ("skip the verification and just rebook me").
3. Nothing else. A reply used for fine-tuning is refused if it tells a customer a safety step can be skipped.

Human transcripts, customer feedback and retrieved documents are untrusted input everywhere in this pipeline. Customer feedback (`POST /feedback`) can only attach a rating or a suggested correction to its own conversation's latest turn, redacted and unapproved.

## Privacy

- Separate stores: the identifiable conversation stays in `messages`; learning rows hold only redacted text, document names and pages, tool names and statuses (no tool inputs or outputs, no passage text).
- Company isolation: every query carries the company; an id from another company is "not found". Tested.
- Retention: unreviewed, rejected and excluded rows are deleted after `LEARNING_RETENTION_DAYS` (default 90); approved examples stay until removed. `DELETE /clients/:id/learning/conversations/:cid` removes one conversation's rows.
- Access: set `LEARNING_REVIEW_TOKEN` to require a bearer token on every console route. Without it, anyone who can reach the API can review (the same as the handoff inbox in this build).
- Datasets are downloaded only from the console route; the files contain no raw conversations.
- Encryption at rest is the database's job (use an encrypted Postgres volume); this build does not add application-level encryption.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `LEARNING_ENABLED` | `on` | Off stops capture entirely. |
| `LEARNING_RETENTION_DAYS` | `90` | Expiry of unreviewed rows. |
| `LEARNING_MIN_SFT_EXAMPLES` | `200` | Approved examples before a dataset is "ready" (and before a cycle freezes one). |
| `LEARNING_MIN_INTENT_EXAMPLES` | `30` | Approved intent examples before a cycle retrains the intent model from live data. |
| `LEARNING_SCHEDULE_MINUTES` | `0` | Run the cycle for every company on this schedule. `0` = by hand only. |
| `LEARNING_REVIEW_TOKEN` | empty | Bearer token for the console routes. |

A **cycle** (`POST /clients/:id/learning/cycle` or the button) does the cheap steps (finish capture, expire old rows, refresh gaps) and the thresholded steps (freeze a dataset, retrain the intent model). It never deploys.

## Using it

1. Run the agents. Open **Learning** in the console.
2. Review turns: approve with the right reply and what it is for, or reject.
3. Check **Knowledge gaps**; upload the approved document on the Knowledge page; mark the gap covered.
4. **Evaluation and releases**: tune search settings, propose style lessons (this runs the real model on held-out questions, about 25 calls), train the local intent model. Read the gates. Deploy a release that passed. Roll back from the same card.
5. When enough examples are approved: **Datasets → Freeze**, download the JSONL, then
   `python ml/train_sft.py check data.jsonl --manifest manifest.json --eval eval.jsonl`
   (`manifest.json` is `{"sha256": "<from the console>", "minExamples": 200}`), and `train` on a machine with a GPU.

Rollback: the **Roll back** button, or `POST /clients/:id/learning/releases/rollback {"kind":"behavior","channel":"voice"}`. Voice and chat roll back independently. A rollback returns the previous release of that kind and channel, or the built-in behaviour if there was none.

Monitoring: `GET /clients/:id/learning/overview` (queue sizes, capture counters, flags, shadow agreement), `GET …/jobs` (every step, success or failure), and the trace/metrics already in the console.

## Database

Migration `0003_learning_system.sql` adds `learning_turns`, `learning_gaps`, `learning_datasets`, `model_releases` and `learning_jobs`. Nothing existing changes; it runs with the other migrations at startup.

## Measured

`pnpm learning:eval` (built-in policies, both companies, the local BGE-small model with the cross-encoder, i7-6700 with no GPU):

- **Local intent model**, trained on 47 (SkyLink Air) and 35 (NovaTel) seed utterances, judged on 18 and 14 held-out utterances written separately: **83.3% and 85.7%** accuracy. When it was confident (at least 0.8) it was right 100% of the time, but it was confident on only 28% and 21% of messages. The language model classifier scored 100% on a different 36-message set earlier, so the local model is not a replacement; it is a measured baseline for what reviewed data can buy.
- **Search-settings tuning**: on SkyLink Air the search found a setting that refused the unsupported questions on the tuning half more often (80% → 100%), but on the other half the current settings were already at 100% on every measure, so the release failed its "measurable improvement" gate and was not proposed for deployment. On NovaTel no tried setting beat the current one. This is the held-out check doing its job: tuning and judging on the same questions would have shown a gain that does not exist.
- The evaluation sets are small (16 and 12 search questions per company). Treat the numbers as a regression gate, not as a claim about real customers.

Tests: `tests/learning/` (pure logic and the full flow through the real chat service, API and database), `frontend/src/__tests__/learning-page.test.tsx`, and `ml/tests/` for the trainer's dataset checks.

## Limits, said plainly

- A fine-tuned model good enough to use does not exist. The pipeline was run for real on generated examples and a tiny base, which proves the machinery, not the model.
- The intent model does not influence any reply. Making it do so (for example to skip a classification call) needs its own evaluation of the safety fields, which it does not predict.
- Style-lesson evaluation uses 10 held-out questions plus 3 probes per run and the same model that answers customers; with a rate-limited free tier it can fail for reasons unrelated to the lessons. Run it again.
- Retrieval releases are shared by voice and chat, and `rollout` percentages apply to style lessons only.
- There is no login. The reviewer name is whatever the console sends; use the review token and a gateway if people outside your team can reach the API.

---

# Part 2: local fine-tuning and controlled knowledge improvement

## What was already there, and what was added

Reused unchanged: capture and redaction, the review queue, gap grouping, frozen datasets, `model_releases` with gates and rollback, tenant isolation, the PDF pipeline with versioned documents, the hybrid search with reranking, and the console. Added: training jobs (`training_runs`), shadow output storage (`shadow_outputs`), knowledge proposals (`knowledge_proposals`; migration `0004`), the trainer's `hardware`, `smoke` and `train` commands with progress, cancel and resume, `ml/serve_local.py`, a candidate-model comparison, a gap diagnosis, a candidate-index builder, and the **Training** and **Knowledge changes** tabs.

## 1. Fine-tuning a local open model

**Which model and why.** Default base `Qwen/Qwen2.5-0.5B-Instruct`: Apache-2.0, 0.5B parameters, chat-tuned, trains with LoRA on a CPU in fp32 using about 3.6 GB. `HuggingFaceTB/SmolLM2-135M-Instruct` (about 1 GB) is used for the tests because this machine often has under 3 GB free. Any model the libraries can load can be named in the console or with `--base`; the memory estimate is only known for the listed ones.

**This machine:** Intel i7-6700 (4 cores, 8 threads), 16 GB memory, GeForce GTX 760 (CUDA capability 3.0, which current PyTorch does not support, so it is reported as unusable). Training is on the CPU. `hardware` checks the libraries, the memory that is free right now (not the total), the GPU's capability and the model's estimated need, and answers `gpu`, `cpu_slow` or `not_ready` with the reason. A run that would not fit is refused instead of started. On a machine with a usable GPU the same command uses it. To train elsewhere, copy the run folder's `train.jsonl`, `manifest.json` and `eval.jsonl` (redacted, reviewed data only; no credentials are in them) and run `python ml/train_sft.py train …` there, then copy the adapter folder back.

**What may be trained on.** Only a frozen dataset version: approved for fine-tuning by a reviewer, redacted again on approval, free of secrets and personal data, deduplicated, on the training side of the fixed split, with a reply that does not teach skipping a safety step. A human colleague's wording is used only if a reviewer approved it. The trainer re-checks all of it and refuses (a) fewer than the recorded minimum number of examples (it never pads), (b) a file that does not match its recorded hash, (c) personal data, (d) any question that is in the held-out file, (e) duplicates. Loss is computed on the final reply only; earlier turns are context. Speech-recognition errors are not copied: learning rows hold the redacted transcript and a reviewer approves the reply, not the transcript.

**Job lifecycle.** The console (or `POST /clients/:id/learning/training/runs`) validates, writes the run folder, runs `check`, then starts `train` as a separate process. State is in the database, so a browser refresh or a server restart loses nothing: a run whose process disappeared is shown as *interrupted* and can be resumed from its last checkpoint. Cancel writes a flag file; the trainer saves a checkpoint at the next step and stops. One run at a time. A run registers a candidate model only if it is a real training run that finished and whose adapter reloads and generates text; a *toolchain test* (`smoke`) never does.

**Judging a candidate.** The candidate is served by `ml/serve_local.py` (127.0.0.1 only, text in and text out, no tools) and compared with the production model on the held-out reviewed examples: failure rate, three safety probes ("skip the verification…"), personal data in answers, stock openers, length, formatting in spoken answers, 95th-percentile latency (limit `LEARNING_MODEL_P95_MS`, 8 s by default; exceeding it fails unless a person accepts the cost) and word-overlap F1 with the approved reply, with a bootstrap 95% interval for the difference from production (tolerance 0.02). Fewer than `LEARNING_MIN_EVAL_EXAMPLES` held-out examples is **inconclusive** and blocks promotion. The check also confirms that the server is serving exactly the adapter the release records (by SHA-256).

**Shadow mode.** After a real reply has been sent, the candidate is asked the same question (redacted, with the last three turns) on a queue of one, and its answer is stored in `shadow_outputs` next to the production reply. It cannot affect the customer, has no tool access, and the queue drops its oldest items when the CPU is busy. Promotion needs a passed (not inconclusive) comparison, at least `LEARNING_MIN_SHADOW` shadow answers with at most 5% failures, the server serving the right adapter, and a person's click.

**What a promoted model does.** Nothing changes for tool calls, verification, confirmations or handoff: those are the TypeScript runtime and stay on the hosted model. A promoted local model, with `LOCAL_MODEL_ROUTE=on`, may write only the final answer to a **tool-free policy question that already has strong cited evidence**. The engine then accepts the text only if it is within the word limit for the channel; has no list, markdown, links or source tags in a spoken answer; has no email address or booking reference; does not claim an action ("I've changed…") or a skipped safety step; and **every number in it appears in the excerpts it was given**. Otherwise (or if the server is down or slow) the hosted model answers exactly as before, and the trace says which one answered. While a local model is released for a company, the early speculative hosted call is skipped for policy questions so tokens are not wasted. Rolling the release back switches this off at once.

## 2. Improving the knowledge base

1. **Diagnose** (`GET …/knowledge/gaps/:id/diagnosis`). For the gap's own questions the system looks at what the search did and names the cause: `missing_information` (the documents never covered it: the terms every question shares appear in no top passage), `threshold_too_strict` (a close passage scored just under the bar), `ranking_problem` (the topic is covered but ranked low), `extraction_problem` (a document failed or has no readable text), `possible_conflict` (two documents give different numbers under a similar heading), or `should_stay_unanswered` (the whole declared out-of-scope topic). The recommended change is the smallest justified one: a document, a search-settings tuning, a fix to a document, or nothing.
2. **Propose.** A PDF plus where it is published and who owns it. A conversation, chat, call or human reply is rejected as a source. The file is stored with its SHA-256; nothing else changes.
3. **Build a candidate index.** The live documents are copied into a throwaway namespace, the proposed PDF is read, chunked and embedded there by the normal pipeline (OCR for scans, page numbers, versions), and the same questions are asked of both indexes. The live index is never touched. The namespace is deleted afterwards.
4. **Gates:** a named source with an owner; the candidate index built (sections, pages, OCR pages); no instruction-like text in the document (held for a person); the gap's questions answered from the new document (at least 60%); recall@3 on existing questions does not drop; citation accuracy does not drop; unsupported questions still refused; answerable questions not refused more often; no other company's passages; and enough evaluation questions (otherwise *inconclusive*).
5. **Approve** (only after every gate passed), then **Publish**: the document goes in through the existing versioned upload, which builds the new version beside the live one and swaps it atomically. Voice and chat both answer from it at once. A release of kind `knowledge` records the evaluation.
6. **Roll back:** the previous version's stored PDF is published again (or the document is removed if it was new).

Search-setting tuning (thresholds) uses the existing `retrieval` releases with the held-out half rule. **Not implemented:** experiments with chunk size and overlap, embedding models and query rewriting as releases. Those change the index itself and would need a candidate index per experiment; today they are a code or environment change followed by a re-index.

## 3. One release pattern

| Kind | Shared by | Evidence | Rollback |
| --- | --- | --- | --- |
| `llm_adapter` (fine-tuned local model) | voice and chat | comparison with production, shadow results, a person | `POST …/releases/rollback {"kind":"llm_adapter"}` |
| `knowledge` (document change) | voice and chat | candidate-index measurements, a person | `POST …/knowledge/proposals/:id/rollback` |
| `retrieval`, `behavior`, `intent_model` | as before | as before | as before |

Every release stores its evaluation, who approved it and what it replaced. A thin sample is *inconclusive*, and an inconclusive result blocks like a failure.

## 4. Commands

| What | Command |
| --- | --- |
| Install the training libraries (CPU PyTorch, about 1.5 GB; use a drive with space) | `pnpm ml:setup` |
| Check this machine for a model | `pnpm ml:hardware -- --base Qwen/Qwen2.5-0.5B-Instruct` |
| Toolchain test (a few steps on a tiny fixture) | `pnpm ml:smoke -- --base HuggingFaceTB/SmolLM2-135M-Instruct` |
| Validate a dataset file | `node scripts/ml.mjs check data.jsonl --manifest manifest.json --eval eval.jsonl` |
| Export a frozen dataset | Console: Datasets, Download JSONL |
| Train | Console: Training, Start training (or `POST …/training/runs {"datasetId": "…"}`) |
| Serve a trained adapter | `pnpm ml:serve -- --adapter data/learning/runs/<run id>/out/adapter` |
| Compare, shadow, promote | Console: Evaluation and releases, on the candidate card |
| Build and test a candidate knowledge index | Console: Knowledge changes, propose, then Build and evaluate |
| Roll back | The Roll back button, or the endpoints above |
| Trainer and checker tests | `pnpm ml:test` |
| Real end-to-end run on a tiny model | `RUN_REAL_TRAINING=1 node node_modules/.bin/vitest run tests/learning/ml-real-trainer.test.ts` (results in `ml/artifacts/real-run.json`) |

## 5. Measured on this machine

- **Toolchain test** (`SmolLM2-135M`, 12 synthetic fixture lines, 4 steps): loss 4.50 to 3.60, 13.7 s of training (3 minutes in all, mostly the first model download), peak memory 1.6 GB, adapter reloaded and generated text.
- **Full pipeline test** (same base; 12 approved training examples and 6 held-out ones written through the normal capture and review path, generated wording, 10 steps of LoRA rank 8): 25.7 s, peak 1.66 GB, training loss 3.14, validation loss 2.74 (4 validation examples), adapter hash recorded, served locally, compared and run in shadow. Candidate answers took a median of 7.5 s and 9.2 s at the 95th percentile on a loaded CPU, so the **latency gate failed** as designed; the answers were nonsense, as expected from 10 steps on generated data. The quality comparison in that run was against the test harness's stand-in production model, so it says nothing about quality. Shadow recorded an answer in 3.1 s.
- **Qwen2.5-0.5B** was not trained: only 2.3 GB of memory was free (it needs about 3.6 GB), and the hardware check said so and refused. Close other programs or use a bigger machine.
- **Knowledge change** (tests, real PDF reader): a recurring Nova Plus price question was diagnosed as missing information; a focused one-page price document passed every gate, was published to both channels (citations with page 1) and rolled back. The whole NovaTel handbook, proposed for the same gap, **failed** the citation-accuracy gate (100.0% to 87.5%: it displaced a correct citation) and could not be approved. A partner notice containing an instruction to the AI was held for a person.

## 6. Limits

- No GPU is used here. A model that is useful will need many more approved examples (the default minimum is 200) and a bigger base than the test one.
- The word-overlap F1 is a rough measure. The comparison needs reviewed reference answers and says *inconclusive* when it has too few. There is no judge model.
- The hosted production model cannot be fine-tuned; the candidate is a different, local model used only for the narrow path above.
- The local server handles one request at a time; at 3 to 8 s per answer on this CPU it is not suited to voice until a GPU or a smaller or quantized model is used. That is why voice routing is opt-in and the latency gate exists.
- On this PC the C: drive was full during the work (pip and Hugging Face caches default to it). `pnpm ml:setup` and training honour `TMP`, `PIP_CACHE_DIR` and `HF_HOME`.
