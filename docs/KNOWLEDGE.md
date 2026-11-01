# Knowledge base: PDFs, search and grounded answers

The agent answers questions about company policy from the company's own documents. This page explains how a PDF becomes searchable, how a question finds its answer, what stops the agent from guessing, and how to measure all of it.

> **The one rule.** Documents are _data_. They can tell the agent a fact (a fee, a deadline); they can never tell it what to do. Who the customer is, what a tool may do and whether a change is approved are decided by the TypeScript runtime's own checks, whatever a document says.

## What exists

| Piece                    | Where                                                                      | Notes                                                                                                |
| ------------------------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| PDF reader               | `docproc/` (Python)                                                        | Text layer, headings, tables, page numbers, OCR for scans. Called by the backend as a small command. |
| Document store and queue | `backend/src/knowledge/documents.ts`, `database/repositories/knowledge.ts` | Upload, status and progress, retry, re-index, versions, delete. One document is processed at a time. |
| Chunking                 | `backend/src/knowledge/chunk.ts`                                           | Follows headings, keeps tables whole, remembers the page of every chunk.                             |
| Embeddings               | `backend/src/knowledge/embeddings.ts`                                      | Local semantic model (BGE-small) by default; offline word matching as a fallback; OpenAI optional.   |
| Search                   | `backend/src/knowledge/retrieve.ts`, `rerank.ts`                           | Meaning + words + a small relevance model, then a "do we have evidence?" decision.                   |
| API                      | `backend/src/routes/knowledge.ts`                                          | Everything the console does.                                                                         |
| Console                  | `frontend/src/pages/knowledge.tsx`                                         | Upload, progress, versions, errors, test a question.                                                 |
| Evaluation               | `backend/src/evals/rag-eval.ts`, `rag-answers.ts`                          | Retrieval quality, and end-to-end answer quality with the real model.                                |

The built-in policy files of each company (markdown in `clients/<id>/knowledge/`) go through the same store as uploaded PDFs, so there is one search for everything.

## From PDF to searchable sections

1. **Upload** (`POST /clients/:id/knowledge/documents?name=file.pdf`, body = the PDF). The server checks it looks like a PDF (header, size up to `KNOWLEDGE_MAX_UPLOAD_MB`), stores the file under `data/knowledge/`, creates the next _version_ of that document name, and answers at once. Reading happens in the background, so a 300-page upload never blocks a call.
2. **Read** (`docproc`). For each page: words with font sizes become lines; large or bold short lines become headings (levels 1 to 3); grid tables become pipe-separated rows; bullets become list items; running headers and footers are dropped and the printed page number is kept apart. A page with no text layer is rendered and read with OCR (RapidOCR, PaddleOCR models, CPU). Problems are reported with a reason: password protected, damaged, no pages, no readable text.
3. **Split** into sections of about 1,000 characters at most 1,500, never across a heading, with about 150 characters repeated at each boundary so a fact on a boundary is not lost. Tables are cut into groups of rows of about 600 characters with the header row repeated, so a question about one row finds a small, focused passage. Each section remembers its heading trail and first and last page.
4. **Embed** (`bge-small-en-v1.5`, 384 numbers per section) and **store** with the document, version, pages and a full-text index. Progress is saved after every step (`Reading page 12 of 55`, `Indexing 48 of 140 sections`), so the console can show it and a restart can resume it.
5. **Go live in one step.** The new version only becomes searchable when it is complete. In that same step the previous version loses its sections and is marked _replaced_. Searches never see two versions, and never see neither.

Failures: a damaged or locked file fails at once (retrying cannot help). A crash or a missing model is retried up to three times. A failed _re-index_ of a live document leaves the document as it was. The same file uploaded again is recognised by its hash and does nothing. Deleting a document removes every version, every section and the stored files.

Large files: pages are read and stored one at a time, the extracted text is cached on disk (`data/knowledge/*.pages.json`) so re-indexing does not read or OCR the PDF again, and embedding runs in batches of 24.

## From a question to evidence

