import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import '../config/load-dotenv';
import { clientDir, loadClients } from '../clients';
import { createMemoryDb, runMigrations } from '../database';
import {
  createSearcher,
  crossEncoderReranker,
  hashProvider,
  ingestClient,
  retrievalFor,
  semanticProvider,
  type EmbeddingProvider,
} from '../knowledge';
import { DEFAULT_GRID_LEXICAL, DEFAULT_GRID_RERANK, evaluateIntentModel, evaluateRetrievalRelease, rankCases, scoreRetrieval, splitRanked, tuneRetrieval } from '../learning/evaluate';
import { EVAL_SETS } from '../learning/evalsets';
import { score, train } from '../learning/intent-model';

// Usage: pnpm learning:eval [semantic|hash]
// Measures what the learning system's evaluation suite measures, on the built-in policies of both
// companies: how well the current search finds the right document and refuses what the documents do
// not cover, whether tuning the relevance bar would help (and whether it passes its gates), and how
// accurate the local intent model is on utterances it was not trained on. In-memory database.

const mode = process.argv[2]?.startsWith('hash') ? 'hash' : 'semantic';
const embeddings: EmbeddingProvider = mode === 'hash' ? hashProvider : semanticProvider();
await embeddings.warmUp?.();
const reranker = mode === 'semantic' ? crossEncoderReranker() : undefined;
await reranker?.warmUp?.();

const db = await createMemoryDb();
await runMigrations(db, 'memory');
const registry = loadClients();
for (const m of registry.list()) {
  await ingestClient(db.db, embeddings, m.config.id, resolve(clientDir(m), m.config.knowledgeDir));
}
const searcher = createSearcher(db.db, embeddings, retrievalFor(embeddings), reranker);
const base = searcher.config;
const grid = mode === 'semantic' ? DEFAULT_GRID_RERANK : DEFAULT_GRID_LEXICAL;

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const report: Record<string, unknown> = { embeddings: embeddings.name, reranker: Boolean(reranker) };
for (const clientId of Object.keys(EVAL_SETS)) {
  const set = EVAL_SETS[clientId]!;
  const ranked = await rankCases(searcher, clientId, set.retrieval);
  const halves = splitRanked(ranked);
  const before = scoreRetrieval(halves.validate, base);
  const tuned = tuneRetrieval(halves.tune, base, grid);
  const foreign = new Set(
    Object.entries(EVAL_SETS)
      .filter(([id]) => id !== clientId)
      .flatMap(([, s]) => s.retrieval.map((r) => r.source))
      .filter((s): s is string => !!s),
  );
  const evaluation = tuned ? evaluateRetrievalRelease(halves.validate, base, tuned.override, foreign) : undefined;
  const model = train(set.seed);
  const intent = score(model, set.heldOut);
  const intentGate = evaluateIntentModel(model, clientId);
  console.log(`\n== ${clientId}`);
  console.log(
    `retrieval (tuned on ${halves.tune.length}, judged on ${halves.validate.length} other questions): current settings on the judging half: recall@3 ${pct(before.recallAt3)}, citation ${pct(before.citationAccuracy)}, unsupported refused ${pct(before.unsupportedRefused)}, wrongly refused ${pct(before.wronglyRefused)}, p95 ${before.p95Ms} ms`,
  );
  console.log(tuned ? `tuning chose ${JSON.stringify(tuned.override)} (on the tuning half); on the judging half: recall@3 ${pct((evaluation!.metrics as { recallAt3: number }).recallAt3)}, unsupported refused ${pct((evaluation!.metrics as { unsupportedRefused: number }).unsupportedRefused)}, wrongly refused ${pct((evaluation!.metrics as { wronglyRefused: number }).wronglyRefused)}; gates passed: ${evaluation?.passed}` : 'tuning: no tried setting is better on every measure; current settings kept');
  console.log(`intent model (${model.trainedOn} seeds, ${intent.n} held-out): accuracy ${pct(intent.accuracy)}, confident ${pct(intent.confident.share)} at ${pct(intent.confident.accuracy)}; gates passed: ${intentGate.passed}`);
  report[clientId] = { before, tuned: tuned ? { override: tuned.override, after: tuned.after, gatesPassed: evaluation?.passed } : null, intent: { accuracy: intent.accuracy, n: intent.n, confident: intent.confident } };
}
await mkdir('eval-results', { recursive: true });
await writeFile(`eval-results/learning-eval-${mode}.json`, JSON.stringify(report, null, 2));
await db.close();
