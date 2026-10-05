import { randomUUID } from 'node:crypto';
import type {
  ChatRequest,
  ChatResponse,
  ConversationView,
  SimulatorControls,
  TraceEvent,
} from '@adk/shared';
import type { ClientRegistry } from '../clients';
import type { Env } from '../config';
import { conversationsRepo as repo, createDbIdempotencyStore, type Db } from '../database';
import type { HandoffService } from '../handoff';
import type { Retriever } from '../knowledge/types';
import type { LlmClient } from '../llm';
import type { Logger } from '../logger';
import { HttpError } from '../middleware/error-handler';
import { clientCredentialsFetcher, createTokenCache, type TokenCache } from '../tools/auth';
import { createApiClient, type RetryPolicy } from '../tools/http';
import { runTurn } from './loop';
import { newState, toStateView } from './state';

export interface ChatServiceDeps {
  db: Db;
  registry: ClientRegistry;
  llm: LlmClient;
  logger: Logger;
  env: Env;
  retrieve?: Retriever;
  handoff: HandoffService;
  fetchImpl?: typeof fetch;
  /** Override company-API retry timing (tests use tiny delays). */
  apiRetry?: RetryPolicy;
}

export interface ChatService {
  chat(req: ChatRequest): Promise<ChatResponse>;
  view(conversationId: string): Promise<ConversationView>;
  reset(conversationId: string): Promise<ConversationView>;
  setSimulator(conversationId: string, sim: SimulatorControls): Promise<ConversationView>;
  addVoiceLatency(conversationId: string, ms: number): Promise<void>;
}

export function createChatService(deps: ChatServiceDeps): ChatService {
  const { db, registry, env } = deps;
  const idempotency = createDbIdempotencyStore(db);
  const tokenCaches = new Map<string, TokenCache>();
  // One turn at a time per conversation, so a double-submit cannot interleave two agent loops.
  const locks = new Map<string, Promise<unknown>>();

  const tokensFor = (clientId: string, basePath: string): TokenCache => {
    let cache = tokenCaches.get(clientId);
    if (!cache) {
      cache = createTokenCache({
        fetchToken: clientCredentialsFetcher({
          tokenUrl: `${env.MOCK_SERVICES_URL}${basePath}/oauth/token`,
          clientId: env.MOCK_CLIENT_ID,
          clientSecret: env.MOCK_CLIENT_SECRET,
          fetchImpl: deps.fetchImpl,
        }),
      });
      tokenCaches.set(clientId, cache);
    }
    return cache;
  };

  async function load(conversationId: string) {
    const convo = await repo.getConversation(db, conversationId);
    if (!convo) throw new HttpError(404, 'NOT_FOUND', 'Conversation not found');
    return convo;
  }

  async function view(conversationId: string): Promise<ConversationView> {
    const convo = await load(conversationId);
    const [messages, trace] = await Promise.all([
      repo.listMessages(db, conversationId),
      repo.listTrace(db, conversationId),
    ]);
    return {
      conversationId,
      clientId: convo.clientId,
      messages,
      state: toStateView(convo.state),
      trace,
      citations: repo.latestCitations(trace),
      simulator: convo.simulator,
    };
  }

  async function runLocked(req: ChatRequest): Promise<ChatResponse> {
    const module = registry.get(req.clientId);
    if (!module) throw new HttpError(404, 'NOT_FOUND', `Unknown client "${req.clientId}"`);
    const channel = req.channel ?? 'chat';
    if (!module.config.channels.includes(channel)) {
      throw new HttpError(
        400,
        'CHANNEL_NOT_SUPPORTED',
        `${module.config.displayName} does not support ${channel}`,
      );
    }

    let convo = req.conversationId ? await load(req.conversationId) : undefined;
    if (convo && convo.clientId !== req.clientId)
      throw new HttpError(400, 'CLIENT_MISMATCH', 'Conversation belongs to another client');
    if (!convo) {
      const newId = await repo.createConversation(db, req.clientId, newState(module.config));
      if (req.simulator)
        await repo.saveConversation(db, newId, newState(module.config), req.simulator);
      convo = await load(newId);
    }
    const id = convo.id;
    const history = (await repo.listMessages(db, id)).map(({ role, content }) => ({
      role,
      content,
    }));

    const base = `${env.MOCK_SERVICES_URL}${module.apiBasePath}`;
    const tokens = tokensFor(req.clientId, module.apiBasePath);
    const out = await runTurn(
      {
        llm: deps.llm,
        logger: deps.logger,
        idempotency,
        retrieve: deps.retrieve,
        handoff: deps.handoff,
        makeApi: (sim) =>
          createApiClient({
            baseUrl: base,
            tokens,
            fetchImpl: deps.fetchImpl,
            retry: deps.apiRetry,
            extraHeaders: () => ({
              ...(sim.apiFailing ? { 'x-sim-fail': '1' } : {}),
              ...(sim.latencyMs > 0 ? { 'x-sim-latency-ms': String(sim.latencyMs) } : {}),
            }),
          }),
      },
      {
        conversationId: id,
        module,
        state: convo.state,
        history,
        userMessage: req.message,
        channel,
        simulator: convo.simulator,
      },
    );

    await repo.addMessage(db, id, 'user', req.message);
    await repo.addMessage(db, id, 'assistant', out.reply);
    await repo.addToolCalls(db, id, out.toolCalls);
    await repo.addTraceEvents(db, id, out.trace);
    await repo.saveConversation(db, id, out.state);

    return {
      conversationId: id,
      reply: out.reply,
      state: toStateView(out.state),
      trace: out.trace,
      citations: out.citations,
      handoff: out.handoff,
    };
  }

  return {
    async chat(req) {
      const key = req.conversationId ?? randomUUID();
      const previous = locks.get(key) ?? Promise.resolve();
      const run = previous.catch(() => undefined).then(() => runLocked(req));
      locks.set(key, run);
      try {
        return await run;
      } finally {
        if (locks.get(key) === run) locks.delete(key);
      }
    },
    view,
    async reset(conversationId) {
      const convo = await load(conversationId);
      const module = registry.get(convo.clientId);
      if (!module) throw new HttpError(404, 'NOT_FOUND', 'Unknown client');
      await repo.resetConversation(db, conversationId, newState(module.config));
      return view(conversationId);
    },
    async setSimulator(conversationId, sim) {
      const convo = await load(conversationId);
      await repo.saveConversation(db, conversationId, convo.state, sim);
      return view(conversationId);
    },
    async addVoiceLatency(conversationId, ms) {
      await load(conversationId);
      const event: TraceEvent = {
        id: randomUUID(),
        at: new Date().toISOString(),
        type: 'voice',
        label: `Voice latency: speech end to first audio`,
        status: ms < 1500 ? 'ok' : 'warn',
        latencyMs: Math.round(ms),
      };
      await repo.addTraceEvents(db, conversationId, [event]);
    },
  };
}
