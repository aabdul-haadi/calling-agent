import { mkdtemp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import '../config/load-dotenv';
import { REPO_ROOT } from '../config/repo-root';
import { createMemoryDb, runMigrations } from '../database';
import {
  createKnowledgeService,
  createSearcher,
  hashProvider,
  semanticProvider,
  crossEncoderReranker,
  retrievalFor,
  extractorPython,
  type EmbeddingProvider,
} from '../knowledge';
import { createLogger } from '../logger';
import { clientDir, loadClients } from '../clients';
import { ingestClient } from '../knowledge';

// Usage: pnpm --filter @adk/backend rag-eval [semantic|hash] [label]
// Builds a knowledge base from the test PDFs (docproc/tests/corpus, made by `pnpm docs:corpus`),
// asks it the questions whose answers are known to be on known pages, and reports how often the
// right passage came back, how often the system correctly said "I don't have that", and how long
// searches take. Uses an in-memory database: nothing in your real knowledge base is touched.

const CORPUS = resolve(REPO_ROOT, 'docproc', 'tests', 'corpus');
if (!existsSync(resolve(CORPUS, 'facts.json'))) {
  console.error('The test PDFs are missing. Run: pnpm docs:corpus');
  process.exit(1);
}
if (!extractorPython()) {
  console.error('The PDF reader is not installed. Run: pnpm docs:setup');
  process.exit(1);
}

interface Fact {
  id: string;
  doc: string;
  question: string;
  answer: string[];
  paraphrases: string[];
  page: number;
}
const facts = JSON.parse(await readFile(resolve(CORPUS, 'facts.json'), 'utf8')) as Record<
  string,
  Fact[]
>;

const providerName = process.argv[2]?.startsWith('hash') ? 'hash' : 'semantic';
const useRerank = process.argv[2]?.endsWith('+rerank') ?? false;
const label =
  process.argv[3] ??
  (useRerank ? `${providerName}-rerank` : providerName) +
    (process.env.RAG_EVAL_BUILTINS === '1' ? '-builtins' : '');
const embeddings: EmbeddingProvider = providerName === 'hash' ? hashProvider : semanticProvider();
await embeddings.warmUp?.();

const logger = createLogger('error');
const db = await createMemoryDb();
await runMigrations(db, 'memory');
const knowledge = createKnowledgeService({
  db: db.db,
  embeddings,
  logger,
  dataDir: await mkdtemp(resolve(tmpdir(), 'adk-rag-')),
  retryDelayMs: 0,
});
const reranker = useRerank ? crossEncoderReranker() : undefined;
await reranker?.warmUp?.();
const searcher = createSearcher(db.db, embeddings, retrievalFor(embeddings), reranker);

async function upload(clientId: string, file: string, as: string) {
  const bytes = await readFile(resolve(CORPUS, `${file}.pdf`));
  const t0 = performance.now();
  await knowledge.upload(clientId, as, bytes);
  await knowledge.idle();
  return Math.round(performance.now() - t0);
}

const ingestMs: Record<string, number> = {};
// RAG_EVAL_BUILTINS=1 also indexes each company's own built-in policy files next to the PDFs, as a
// real tenant has them. Several documents then say similar things, which is the harder case.
const withBuiltins = process.env.RAG_EVAL_BUILTINS === '1';
if (withBuiltins) {
  for (const m of loadClients().list()) {
    await ingestClient(
      db.db,
      embeddings,
      m.config.id,
      resolve(clientDir(m), m.config.knowledgeDir),
    );
  }
}
// The old edition goes in first and is then replaced by the current one under the same name.
ingestMs['skylink v1'] = await upload('skylink-air', 'skylink-handbook-v1', 'skylink-handbook.pdf');
ingestMs['skylink v2 (replaces v1)'] = await upload(
  'skylink-air',
  'skylink-handbook-v2',
  'skylink-handbook.pdf',
);
ingestMs['partner notice'] = await upload(
  'skylink-air',
  'skylink-partner-notice',
  'partner-notice.pdf',
);
ingestMs['novatel'] = await upload('novatel', 'novatel-handbook', 'novatel-handbook.pdf');

const fileOf: Record<string, string> = {
  'skylink-handbook-v2': 'skylink-handbook.pdf',
  'skylink-partner-notice': 'partner-notice.pdf',
  'novatel-handbook': 'novatel-handbook.pdf',
};
const tenantOf = (name: string) => (name.startsWith('novatel') ? 'novatel' : 'skylink-air');

interface Case {
  tenant: string;
  kind: 'exact' | 'paraphrase' | 'followup' | 'unsupported' | 'cross-tenant';
  question: string;
  history?: string[];
  expect?: { source: string; page: number; answer: string[] };
}
const cases: Case[] = [];
for (const [doc, list] of Object.entries(facts)) {
  if (!fileOf[doc]) continue; // the superseded edition is not a source of truth
  for (const f of list) {
    const expect = { source: fileOf[doc]!, page: f.page, answer: f.answer };
    cases.push({ tenant: tenantOf(doc), kind: 'exact', question: f.question, expect });
    for (const p of f.paraphrases)
      cases.push({ tenant: tenantOf(doc), kind: 'paraphrase', question: p, expect });
  }
}
const byId = (doc: string, id: string) => facts[doc]!.find((f) => f.id === id)!;
const followups: [string, string, string][] = [
  ['skylink-handbook-v2', 'cancel-options-2', 'And how long does the refund take?'],
  ['skylink-handbook-v2', 'bag-allow-2', 'And what about an extra bag?'],
  ['skylink-handbook-v2', 'change-fee-2', 'What about for international flights?'],
  ['skylink-handbook-v2', 'pet-cabin-2', 'How heavy can it be?'],
  ['novatel-handbook', 'roaming-rate', 'Is there a maximum?'],
];
const nextFact: Record<string, string> = {
  'cancel-options-2': 'cancel-refund-time-2',
  'bag-allow-2': 'bag-extra-2',
  'change-fee-2': 'change-fee-2',
  'pet-cabin-2': 'pet-cabin-2',
  'roaming-rate': 'roaming-cap',
};
for (const [doc, prevId, follow] of followups) {
  const prev = byId(doc, prevId);
  const target = byId(doc, nextFact[prevId]!);
  cases.push({
    tenant: tenantOf(doc),
    kind: 'followup',
    question: follow,
    history: [prev.question],
    expect: { source: fileOf[doc]!, page: target.page, answer: target.answer },
  });
}
const unsupported: [string, string][] = [
  ['skylink-air', 'Do you serve free Wi-Fi on board?'],
  ['skylink-air', 'What is the capital of Australia?'],
  ['skylink-air', 'Can I bring a firearm in my checked luggage?'],
  ['skylink-air', 'How many miles do I need for a first class upgrade?'],
  ['skylink-air', 'Can you recommend a good pizza restaurant?'],
  ['skylink-air', 'What is the company dress code for cabin crew?'],
  ['skylink-air', 'Do you fly to Antarctica?'],
  ['novatel', 'Do you sell home broadband?'],
  ['novatel', 'What is the airline baggage allowance?'],
  ['novatel', 'How do I reset my email password?'],
  ['novatel', 'What is the best phone to buy?'],
  ['novatel', 'Do you offer student discounts?'],
];
for (const [tenant, q] of unsupported) cases.push({ tenant, kind: 'unsupported', question: q });
for (const f of facts['novatel-handbook']!.slice(0, 4))
  cases.push({ tenant: 'skylink-air', kind: 'cross-tenant', question: f.question });
for (const f of facts['skylink-handbook-v2']!.slice(0, 4))
  cases.push({ tenant: 'novatel', kind: 'cross-tenant', question: f.question });

const ks = [1, 3, 5];
interface Row {
  case: Case;
  relevant: boolean;
  rank: number | null; // 1-based rank of the first passage on the right page
  answerFound: boolean;
  sources: string[];
  ms: number;
  closest?: { rerank?: number; vector?: number; keyword?: number };
  timings: {
    embedMs: number;
    vectorMs: number;
    keywordMs: number;
    rerankMs?: number;
    totalMs: number;
  };
}
const rows: Row[] = [];
for (const c of cases) {
  const t0 = performance.now();
  const r = await searcher.search(c.tenant, c.question, { recentQuestions: c.history });
  const ms = performance.now() - t0;
  let rank: number | null = null;
  if (c.expect) {
    const i = r.passages.findIndex(
      (p) =>
        p.source === c.expect!.source &&
        p.page !== undefined &&
        p.page <= c.expect!.page &&
        c.expect!.page <= (p.pageEnd ?? p.page),
    );
    rank = i >= 0 ? i + 1 : null;
  }
  const text = r.passages.map((p) => p.snippet.toLowerCase()).join(' ');
  rows.push({
    case: c,
    relevant: r.relevant,
    rank,
    answerFound: c.expect ? c.expect.answer.every((a) => text.includes(a.toLowerCase())) : false,
    sources: r.passages.map((p) => `${p.source}${p.page ? ` p${p.page}` : ''}`),
    ms,
    closest: r.closest?.match,
    timings: r.timings,
  });
}

const share = (n: number, d: number) => (d === 0 ? null : Math.round((1000 * n) / d) / 10);
const answerable = rows.filter((r) => r.case.expect);
const byKind = (k: Case['kind']) => rows.filter((r) => r.case.kind === k);
const percentile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length
    ? Math.round(s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]!)
    : null;
};
const summary = {
  label,
  embeddings: embeddings.name,
  reranker: reranker?.name ?? null,
  withBuiltIns: withBuiltins,
  rerankTop: retrievalFor(embeddings).rerankTop,
  at: new Date().toISOString(),
  ingestMs,
  questions: rows.length,
  answerable: answerable.length,
  recallAtK: Object.fromEntries(
    ks.map((k) => [
      k,
      share(answerable.filter((r) => r.rank !== null && r.rank <= k).length, answerable.length),
    ]),
  ),
  mrr:
    Math.round(
      (1000 * answerable.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0)) / answerable.length,
    ) / 1000,
  answerInEvidence: share(answerable.filter((r) => r.answerFound).length, answerable.length),
  byKind: Object.fromEntries(
    (['exact', 'paraphrase', 'followup'] as const).map((k) => {
      const sub = byKind(k);
      return [
        k,
        {
          n: sub.length,
          recallAt3: share(sub.filter((r) => r.rank !== null && r.rank <= 3).length, sub.length),
        },
      ];
    }),
  ),
  abstention: {
    unsupportedCorrectlyRefused: share(
      byKind('unsupported').filter((r) => !r.relevant).length,
      byKind('unsupported').length,
    ),
    unsupportedAnsweredAnyway: byKind('unsupported')
      .filter((r) => r.relevant)
      .map((r) => r.case.question),
    answerableWronglyRefused: share(
      answerable.filter((r) => !r.relevant).length,
      answerable.length,
    ),
  },
  tenantIsolation: {
    crossTenantQuestions: byKind('cross-tenant').length,
    leakedPassages: byKind('cross-tenant').reduce(
      (n, r) =>
        n +
        r.sources.filter((s) =>
          r.case.tenant === 'novatel' ? !s.startsWith('novatel') : s.startsWith('novatel'),
        ).length,
      0,
    ),
    refused: share(
      byKind('cross-tenant').filter((r) => !r.relevant).length,
      byKind('cross-tenant').length,
    ),
  },
  versioning: {
    // the old edition said 14 business days / $50; the current one says 7 / $75
    oldValuesReturned: rows
      .filter(
        (r) =>
          r.case.question.includes('refund take') || r.case.question.includes('change my flight'),
      )
      .filter((r) => r.sources.length && r.answerFound === false && r.case.expect).length,
  },
  stageMs: Object.fromEntries(
    (['embedMs', 'vectorMs', 'keywordMs', 'rerankMs'] as const).map((k) => [
      k,
      percentile(
        rows.map((r) => r.timings[k] ?? 0),
        0.5,
      ),
    ]),
  ),
  searchMs: {
    p50: percentile(
      rows.map((r) => r.ms),
      0.5,
    ),
    p95: percentile(
      rows.map((r) => r.ms),
      0.95,
    ),
  },
  misses: answerable
    .filter((r) => r.rank === null || r.rank > 3)
    .slice(0, 12)
    .map((r) => ({
      q: r.case.question,
      kind: r.case.kind,
      expected: `${r.case.expect!.source} p${r.case.expect!.page}`,
      got: r.sources.slice(0, 3),
      relevant: r.relevant,
    })),
};
await mkdir('eval-results', { recursive: true });
await writeFile(`eval-results/rag-${label}.json`, JSON.stringify({ summary, rows }, null, 2));
console.log(JSON.stringify(summary, null, 1));
await db.close();
