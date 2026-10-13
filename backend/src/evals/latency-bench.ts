import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import '../config/load-dotenv';
import type { TurnEvent, TurnTimings } from '@adk/shared';
import { loadEnv } from '../config';
import { createChatService } from '../agent';
import { clientDir, loadClients } from '../clients';
import { connectDb, runMigrations } from '../database';
import { createEmbeddingProvider, createRetriever, ingestClient } from '../knowledge';
import { createLlm } from '../llm';
import { createLogger } from '../logger';
import { evalHandoffService } from './service';

// Usage: pnpm --filter @adk/backend latency-bench <label> [runs]
// Plays representative customer conversations against the REAL model, in the voice channel with
// streaming on, and reports where each turn's time went: understanding the message, searching the
// policies, each model call (and when its first word arrived), each tool call. The mock services
// must be running. Stop `pnpm dev` first (the local database allows one process).
// Results: eval-results/latency-<label>.json

interface Conversation {
  id: string;
  clientId: string;
  turns: string[];
}

const CONVERSATIONS: Conversation[] = [
  { id: 'smalltalk', clientId: 'skylink-air', turns: ['Hi there', 'Thanks, that is all'] },
  {
    id: 'policy',
    clientId: 'skylink-air',
    turns: ['How many checked bags can I take in economy?', 'And what about overweight bags?'],
  },
  {
    id: 'refund-followup',
    clientId: 'skylink-air',
    turns: ['What is the refund policy if you cancel my flight?', 'And how long does it take?'],
  },
  {
    id: 'rebook',
    clientId: 'skylink-air',
    turns: [
      'My flight got cancelled',
      'My booking reference is SK1001 and my last name is Rahman',
      'The first option please',
      'Yes, go ahead',
    ],
  },
  {
    id: 'bill',
    clientId: 'novatel',
    turns: ['Why is my bill higher this month?', 'Account NT2002, last name Alvarez'],
  },
];

const label = process.argv[2] ?? 'run';
const runs = Number(process.argv[3] ?? 3);
const only = process.argv[4]?.split(',');
const env = loadEnv();
const logger = createLogger('warn');
const handle = await connectDb(env.DATABASE_URL, env.DATABASE_SSL);
await runMigrations(handle);
const registry = loadClients();
const embeddings = createEmbeddingProvider(env);
const retrieve = createRetriever(handle.db, embeddings, logger);
for (const m of registry.list()) {
  await ingestClient(
    handle.db,
    embeddings,
    m.config.id,
    resolve(clientDir(m), m.config.knowledgeDir),
  );
}
const chat = createChatService({
  db: handle.db,
  registry,
  llm: createLlm(env),
  logger,
  env,
  retrieve,
  handoff: evalHandoffService,
});

interface Sample {
  conversation: string;
  turn: number;
  message: string;
  wallMs: number;
  firstTextMs: number | null;
  timings?: TurnTimings;
}

const samples: Sample[] = [];
for (let r = 0; r < runs; r++) {
  for (const c of CONVERSATIONS.filter((x) => !only || only.includes(x.id))) {
    await fetch(`${env.MOCK_SERVICES_URL}/admin/reset`, { method: 'POST' }).catch(() => undefined);
    let conversationId: string | undefined;
    for (const [i, message] of c.turns.entries()) {
      const t0 = performance.now();
      let firstText: number | null = null;
      const res = await chat.chat(
        { clientId: c.clientId, conversationId, message, channel: 'voice' },
        {
          onEvent: (e: TurnEvent) => {
            if (e.type === 'agent.text.delta' && firstText === null)
              firstText = performance.now() - t0;
          },
        },
      );
      conversationId = res.conversationId;
      samples.push({
        conversation: c.id,
        turn: i + 1,
        message,
        wallMs: Math.round(performance.now() - t0),
        firstTextMs: firstText === null ? null : Math.round(firstText),
        timings: res.timings,
      });
      process.stdout.write('.');
    }
  }
}
process.stdout.write('\n');

const pct = (xs: number[], p: number) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]!);
};
const stat = (xs: number[]) => ({ n: xs.length, p50: pct(xs, 0.5), p95: pct(xs, 0.95) });
const stageMs = (stage: string) =>
  samples.flatMap((s) =>
    (s.timings?.stages ?? []).filter((x) => x.stage === stage).map((x) => x.ms),
  );

const summary = {
  label,
  model: `${env.LLM_PROVIDER}/${env.LLM_MODEL}`,
  reasoningEffort: env.LLM_REASONING_EFFORT ?? null,
  embeddings: env.EMBEDDING_PROVIDER,
  runs,
  at: new Date().toISOString(),
  turns: samples.length,
  wallMs: stat(samples.map((s) => s.wallMs)),
  firstTextMs: stat(samples.flatMap((s) => (s.firstTextMs === null ? [] : [s.firstTextMs]))),
  understandMs: stat(stageMs('understand')),
  retrieveMs: stat(stageMs('retrieve')),
  llmCallMs: stat(stageMs('llm')),
  // the same calls without the time spent waiting for the provider's token-per-minute limit
  llmCallMsWithoutRateLimit: stat(
    samples.flatMap((s) =>
      (s.timings?.stages ?? [])
        .filter((x) => x.stage === 'llm')
        .map((x) => x.ms - (x.rateLimitMs ?? 0)),
    ),
  ),
  rateLimitWaitMsPerTurn: stat(
    samples.map((s) => (s.timings?.stages ?? []).reduce((n, x) => n + (x.rateLimitMs ?? 0), 0)),
  ),
  turnMsWithoutRateLimit: stat(
    samples.map(
      (s) =>
        s.wallMs -
        (s.timings?.stages ?? [])
          .filter((x) => x.rateLimitMs)
          .reduce((n, x) => Math.max(n, x.rateLimitMs ?? 0), 0),
    ),
  ),
  llmFirstTokenMs: stat(
    samples.flatMap((s) =>
      (s.timings?.stages ?? []).flatMap((x) =>
        x.stage === 'llm' && x.firstTokenMs !== undefined ? [x.firstTokenMs] : [],
      ),
    ),
  ),
  toolMs: stat(stageMs('tool')),
  llmCallsPerTurn: stat(
    samples.map((s) => (s.timings?.stages ?? []).filter((x) => x.stage === 'llm').length),
  ),
  byConversation: Object.fromEntries(
    CONVERSATIONS.map((c) => [
      c.id,
      {
        wallMs: stat(samples.filter((s) => s.conversation === c.id).map((s) => s.wallMs)),
        firstTextMs: stat(
          samples.flatMap((s) =>
            s.conversation === c.id && s.firstTextMs !== null ? [s.firstTextMs] : [],
          ),
        ),
      },
    ]),
  ),
};
await mkdir('eval-results', { recursive: true });
await writeFile(
  `eval-results/latency-${label}.json`,
  JSON.stringify({ summary, samples }, null, 2),
);
console.log(JSON.stringify(summary, null, 1));
await handle.close();
