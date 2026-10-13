import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import '../config/load-dotenv';
import { REPO_ROOT } from '../config/repo-root';
import { createMemoryDb, runMigrations } from '../database';
import {
  createKnowledgeService,
  createSearcher,
  crossEncoderReranker,
  extractPdf,
  extractorPython,
  hashProvider,
  retrievalFor,
  semanticProvider,
  type EmbeddingProvider,
} from '../knowledge';
import { createLogger } from '../logger';

// Usage: pnpm --filter @adk/backend rag-scale [copies=20] [semantic|hash]
// How do ingestion and search behave on a big knowledge base? The 55-page test handbook is read once
// and indexed as many separate documents (so the database really holds thousands of sections), then
// the same questions are asked again and the search time is measured. In-memory database.

const copies = Number(process.argv[2] ?? 20);
const providerName = process.argv[3] === 'hash' ? 'hash' : 'semantic';
const CORPUS = resolve(REPO_ROOT, 'docproc', 'tests', 'corpus');
if (!existsSync(resolve(CORPUS, 'facts.json')) || !extractorPython()) {
  console.error('Run: pnpm docs:setup && pnpm docs:corpus');
  process.exit(1);
}
const embeddings: EmbeddingProvider = providerName === 'hash' ? hashProvider : semanticProvider();
await embeddings.warmUp?.();
const reranker = providerName === 'hash' ? undefined : crossEncoderReranker();
await reranker?.warmUp?.();

const source = resolve(CORPUS, 'skylink-handbook-v2.pdf');
const bytes = await readFile(source);
const extracted = await extractPdf(source);

const db = await createMemoryDb();
await runMigrations(db, 'memory');
const knowledge = createKnowledgeService({
  db: db.db,
  embeddings,
  logger: createLogger('error'),
  dataDir: await mkdtemp(resolve(tmpdir(), 'adk-scale-')),
  retryDelayMs: 0,
  extract: async () => extracted, // the PDF was read once above
});

const t0 = performance.now();
for (let i = 1; i <= copies; i++) {
  // a different last byte makes each upload a different file
  await knowledge.upload(
    'skylink-air',
    `handbook-${String(i).padStart(2, '0')}.pdf`,
    Buffer.concat([bytes, Buffer.from(`\n%${i}`)]),
  );
}
await knowledge.idle();
const indexMs = Math.round(performance.now() - t0);
const docs = await knowledge.list('skylink-air');
const sections = docs.reduce((n, d) => n + d.chunks, 0);
const pages = docs.reduce((n, d) => n + (d.pages ?? 0), 0);

const questions = [
  'How many checked bags can I bring in economy?',
  'How much does an extra checked bag cost?',
  'What is the change fee for an international flight?',
  'How long does a refund take after a cancellation?',
  'Can I bring my dog in the cabin?',
  'What time does check-in close at Karachi?',
  'When do I get a meal voucher for a delayed flight?',
  'Are saver fares refundable?',
];
const searcher = createSearcher(db.db, embeddings, retrievalFor(embeddings), reranker);
const ms: number[] = [];
let relevant = 0;
for (let round = 0; round < 3; round++) {
  for (const q of questions) {
    const t = performance.now();
    const r = await searcher.search('skylink-air', q);
    ms.push(performance.now() - t);
    if (round === 0 && r.relevant) relevant++;
  }
}
const pct = (p: number) =>
  Math.round(
    [...ms].sort((a, b) => a - b)[Math.min(ms.length - 1, Math.floor(p * (ms.length - 1) + 0.5))]!,
  );
const summary = {
  embeddings: embeddings.name,
  reranker: reranker?.name ?? null,
  documents: docs.length,
  pages,
  sections,
  indexAllMs: indexMs,
  indexMsPerSection: Math.round((indexMs / Math.max(1, sections)) * 10) / 10,
  questions: questions.length,
  answeredWithEvidence: relevant,
  searchMs: { p50: pct(0.5), p95: pct(0.95), max: Math.round(Math.max(...ms)), n: ms.length },
};
await mkdir('eval-results', { recursive: true });
await writeFile(
  `eval-results/rag-scale-${providerName}-${copies}.json`,
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify(summary, null, 1));
await db.close();
