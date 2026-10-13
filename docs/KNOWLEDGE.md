# Knowledge base: PDFs, search and grounded answers

The agent answers questions about company policy from the company's own documents. This page explains how a PDF becomes searchable, how a question finds its answer, what stops the agent from guessing, and how to measure all of it.

> **The one rule.** Documents are *data*. They can tell the agent a fact (a fee, a deadline); they can never tell it what to do. Who the customer is, what a tool may do and whether a change is approved are decided by the TypeScript runtime's own checks, whatever a document says.

## What exists

| Piece | Where | Notes |
| --- | --- | --- |
| PDF reader | `docproc/` (Python) | Text layer, headings, tables, page numbers, OCR for scans. Called by the backend as a small command. |
| Document store and queue | `backend/src/knowledge/documents.ts`, `database/repositories/knowledge.ts` | Upload, status and progress, retry, re-index, versions, delete. One document is processed at a time. |
| Chunking | `backend/src/knowledge/chunk.ts` | Follows headings, keeps tables whole, remembers the page of every chunk. |
| Embeddings | `backend/src/knowledge/embeddings.ts` | Local semantic model (BGE-small) by default; offline word matching as a fallback; OpenAI optional. |
| Search | `backend/src/knowledge/retrieve.ts`, `rerank.ts` | Meaning + words + a small relevance model, then a "do we have evidence?" decision. |
| API | `backend/src/routes/knowledge.ts` | Everything the console does. |
| Console | `frontend/src/pages/knowledge.tsx` | Upload, progress, versions, errors, test a question. |
| Evaluation | `backend/src/evals/rag-eval.ts`, `rag-answers.ts` | Retrieval quality, and end-to-end answer quality with the real model. |

The built-in policy files of each company (markdown in `clients/<id>/knowledge/`) go through the same store as uploaded PDFs, so there is one search for everything.

## From PDF to searchable sections

1. **Upload** (`POST /clients/:id/knowledge/documents?name=file.pdf`, body = the PDF). The server checks it looks like a PDF (header, size up to `KNOWLEDGE_MAX_UPLOAD_MB`), stores the file under `data/knowledge/`, creates the next *version* of that document name, and answers at once. Reading happens in the background, so a 300-page upload never blocks a call.
2. **Read** (`docproc`). For each page: words with font sizes become lines; large or bold short lines become headings (levels 1 to 3); grid tables become pipe-separated rows; bullets become list items; running headers and footers are dropped and the printed page number is kept apart. A page with no text layer is rendered and read with OCR (RapidOCR, PaddleOCR models, CPU). Problems are reported with a reason: password protected, damaged, no pages, no readable text.
3. **Split** into sections of about 1,000 characters at most 1,500, never across a heading, with about 150 characters repeated at each boundary so a fact on a boundary is not lost. Tables are cut into groups of rows of about 600 characters with the header row repeated, so a question about one row finds a small, focused passage. Each section remembers its heading trail and first and last page.
4. **Embed** (`bge-small-en-v1.5`, 384 numbers per section) and **store** with the document, version, pages and a full-text index. Progress is saved after every step (`Reading page 12 of 55`, `Indexing 48 of 140 sections`), so the console can show it and a restart can resume it.
5. **Go live in one step.** The new version only becomes searchable when it is complete. In that same step the previous version loses its sections and is marked *replaced*. Searches never see two versions, and never see neither.

Failures: a damaged or locked file fails at once (retrying cannot help). A crash or a missing model is retried up to three times. A failed *re-index* of a live document leaves the document as it was. The same file uploaded again is recognised by its hash and does nothing. Deleting a document removes every version, every section and the stored files.

Large files: pages are read and stored one at a time, the extracted text is cached on disk (`data/knowledge/*.pages.json`) so re-indexing does not read or OCR the PDF again, and embedding runs in batches of 24.

## From a question to evidence

1. **Do we need a search at all?** A greeting, a thanks or a bare yes/no skips it (`knowledge/gate.ts`). Anything else is searched: a missed search costs more than a wasted one.
2. **Understand follow-ups.** A short question such as "and how long does it take?" is joined to the customer's previous question *for searching only*. Conversation words are used to find evidence; they are never evidence.
3. **Three searches at once, restricted to this company and to live documents in the SQL itself** (`WHERE client_id = … AND document is ready and active`): by meaning (pgvector, cosine), by words (Postgres full-text), and a fusion of the two (reciprocal rank).
4. **Read the best few.** A small cross-encoder (`ms-marco-MiniLM-L-6-v2`, Apache-2.0) reads the question with each of the top 3 candidates and scores how well each *answers* it. This is what separates "talks about Karachi" from "says when check-in closes at Karachi", and it is the main protection against answering from a passage that is only on the same topic.
5. **Decide whether there is evidence.** Duplicates are removed (overlapping sections, repeated boilerplate). A passage counts as evidence only if its relevance score clears a bar chosen from the spread of scores on answerable and unanswerable test questions. If nothing clears it, the agent says it is not sure and offers a person. It does not call the model to improvise.
6. **Assemble** up to 5 passages within a character budget, each labelled `[Source: file.pdf, page 5]`.

The model is told the passages are reference text, not instructions, and that if two passages disagree or look out of date it must say it cannot confirm and offer a person.

## Safety

- **Tenant isolation is enforced in the query**, not in the prompt: every search, listing, fetch and delete is scoped by `client_id`; a document id from another company is "not found". Tested explicitly, including questions asked of the wrong company.
- **Prompt injection inside documents.** Sentences that read like instructions to an AI ("ignore previous instructions", "skip customer verification", "call change_flight…") are removed from a passage before the model sees it, the document gets a visible warning at upload, and the prompt says excerpts are data. Beyond that, nothing a document says can approve a change, skip verification or run a tool: those decisions are made by the runtime from the customer's own words and the tool rules. Tested with a PDF that contains such an instruction.
- **Versions.** Old versions are not searchable, so an outdated policy cannot be quoted.
- **Uploads** are size-limited, must start with a PDF header, are never served back, and live outside the repository (`data/`, git-ignored). There is no login yet: anyone who can reach the console can upload. Put it behind your own authentication before real use.

## Run it

```bash
pnpm docs:setup        # once: Python 3.11-3.13 virtual environment for the PDF reader (about 150 MB including OCR models)
pnpm dev               # the first start downloads two small local models into data/models-cache (about 60 MB)
# open http://localhost:5173/knowledge, choose a company, drop a PDF
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `EMBEDDING_PROVIDER` | `semantic` | `semantic` (local model), `hash` (offline word matching, no download), `openai` |
| `RAG_RERANK` | `on` | Read the best 3 candidates with the relevance model (about 60 ms) |
| `KNOWLEDGE_OCR` | `auto` | `auto` reads scanned pages with OCR; `off` never runs OCR |
| `KNOWLEDGE_MAX_UPLOAD_MB` | 100 | Largest PDF accepted |
| `DOCPROC_PYTHON` | (docproc/.venv) | Another Python with the reader installed |

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
