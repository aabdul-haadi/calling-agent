import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';

// Fixed so every embedding provider returns the same size (OpenAI can be asked for 256 dims).
export const EMBEDDING_DIMENSIONS = 256;

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

export const knowledgeChunks = pgTable(
  'knowledge_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: text('client_id').notNull(),
    source: text('source').notNull(),
    heading: text('heading').notNull(),
    content: text('content').notNull(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('knowledge_chunks_client_idx').on(t.clientId)],
);

export const idempotencyKeys = pgTable('idempotency_keys', {
  key: text('key').primaryKey(),
  result: jsonb('result').notNull(),
  createdAt: createdAt(),
});

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
