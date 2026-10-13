import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { LlmClient, LlmRequest, LlmResponse } from '@backend/llm';
import { ok, fail, type ToolResult } from '@adk/shared';
import { createMockApp, defaultOptions } from '../../mock-services/src/app';
import { createMemoryDb, runMigrations, type DbHandle } from '@backend/database';
import { loadEnv } from '@backend/config';
import { createLogger } from '@backend/logger';
import { loadClients } from '@backend/clients';
import { createChatService, type ChatService } from '@backend/agent';
import { createHandoffService } from '@backend/handoff';
import { createApp } from '@backend/app';
import { createEvalService, evalHandoffService } from '@backend/evals';
import { clientDir } from '@backend/clients';
import {
  createKnowledgeService,
  createRetriever,
  createSearcher,
  ingestClient,
  localProvider,
} from '@backend/knowledge';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

export type ScriptStep =
  | (Partial<LlmResponse> & {
      /** Wait this long before answering (aborts early when the call is cancelled). */
      delayMs?: number;
    })
  | ((req: LlmRequest) => Partial<LlmResponse> | 'fail');

interface Classification {
  intent: string;
  sentiment: string;
  wantsHuman: boolean;
  isPolicyQuestion: boolean;
  confirmation: 'yes' | 'no' | 'none';
}

/**
 * Deterministic stand-in for the real model. Classification calls (recognised by their system
 * prompt) are answered by `classify`; every other call consumes the next scripted step.
 */
export function createScriptedLlm(
  classify: (userMessage: string) => Partial<Classification> = () => ({}),
) {
  const queue: ScriptStep[] = [];
  const calls: LlmRequest[] = [];
  const judgeVerdict = { pass: true, reason: 'Looks good.' };
  let toolId = 0;

  const client: LlmClient = {
    async complete(req, opts): Promise<ToolResult<LlmResponse>> {
      if (opts?.signal?.aborted) return fail('UNAVAILABLE', 'The request was cancelled');
      if (req.system.startsWith('You classify')) {
        const last = req.messages[req.messages.length - 1];
        const text = last && 'content' in last ? last.content : '';
        const msg = /"""([\s\S]*)"""/.exec(text)?.[1] ?? text;
        const c: Classification = {
          intent: 'rebooking',
          sentiment: 'neutral',
          wantsHuman: false,
          isPolicyQuestion: false,
          // Stand-in for the real classifier reading a clear yes / no in the customer's message.
          confirmation: /^\s*(yes|yeah|yep|confirm)\b/i.test(msg)
            ? 'yes'
            : /^\s*(no|nope|cancel)\b/i.test(msg)
              ? 'no'
              : 'none',
          ...classify(msg),
        };
        return ok({ text: JSON.stringify(c), toolCalls: [] });
      }
      if (req.system.startsWith('Summarise')) return fail('UNAVAILABLE', 'no summariser in tests');
      if (req.system.startsWith('You are a strict QA')) {
        return ok({ text: JSON.stringify(judgeVerdict), toolCalls: [] });
      }
      calls.push(req);
      const step = queue.shift();
      if (!step) return ok({ text: 'OK (script exhausted)', toolCalls: [] });
      const resolved = typeof step === 'function' ? step(req) : step;
      if (resolved === 'fail') return fail('UNAVAILABLE', 'model down');
      const delayMs = (resolved as { delayMs?: number }).delayMs;
      if (delayMs) {
        const cancelled = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), delayMs);
          opts?.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              resolve(true);
            },
            { once: true },
          );
        });
        if (cancelled) return fail('UNAVAILABLE', 'The request was cancelled');
      }
      // Stream the text word by word, like a model that supports streaming.
      if (opts?.onTextDelta && resolved.text) {
        for (const piece of resolved.text.match(/\S+\s*/g) ?? []) opts.onTextDelta(piece);
      }
      return ok({
        text: resolved.text ?? '',
        toolCalls: (resolved.toolCalls ?? []).map((c) => ({
          ...c,
          id: c.id || `call_${++toolId}`,
        })),
      });
    },
  };
  return {
    client,
    calls,
    script: (...steps: ScriptStep[]) => queue.push(...steps),
    remaining: () => queue.length,
    judgeVerdict,
    reset: () => {
      judgeVerdict.pass = true;
      judgeVerdict.reason = 'Looks good.';
      queue.length = 0;
      calls.length = 0;
    },
  };
}

export const say = (text: string): ScriptStep => ({ text });
export const callTool = (name: string, input: unknown, text = ''): ScriptStep => ({
  text,
  toolCalls: [{ id: '', name, input }],
});

export interface Harness {
  chat: ChatService;
  evalChat: ChatService;
  db: DbHandle;
  llm: ReturnType<typeof createScriptedLlm>;
  mockUrl: string;
  app: ReturnType<typeof createApp>;
  knowledge: ReturnType<typeof createKnowledgeService>;
  close(): Promise<void>;
}

export async function createHarness(
  opts: {
    ingestKnowledge?: boolean;
    classify?: Parameters<typeof createScriptedLlm>[0];
    /** Extra environment variables, for example the voice gateway secret. */
    env?: Record<string, string>;
  } = {},
): Promise<Harness> {
  const mockApp = createMockApp(defaultOptions());
  const server: Server = await new Promise((resolveServer) => {
    const s = mockApp.listen(0, '127.0.0.1', () => resolveServer(s));
  });
  const mockUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const env = loadEnv({
    MOCK_SERVICES_URL: mockUrl,
    MOCK_CLIENT_ID: 'adk-backend',
    MOCK_CLIENT_SECRET: 'test-client-secret',
    WEBHOOK_SECRET: 'test-webhook-secret',
    ...opts.env,
  });
  const logger = createLogger('silent');
  const db = await createMemoryDb();
  await runMigrations(db, 'memory');
  const registry = loadClients();
  const llm = createScriptedLlm(opts.classify);

  if (opts.ingestKnowledge) {
    for (const m of registry.list()) {
      await ingestClient(
        db.db,
        localProvider,
        m.config.id,
        resolve(clientDir(m), m.config.knowledgeDir),
      );
    }
  }
  const retrieve = createRetriever(db.db, localProvider, logger);
  const handoff = createHandoffService({
    db: db.db,
    logger,
    webhook: { url: `${mockUrl}/contact-center/handoffs`, secret: 'test-webhook-secret' },
  });
  const base = {
    db: db.db,
    registry,
    llm: llm.client,
    logger,
    env,
    retrieve,
    apiRetry: { retries: 2, baseDelayMs: 1, maxDelayMs: 2 },
  };
  const chat = createChatService({ ...base, handoff });
  const evalChat = createChatService({ ...base, handoff: evalHandoffService });
  const evals = createEvalService({
    db: db.db,
    registry,
    llm: llm.client,
    logger,
    chat: evalChat,
    mockServicesUrl: mockUrl,
  });
  const knowledge = createKnowledgeService({
    db: db.db,
    embeddings: localProvider,
    logger,
    dataDir: await mkdtemp(resolve(tmpdir(), 'adk-knowledge-')),
    retryDelayMs: 0,
  });
  const searcher = createSearcher(db.db, localProvider);
  const app = createApp({ env, logger, db: db.db, registry, chat, evals, knowledge, searcher });

  return {
    chat,
    evalChat,
    db,
    llm,
    mockUrl,
    app,
    knowledge,
    close: async () => {
      await new Promise((r) => server.close(r));
      await db.close();
    },
  };
}
