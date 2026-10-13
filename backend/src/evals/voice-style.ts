import { resolve } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import '../config/load-dotenv';
import { loadEnv } from '../config';
import { createChatService } from '../agent';
import { loadClients, clientDir } from '../clients';
import { connectDb, runMigrations } from '../database';
import { createEmbeddingProvider, createRetriever, ingestClient } from '../knowledge';
import { createLlm, type LlmClient } from '../llm';
import { createLogger } from '../logger';
import { evalHandoffService } from './service';
import { loadScenarios } from './scenario';
import { runDeterministicChecks, type ObservedTool } from './checks';
import { styleMetrics, summarizeStyle, type StyleMetrics } from './style-metrics';

// Usage: pnpm --filter @adk/backend voice-style skylink-air novatel
// Runs every voice scenario of each client twice against the REAL model: once with the new spoken
// style prompt, once with the previous one, and compares the replies. Needs the mock services
// running and a real LLM key. Results are written to eval-results/voice-style.json.

const LEGACY_BLOCK = (voiceStyle: string) =>
  [
    'This is a VOICE call. ' + voiceStyle + '.',
    'Keep replies to 1-3 short sentences. No lists, no markdown. Confirm key details (names, flight numbers, times) back to the customer.',
  ].join('\n');

/** Swap the new spoken-style block for the one this feature replaced, leaving every rule untouched. */
function toLegacy(system: string, voiceStyle: string): string {
  const start = system.indexOf('This is a VOICE call.');
  const end = system.indexOf("The customer's words come from speech recognition");
  if (start < 0 || end < 0) return system;
  return system.slice(0, start) + LEGACY_BLOCK(voiceStyle) + '\n' + system.slice(end);
}

const ids = process.argv.slice(2);
if (ids.length === 0) {
  console.error('Usage: pnpm --filter @adk/backend voice-style <client-id>...');
  process.exit(1);
}
const env = loadEnv();
const logger = createLogger('warn');
const handle = await connectDb(env.DATABASE_URL, env.DATABASE_SSL);
await runMigrations(handle);
const registry = loadClients();
const realLlm = createLlm(env);
const retrieve = createRetriever(handle.db, createEmbeddingProvider(env), logger);

const runs: unknown[] = [];
for (const id of ids) {
  const module = registry.get(id);
  if (!module) throw new Error(`Unknown client ${id}`);
  await ingestClient(
    handle.db,
    createEmbeddingProvider(env),
    id,
    resolve(clientDir(module), module.config.knowledgeDir),
  );
  const scenarios = (
    await loadScenarios(resolve(clientDir(module), module.config.scenariosDir))
  ).filter((s) => s.channel === 'voice');
  for (const variant of ['previous', 'new'] as const) {
    const llm: LlmClient =
      variant === 'new'
        ? realLlm
        : {
            ...realLlm,
            complete: (req, opts) =>
              realLlm.complete(
                { ...req, system: toLegacy(req.system, module.config.persona.voiceStyle) },
                opts,
              ),
          };
    const chat = createChatService({
      db: handle.db,
      registry,
      llm,
      logger,
      env,
      retrieve,
      handoff: evalHandoffService,
    });
    const all: StyleMetrics[] = [];
    const perScenario: unknown[] = [];
    for (const s of scenarios) {
      await fetch(`${env.MOCK_SERVICES_URL}/admin/reset`, { method: 'POST' }).catch(
        () => undefined,
      );
      let conversationId: string | undefined;
      const replies: string[] = [];
      const tools: ObservedTool[] = [];
      let handedOff = false;
      for (const message of s.turns) {
        const res = await chat.chat({ clientId: id, conversationId, message, channel: 'voice' });
        conversationId = res.conversationId;
        replies.push(res.reply);
        for (const ev of res.trace) {
          const d = ev.detail as { tool?: string; awaitingApproval?: boolean } | undefined;
          if (ev.type === 'tool' && d?.tool && !d.awaitingApproval)
            tools.push({ tool: d.tool, ok: ev.status === 'ok' });
        }
        if (res.handoff) handedOff = true;
      }
      const failures = runDeterministicChecks(s, { replies, tools, handedOff });
      all.push(...replies.map((r) => styleMetrics(r)));
      perScenario.push({ scenario: s.id, turns: s.turns, replies, failures });
      console.log(
        `${variant.padEnd(8)} ${id}/${s.id}: ${failures.length === 0 ? 'rules ok' : 'RULE FAILURES ' + failures.join('; ')}`,
      );
    }
    runs.push({ client: id, variant, summary: summarizeStyle(all), scenarios: perScenario });
  }
}
await mkdir('eval-results', { recursive: true });
await writeFile(
  'eval-results/voice-style.json',
  JSON.stringify(
    { model: `${env.LLM_PROVIDER}/${env.LLM_MODEL}`, at: new Date().toISOString(), runs },
    null,
    2,
  ),
);
console.log(
  JSON.stringify(
    (runs as { client: string; variant: string; summary: object }[]).map((r) => ({
      client: r.client,
      variant: r.variant,
      ...r.summary,
    })),
    null,
    1,
  ),
);
await handle.close();