1. **Do we need a search at all?** A greeting, a thanks or a bare yes/no skips it (`knowledge/gate.ts`). Anything else is searched: a missed search costs more than a wasted one.
2. **Understand follow-ups.** A short question such as "and how long does it take?" is joined to the customer's previous question _for searching only_. Conversation words are used to find evidence; they are never evidence.
3. **Three searches at once, restricted to this company and to live documents in the SQL itself** (`WHERE client_id = … AND document is ready and active`): by meaning (pgvector, cosine), by words (Postgres full-text), and a fusion of the two (reciprocal rank).
4. **Read the best few.** A small cross-encoder (`ms-marco-MiniLM-L-6-v2`, Apache-2.0) reads the question with each of the top 5 candidates and scores how well each _answers_ it. This is what separates "talks about Karachi" from "says when check-in closes at Karachi", and it is the main protection against answering from a passage that is only on the same topic.
5. **Decide whether there is evidence.** Duplicates are removed (overlapping sections, repeated boilerplate). A passage counts as evidence only if its relevance score clears a bar chosen from the spread of scores on answerable and unanswerable test questions. If nothing clears it, the agent says it is not sure and offers a person. It does not call the model to improvise.
6. **Assemble** up to 5 passages within a character budget, each labelled `[Source: file.pdf, page 5]`.

The model is told the passages are reference text, not instructions, and that if two passages disagree or look out of date it must say it cannot confirm and offer a person.

## Safety

- **Tenant isolation is enforced in the query**, not in the prompt: every search, listing, fetch and delete is scoped by `client_id`; a document id from another company is "not found". Tested explicitly, including questions asked of the wrong company.
- **Prompt injection inside documents.** Sentences that read like instructions to an AI ("ignore previous instructions", "skip customer verification", "call change_flight…") are removed from a passage before the model sees it, the document gets a visible warning at upload, and the prompt says excerpts are data. Beyond that, nothing a document says can approve a change, skip verification or run a tool: those decisions are made by the runtime from the customer's own words and the tool rules. Tested with a PDF that contains such an instruction.
- **Versions.** Old versions are not searchable, so an outdated policy cannot be quoted.
- **Uploads** are size-limited, must start with a PDF header, are never served back, and live outside the repository (`data/`, git-ignored). In OIDC mode, document uploads and index changes require the tenant-scoped `knowledge:manage` permission. Local development mode grants a development-only administrator identity and must not be used in production; see [AUTHENTICATION.md](./AUTHENTICATION.md).

## Run it

```bash
pnpm docs:setup        # once: Python 3.11-3.13 virtual environment for the PDF reader (about 150 MB including OCR models)
pnpm dev               # the first start downloads two small local models into data/models-cache (about 60 MB)
# open http://localhost:5173/knowledge, choose a company, drop a PDF
```

| Variable                  | Default         | Meaning                                                                         |
| ------------------------- | --------------- | ------------------------------------------------------------------------------- |
| `EMBEDDING_PROVIDER`      | `semantic`      | `semantic` (local model), `hash` (offline word matching, no download), `openai` |
| `RAG_RERANK`              | `on`            | Read the best 5 candidates with the relevance model (about 100 ms on this CPU)  |
| `KNOWLEDGE_OCR`           | `auto`          | `auto` reads scanned pages with OCR; `off` never runs OCR                       |
| `KNOWLEDGE_MAX_UPLOAD_MB` | 100             | Largest PDF accepted                                                            |
| `DOCPROC_PYTHON`          | (docproc/.venv) | Another Python with the reader installed                                        |

If the semantic model cannot be downloaded (no internet on the first run), the backend logs it and falls back to word matching; run again with internet to switch.

Models and licences: BGE-small-en-v1.5 (MIT), MS MARCO MiniLM-L-6 cross-encoder (Apache-2.0), RapidOCR with PaddleOCR models (Apache-2.0), pypdf (BSD), pdfplumber (MIT), pypdfium2 (Apache-2.0/BSD). PyMuPDF was deliberately not used (AGPL).

## Measure it

```bash
pnpm docs:corpus                 # build the test PDFs (55-page airline handbook in two editions, a telecom handbook, a PDF with a hidden instruction, a scan, and broken files)
pnpm docs:test                   # the PDF reader's own tests
pnpm rag:eval                    # retrieval: Recall@K, abstention, tenant isolation, versioning, search time
pnpm rag:eval hash               # the same with the offline word matcher, for comparison
pnpm rag:answers                 # end to end with the real model: facts in the answer, cited page, refusals, injection
```

