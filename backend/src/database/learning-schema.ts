import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// Learning system. Redacted, tenant-scoped records derived from real conversations. Nothing here
// is read by the live reply path except the ACTIVE release of each kind (see model_releases).

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const empty = (kind: 'array' | 'object') => sql.raw(kind === 'array' ? `'[]'::jsonb` : `'{}'::jsonb`);

/**
 * One customer turn from a voice call or a chat, redacted before it was written. The identifiable
 * conversation stays in `messages`; this row holds only text that already passed redaction.
 */
export const learningTurns = pgTable(
  'learning_turns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: text('client_id').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    turnIndex: integer('turn_index').notNull(),
    channel: text('channel').notNull(),
    intent: text('intent').notNull().default('unknown'),
    sentiment: text('sentiment').notNull().default('neutral'),
    customerText: text('customer_text').notNull(),
    aiReply: text('ai_reply').notNull().default(''),
    humanReply: text('human_reply'),
    /** Source name, page and whether the match was weak: never passage text. */
    sources: jsonb('sources').notNull().default(empty('array')),
    asksPolicy: boolean('asks_policy').notNull().default(false),
    abstained: boolean('abstained').notNull().default(false),
    toolOutcomes: jsonb('tool_outcomes').notNull().default(empty('array')),
    handoffReason: text('handoff_reason'),
    lowConfidence: boolean('low_confidence').notNull().default(false),
    latencyMs: integer('latency_ms'),
    /** unknown | resolved | handed_off | human_resolved | unresolved (never guessed from length or tone) */
    resolution: text('resolution').notNull().default('unknown'),
    rating: integer('rating'),
    correction: text('correction'),
    /** Quality problems found by analysis, e.g. robotic_opener, repeated_reply, unanswered. */
    flags: jsonb('flags').notNull().default(empty('array')),
    /** Where this row came from and how it was processed (never raw text). */
    provenance: jsonb('provenance').notNull().default(empty('object')),
    dedupeHash: text('dedupe_hash').notNull(),
    /** pending | approved | rejected | excluded */
    reviewStatus: text('review_status').notNull().default('pending'),
    reviewer: text('reviewer'),
    reviewNote: text('review_note'),
    /** What a reviewer approved as the right answer (edited from the AI or the human reply). */
    approvedReply: text('approved_reply'),
    /** What an approved example is for: sft, retrieval_eval, behavior, intent. */
    uses: jsonb('uses').notNull().default(empty('array')),
    /** Held-out evaluation example or training example, fixed by a hash of the example. */
    split: text('split').notNull().default('train'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('learning_turns_client_idx').on(t.clientId, t.reviewStatus),
    index('learning_turns_conversation_idx').on(t.conversationId),
    uniqueIndex('learning_turns_dedupe_idx').on(t.clientId, t.dedupeHash),
  ],
);

/** A recurring group of questions the knowledge base could not answer. */
export const learningGaps = pgTable(
  'learning_gaps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: text('client_id').notNull(),
    topicKey: text('topic_key').notNull(),
    label: text('label').notNull(),
    examples: jsonb('examples').notNull().default(empty('array')),
    occurrences: integer('occurrences').notNull().default(0),
    channels: jsonb('channels').notNull().default(empty('array')),
    /** open | covered_by_document | document_requested | dismissed */
    status: text('status').notNull().default('open'),
    /** Existing documents that look related, and a plain recommendation. */
    suggestion: jsonb('suggestion').notNull().default(empty('object')),
    note: text('note'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('learning_gaps_topic_idx').on(t.clientId, t.topicKey)],
);

/** A frozen, versioned set of approved examples. The same version always rebuilds the same files. */
export const learningDatasets = pgTable(
  'learning_datasets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: text('client_id').notNull(),
    version: integer('version').notNull(),
    kind: text('kind').notNull(),
    exampleIds: jsonb('example_ids').notNull(),
    stats: jsonb('stats').notNull(),
    sha256: text('sha256').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('learning_datasets_version_idx').on(t.clientId, t.kind, t.version)],
);

