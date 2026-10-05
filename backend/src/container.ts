import { createChatService, type ChatService } from './agent';
import { loadClients, type ClientRegistry } from './clients';
import type { Env } from './config';
import type { Db } from './database';
import { evalHandoffService, createEvalService, type EvalRunner } from './evals';
import { createHandoffService } from './handoff';
import { createEmbeddingProvider, createRetriever } from './knowledge';
import { createLlm, type LlmClient } from './llm';
import type { Logger } from './logger';

export interface Services {
  registry: ClientRegistry;
  llm: LlmClient;
  chat: ChatService;
  evals: EvalRunner;
}

/** Wires the real implementations together. Tests build their own with fakes instead. */
export function createServices(env: Env, db: Db, logger: Logger): Services {
  const registry = loadClients();
  const llm = createLlm(env);
  const retrieve = createRetriever(db, createEmbeddingProvider(env), logger);
  const handoff = createHandoffService({
    db,
    logger,
    llm,
    webhook: {
      url: `${env.MOCK_SERVICES_URL}/contact-center/handoffs`,
      secret: env.WEBHOOK_SECRET,
    },
  });
  const base = { db, registry, llm, logger, env, retrieve };
  const chat = createChatService({ ...base, handoff });
  const evalChat = createChatService({ ...base, handoff: evalHandoffService });
  const evals = createEvalService({
    db,
    registry,
    llm,
    logger,
    chat: evalChat,
    mockServicesUrl: env.MOCK_SERVICES_URL,
  });
  return { registry, llm, chat, evals };
}