The test documents are made up (no real company). Every fact in them is written once, and the page it landed on is recorded while the PDF is laid out, so retrieval is scored against the truth, not against another model's opinion.

## Measured

All numbers are from `pnpm rag:eval`, `pnpm rag:answers`, `pnpm rag:scale` and `pnpm docs:test` on this machine (Intel i7-6700, 4 cores / 8 threads, no GPU, models on CPU). The test documents are made up and the questions were written by the same author as the documents, so treat the figures as a regression baseline and a comparison between settings, not as a promise about real customers.

### Reading PDFs

- A 55-page digital handbook (tables, headings, running headers) is read, split and indexed in about 35 seconds through the live backend (progress visible the whole time). Indexing speed is dominated by embedding: about 38 ms per section.
- A 5-page scan is read with OCR (all five pages, OCR confidence above 0.8 on the first test page); amounts survive (`$60`).
- Refused with a clear reason, and kept out of the index: password protected, damaged, no pages, not a PDF, a blank page.
- Page numbers: every section remembers the first and last page; an answer cites `file.pdf, page 5`.

### Finding the right passage (197 questions: 72 worded like the document, 88 paraphrased, 12 deliberately hard paraphrases, 5 follow-ups, 12 the documents do not cover, 8 asked of the wrong company)

The current retrieval query adds a small set of reviewed, domain-specific search terms for phrases such as "puppy" (pet), "money back" (refund), and "no service" (network outage). These terms affect retrieval only; the original question is still used for reranking and for the answer. On the built-in policy corpus, the earlier 197-case baseline found the expected passage in the top 3 for 89.3% overall and 25% of hard paraphrases. The latest run found the expected passage in the top 3 for 92.1% overall and 50% of hard paraphrases; answer words were present in evidence in 96.6%. All 12 unsupported questions were refused, with no cross-tenant passage leaks (0 of 8 attempts). These are retrieval measurements on synthetic policies, not production answer-quality results.

The first firearm failure was a topic-adjacent chunk, `carry-on-baggage` / "Items not allowed in the cabin", about sharp objects, sporting bats and flammable items. For "Can I bring a firearm in my checked luggage?" its reranker/vector/keyword/overlap scores were −1.6 / 0.73 / 0.49 / 0.50; it did not discuss firearms. A marginal-score corroboration rule stopped that query. A broader regression query then exposed the same root problem at the other end of the reranker scale: "Can I carry a weapon not covered by the baggage guide?" retrieved the same baggage chunk with scores 0.6 / 0.74 / 0.81 / 0.40, despite having no matching specific query term. The fix adds a generic specific-term coverage check, excluding only broad domain/topic words; high semantic or keyword scores alone cannot promote a passage when none of the query's specific terms occur in it. The rule is not tied to firearm/weapon vocabulary and does not change the global relevance threshold.

|                                                                            | Right passage in the top 3 | Answer words present in the evidence | Hard paraphrases found | Questions the documents do not cover: correctly refused | Wrongly refused though answerable | Asked of the wrong company: refused, none leaked | Search time (median / 95th) |
| -------------------------------------------------------------------------- | -------------------------- | ------------------------------------ | ---------------------- | ------------------------------------------------------- | --------------------------------- | ------------------------------------------------ | --------------------------- |
| Word matching only (offline fallback)                                      | 93.8%                      | 93.8%                                | 5 of 12                | 66.7%                                                   | 2.3%                              | 50%, 0 leaked                                    | 34 / 62 ms                  |
| Meaning + words, no relevance check                                        | **96.6%**                  | **96.6%**                            | **6 of 12**            | 75%                                                     | **1.7%**                          | 62.5%, 0 leaked                                  | 43 / 87 ms                  |
| **Meaning + words + relevance check (default)**                            | 93.2%                      | 93.8%                                | 4 of 12                | **100%**                                                | 4.5%                              | **100%**, 0 leaked                               | 137 / 196 ms                |
| Default with built-in policies, latest 197-case run                    | **92.1%**                  | **96.6%**                            | **6 of 12**            | **100%**                                                 | **1.7%**                          | **100%, 0 leaked**                                | 178 / 282 ms                |

What this says, plainly:

