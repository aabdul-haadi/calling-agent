import { createChatService, type ChatService } from './agent';
import { loadClients, type ClientRegistry } from './clients';
import type { Env } from './config';
import type { Db } from './database';
import { evalHandoffService, createEvalService, type EvalRunner } from './evals';
import { createHandoffService } from './handoff';
import {
  createEmbeddingProvider,
  createKnowledgeService,
  crossEncoderReranker,
  createRetriever,
  createSearcher,
  retrievalFor,
  type Reranker,
  type EmbeddingProvider,
  type KnowledgeService,
  type Searcher,
} from './knowledge';
import { createClassifierLlm, createLlm, type LlmClient } from './llm';
import type { Logger } from './logger';

export interface Services {
  registry: ClientRegistry;
  llm: LlmClient;
  chat: ChatService;
  evals: EvalRunner;
  knowledge: KnowledgeService;
  searcher: Searcher;
  embeddings: EmbeddingProvider;
  reranker?: Reranker;
}

/** Wires the real implementations together. Tests build their own with fakes instead. */
export function createServices(
  env: Env,
  db: Db,
  logger: Logger,
  embeddings: EmbeddingProvider = createEmbeddingProvider(env),
  reranker: Reranker | undefined = embeddings.profile === 'semantic' && env.RAG_RERANK
    ? crossEncoderReranker()
    : undefined,
): Services {
  const registry = loadClients();
  const llm = createLlm(env);
  const classifier = createClassifierLlm(env);
  const retrieve = createRetriever(db, embeddings, logger, retrievalFor(embeddings), reranker);
  const searcher = createSearcher(db, embeddings, retrievalFor(embeddings), reranker);
  const knowledge = createKnowledgeService({
    db,
    embeddings,
    logger,
    ocr: env.KNOWLEDGE_OCR,
    maxUploadBytes: env.KNOWLEDGE_MAX_UPLOAD_MB * 1024 * 1024,
  });
  const handoff = createHandoffService({
    db,
    logger,
    llm,
    webhook: {
      url: `${env.MOCK_SERVICES_URL}/contact-center/handoffs`,
      secret: env.WEBHOOK_SECRET,
    },
  });
  const base = { db, registry, llm, classifier, logger, env, retrieve };
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
  return { registry, llm, chat, evals, knowledge, searcher, embeddings, reranker };
}
