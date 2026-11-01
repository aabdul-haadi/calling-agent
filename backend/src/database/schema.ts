import { sql } from 'drizzle-orm';
import type { ChatResponse } from '@adk/shared';
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';

// Fixed so every embedding provider returns the same size (the local semantic model produces 384;
// the offline hashing fallback and OpenAI are asked for 384 too).
export const EMBEDDING_DIMENSIONS = 384;

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const clients = pgTable('clients', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  createdAt: createdAt(),
});

export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: text('client_id').notNull(),
  state: jsonb('state').notNull(),
  simulator: jsonb('simulator')
    .notNull()
    .default(sql`'{"apiFailing":false,"latencyMs":0}'::jsonb`),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id').notNull(),
    role: text('role').notNull(),
    content: text('content').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('messages_conversation_idx').on(t.conversationId)],
);

export const toolCalls = pgTable(
  'tool_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id').notNull(),
    tool: text('tool').notNull(),
    input: jsonb('input').notNull(),
    output: jsonb('output').notNull(),
    status: text('status').notNull(),
    latencyMs: integer('latency_ms').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('tool_calls_conversation_idx').on(t.conversationId)],
);

export const traceEvents = pgTable(
  'trace_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id').notNull(),
    type: text('type').notNull(),
    label: text('label').notNull(),
    status: text('status').notNull(),
    latencyMs: integer('latency_ms'),
    detail: jsonb('detail'),
    createdAt: createdAt(),
  },
  (t) => [index('trace_events_conversation_idx').on(t.conversationId)],
);

/** Append-only record of decisions that mattered (proposals, approvals, changes). Never updated. */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id').notNull(),
    clientId: text('client_id').notNull(),
    type: text('type').notNull(),
    data: jsonb('data').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('audit_events_conversation_idx').on(t.conversationId)],
);

export const handoffs = pgTable('handoffs', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id').notNull(),
  clientId: text('client_id').notNull(),
  reason: text('reason').notNull(),
  summary: jsonb('summary').notNull(),
  sentiment: text('sentiment').notNull(),
  customerMasked: text('customer_masked').notNull(),
  status: text('status').notNull().default('pending'),
  delivered: boolean('delivered').notNull().default(false),
  createdAt: createdAt(),
});

/** Postgres full-text search vector, kept up to date by the database itself. */
const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

/**
 * A policy document in a company's knowledge base. A document has a name and, over time, versions:
 * uploading the same name again creates version n+1, and only one version is `active` (searchable)
 * once it is ready. Old versions keep their row (history) but lose their chunks.
 */
export const knowledgeDocuments = pgTable(
  'knowledge_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: text('client_id').notNull(),
    name: text('name').notNull(),
    title: text('title'),
    /** folder = policy files shipped with the company, upload = added through the console. */
    origin: text('origin').notNull().default('upload'),
    version: integer('version').notNull().default(1),
    /** queued | extracting | indexing | ready | failed | superseded */
    status: text('status').notNull().default('queued'),
    /** Plain-language detail of the step in progress ("Reading page 12 of 55"). */
    stage: text('stage'),
    progress: integer('progress').notNull().default(0),
    pages: integer('pages'),
    chunks: integer('chunks').notNull().default(0),
    ocrPages: integer('ocr_pages').notNull().default(0),
    sizeBytes: integer('size_bytes'),
    contentHash: text('content_hash'),
    /** Which embedding model produced the stored vectors (a different model means they must be rebuilt). */
    embeddingModel: text('embedding_model'),
    error: jsonb('error'),
    warnings: jsonb('warnings')
      .notNull()
      .default(sql`'[]'::jsonb`),
    attempts: integer('attempts').notNull().default(0),
    /** Is this the version customers get answers from (once ready)? */
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('knowledge_documents_client_idx').on(t.clientId, t.name)],
);

export const knowledgeChunks = pgTable(
  'knowledge_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: text('client_id').notNull(),
    documentId: uuid('document_id'),
    source: text('source').notNull(),
    heading: text('heading').notNull(),
    content: text('content').notNull(),
    /** First and last page the chunk covers (null for plain-text policy files). */
    page: integer('page'),
    pageEnd: integer('page_end'),
    docVersion: integer('doc_version').notNull().default(1),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    tsv: tsvector('tsv').generatedAlwaysAs(
      sql`to_tsvector('english', coalesce(heading, '') || ' ' || content)`,
    ),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('knowledge_chunks_client_idx').on(t.clientId),
    index('knowledge_chunks_document_idx').on(t.documentId),
    index('knowledge_chunks_tsv_idx').using('gin', t.tsv),
    index('knowledge_chunks_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
);

export const idempotencyKeys = pgTable('idempotency_keys', {
  key: text('key').primaryKey(),
  result: jsonb('result').notNull(),
  createdAt: createdAt(),
});

export const chatRequestKeys = pgTable(
  'chat_request_keys',
  {
    key: text('key').primaryKey(),
    fingerprint: text('fingerprint').notNull(),
    conversationId: uuid('conversation_id'),
    status: text('status').notNull(),
    ownerToken: text('owner_token'),
    response: jsonb('response').$type<ChatResponse>(),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('chat_request_keys_retention_idx').on(t.status, t.createdAt)],
);

export const evalRuns = pgTable('eval_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: text('client_id').notNull(),
  status: text('status').notNull().default('running'),
  total: integer('total').notNull().default(0),
  passed: integer('passed').notNull().default(0),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
});

export const evalResults = pgTable(
  'eval_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id').notNull(),
    scenarioId: text('scenario_id').notNull(),
    title: text('title').notNull(),
    passed: boolean('passed').notNull(),
    detail: jsonb('detail').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('eval_results_run_idx').on(t.runId)],
);

export * from './learning-schema';