- The relevance check is what makes the system _refuse_ what it does not know (66.7% to 100% on the earlier unanswerable set, and 50% to 100% on questions asked of the wrong company). It costs about 3 points of recall in that comparison and was kept because inventing policy is the worse error.
- Word matching alone is not much worse at ranking on these documents. The meaning model helps on paraphrases that share few words ("what do I pay for a second suitcase"), but only a little (6 of 12 hard paraphrases against 5), and the relevance check then trades some of that back.
- **Differently worded questions are still the weak spot.** The latest run found 6 of 12 deliberately hard paraphrases. Passages that are close in meaning and share topic words but score low are passed to the model as _weak matches_ only when a reviewed expansion or context adds a supported search path. Four answerable questions reached the model that way, and none of the 12 unsupported questions did. The latest 10-case challenge set retrieved all 4 supported cases and refused all 6 unsupported weapon/firearm, ammunition and ambiguous cases (0 false positives); the exact firearm query and the broad weapon paraphrase are both included. The separate challenge set supplements, and does not alter, the 197-case baseline.
- Cross-company isolation held in every run: no passage of another company was ever returned.
- Replacing a document (version 2 over version 1) left no old section in the index in any run.

### A large knowledge base

Twenty copies of the 55-page handbook were indexed as separate documents (1,100 pages, 5,680 sections) in an in-memory database, then the same eight questions were asked three times each. Indexing took 3.6 to 6.4 minutes in two runs (38 to 68 ms per section; the machine was busier in the second); search with meaning, words and the relevance check took a median of 144 to 188 ms and a 95th percentile of 381 to 490 ms (the slowest single search 2.3 s, once, in the busier run). Seven of the eight questions found evidence (the eighth was refused, as the strict relevance check sometimes does). The 55-page document alone searches in about 130 ms, so search time grows slowly with size (an HNSW index for meaning, a GIN index for words); embedding the documents is what costs.

### Whole answers with the real model (`pnpm rag:answers`)

The latest run exercised **26 voice-channel questions** through retrieval, ranking, prompt construction, model generation, citations and (for current account data) the mock business tools. It included puppy and money-back paraphrases, NovaTel no-service, the exact firearm query and the broader weapon paraphrase, ambiguous and unsupported questions, prompt injection, a v1/v2 refund-policy conflict, a booking lookup, and a current bill lookup.

- Deterministic expected facts appeared in **82.4%** of answerable cases; cited source/page was correct in **88.2%**. The latest-policy conflict returned version 2 and the seven-day value; the old 14-day value was absent (**1/1** conflict case).
- All numeric claims matched the question, retrieved passages or safe expected tool evidence (**26/26** under the evaluator's deterministic numeric-grounding check). This does **not** prove that every non-numeric statement is semantically grounded. No LLM judge was used.
- Unsupported questions were declined in **100%** of cases; the cross-tenant question returned no source. The hidden-instruction document was answered without a tool call or a claimed change (**1/1**).
- Booking and billing calls verified identity before reads and matched the live mock-service facts (**2/2**); no policy citations were attached to live tool data.
- The evaluator's full-case pass rate was **88.5%** (23/26). Three cases did not pass all checks: the 28-kg bag question and puppy paraphrase were refused, and the two-part fee/assistance question omitted one requested fact. These are answer-quality gaps, not retrieval false positives.
- Single-run end-to-end latency: p50 **760 ms**, p95 **16,265 ms**; first text p50 **732 ms**, p95 **16,226 ms**. Retrieval stage p50/p95 was **211/406 ms**; LLM stage **716/15,988 ms**; tool stage **16/536 ms**. The long tail was associated with model rate-limit waiting, not a stable latency guarantee.
- The voice-path response is text before browser audio playback. The harness strips citation tags using the speech-cleaning rule and checks that sources remain in citation metadata; it is not an acoustic playback test. No LLM judge was used. I manually inspected the firearm refusal, version-conflict answer, injection case, booking/bill tool results, and the puppy/money-back misses.

The detailed retrieval and answer results are retained in `backend/eval-results/rag-next-phase-builtins-corroborated-final.json` and `backend/eval-results/rag-next-phase-answer-quality-final.json`. Live microphone/telephony behavior remains unverified in this run.