/**
 * Something that changes how an agent behaves, with the evidence for it. Only `active` rows are used
 * by live traffic; `shadow` rows are run beside the active one and never answer anyone.
 * kind: retrieval (search settings) | behavior (style lessons) | intent_model (local classifier).
 */
export const modelReleases = pgTable(
  'model_releases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: text('client_id').notNull(),
    kind: text('kind').notNull(),
    /** voice | chat | both */
    channel: text('channel').notNull().default('both'),
    version: integer('version').notNull(),
    datasetId: uuid('dataset_id'),
    params: jsonb('params').notNull(),
    evaluation: jsonb('evaluation').notNull().default(empty('object')),
    /** candidate | shadow | active | superseded | rejected | rolled_back */
    status: text('status').notNull().default('candidate'),
    rollbackTo: uuid('rollback_to'),
    note: text('note'),
    createdBy: text('created_by'),
    createdAt: createdAt(),
    deployedAt: timestamp('deployed_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('model_releases_version_idx').on(t.clientId, t.kind, t.channel, t.version)],
);

/** Every run of a learning step, so nothing happens invisibly. */
export const learningJobs = pgTable(
  'learning_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: text('client_id'),
    kind: text('kind').notNull(),
    trigger: text('trigger').notNull().default('manual'),
    status: text('status').notNull().default('running'),
    result: jsonb('result').notNull().default(empty('object')),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('learning_jobs_started_idx').on(t.startedAt)],
);

/** One run of the trainer. Lives in the database so it survives a browser refresh and a server restart. */
export const trainingRuns = pgTable(
  'training_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: text('client_id').notNull(),
    datasetId: uuid('dataset_id'),
    /** train | smoke (a smoke run proves the toolchain and can never become a candidate) */
    kind: text('kind').notNull().default('train'),
    base: text('base').notNull(),
    config: jsonb('config').notNull().default(empty('object')),
    /** queued | running | cancelling | cancelled | interrupted | done | failed | refused */
    status: text('status').notNull().default('queued'),
    progress: jsonb('progress').notNull().default(empty('object')),
    logTail: text('log_tail').notNull().default(''),
    pid: integer('pid'),
    outDir: text('out_dir'),
    metrics: jsonb('metrics').notNull().default(empty('object')),
    error: text('error'),
    releaseId: uuid('release_id'),
    createdBy: text('created_by'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('training_runs_client_idx').on(t.clientId, t.startedAt)],
);

/** What a candidate model said in shadow mode. Redacted; never shown to a customer. */
export const shadowOutputs = pgTable(
  'shadow_outputs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: text('client_id').notNull(),
    releaseId: uuid('release_id').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    turnIndex: integer('turn_index').notNull(),
    channel: text('channel').notNull(),
    customerText: text('customer_text').notNull(),
    productionReply: text('production_reply').notNull(),
    candidateReply: text('candidate_reply'),
    similarity: integer('similarity_pct'),
    candidateMs: integer('candidate_ms'),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => [index('shadow_outputs_release_idx').on(t.releaseId)],
);

/** A reviewed proposal to change what the agents know: a new or revised policy document. */
export const knowledgeProposals = pgTable(
  'knowledge_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: text('client_id').notNull(),
    gapId: uuid('gap_id'),
    /** document (a new or revised PDF) | retrieval (search settings: a normal release) */
    kind: text('kind').notNull().default('document'),
    title: text('title').notNull(),
    docName: text('doc_name'),
    /** Where the document comes from and who owns it. A conversation is never a source. */
    attestation: jsonb('attestation').notNull().default(empty('object')),
    fileSha256: text('file_sha256'),
    filePath: text('file_path'),
    /** draft | building | evaluated | approved | deployed | rejected | rolled_back | failed */
    status: text('status').notNull().default('draft'),
    evaluation: jsonb('evaluation').notNull().default(empty('object')),
    releaseId: uuid('release_id'),
    reviewer: text('reviewer'),
    note: text('note'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('knowledge_proposals_client_idx').on(t.clientId, t.status)],
);
