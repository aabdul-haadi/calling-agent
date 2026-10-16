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
import { createLearningService, type LearningService } from './learning';
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
  learning: LearningService;
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
  const searcher = createSearcher(db, embeddings, retrievalFor(embeddings), reranker);
  const knowledge = createKnowledgeService({
    db,
    embeddings,
    logger,
    ocr: env.KNOWLEDGE_OCR,
    maxUploadBytes: env.KNOWLEDGE_MAX_UPLOAD_MB * 1024 * 1024,
  });
  const learning = createLearningService({
    db,
    logger,
    registry,
    searcher,
    embeddings,
    llm,
    knowledge,
    ml: {
      localModelUrl: env.LOCAL_MODEL_URL,
      route: env.LOCAL_MODEL_ROUTE,
      minEval: env.LEARNING_MIN_EVAL_EXAMPLES,
      p95Ms: env.LEARNING_MODEL_P95_MS,
      minShadow: env.LEARNING_MIN_SHADOW,
    },
    config: {
      enabled: env.LEARNING_ENABLED,
      retentionDays: env.LEARNING_RETENTION_DAYS,
      minSftExamples: env.LEARNING_MIN_SFT_EXAMPLES,
      minIntentExamples: env.LEARNING_MIN_INTENT_EXAMPLES,
    },
  });
  // Reviewed, evaluated search settings (if any) replace the built-in ones for that company.
  const retrieve = createRetriever(db, embeddings, logger, retrievalFor(embeddings), reranker, (clientId) =>
    learning.runtime.retrievalOverride(clientId),
  );
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
  const chat = createChatService({
    ...base,
    handoff,
    onTurn: (t) => learning.observe(t),
    learning: learning.runtime,
  });
  const evalChat = createChatService({ ...base, handoff: evalHandoffService });
  const evals = createEvalService({
    db,
    registry,
    llm,
    logger,
    chat: evalChat,
    mockServicesUrl: env.MOCK_SERVICES_URL,
  });
  return { registry, llm, chat, evals, knowledge, searcher, embeddings, reranker, learning };
}
