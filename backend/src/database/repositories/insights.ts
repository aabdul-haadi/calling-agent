import { desc, eq, sql } from 'drizzle-orm';
import type {
  ActivityItem,
  ConversationSummary,
  KnowledgeDoc,
  OverviewMetrics,
  ToolStat,
} from '@adk/shared';
import type { Db } from '../client';
import { auditEvents, evalRuns, handoffs, knowledgeChunks } from '../schema';

const rowsOf = <T>(res: unknown): T[] => (res as { rows: T[] }).rows;
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : Math.round(Number(v));

interface StoredState {
  phase?: string;
  journeyStep?: string;
  verified?: boolean;
  handedOff?: boolean;
  proposal?: { status?: string };
}

/** Recent conversations, newest first. Message text is not returned: only counts and state. */
export async function listConversations(
  db: Db,
  clientId?: string,
  limit = 30,
): Promise<ConversationSummary[]> {
  const where = clientId ? sql`WHERE c.client_id = ${clientId}` : sql``;
  const res = await db.execute(sql`
    SELECT c.id, c.client_id, c.state, c.created_at, c.updated_at,
           (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
    FROM conversations c
    ${where}
    ORDER BY c.updated_at DESC
    LIMIT ${limit}`);
  return rowsOf<{
    id: string;
    client_id: string;
    state: StoredState;
    created_at: Date | string;
    updated_at: Date | string;
    message_count: number | string;
  }>(res).map((r) => ({
    id: r.id,
    clientId: r.client_id,
    phase: r.state.phase ?? 'NEW',
    journeyStep: r.state.journeyStep ?? '',
    verified: Boolean(r.state.verified),
    handedOff: Boolean(r.state.handedOff),
    awaitingApproval: r.state.proposal?.status === 'pending',
    messageCount: num(r.message_count),
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  }));
}

export async function computeOverview(db: Db, clientId?: string): Promise<OverviewMetrics> {
  const convFilter = clientId ? sql`WHERE client_id = ${clientId}` : sql``;
  const convJoinFilter = clientId ? sql`WHERE c.client_id = ${clientId}` : sql``;

  const convRows = rowsOf<{ state: StoredState; updated_at: Date | string }>(
    await db.execute(sql`SELECT state, updated_at FROM conversations ${convFilter}`),
  );
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const byPhase: Record<string, number> = {};
  let handedOff = 0;
  let awaitingApproval = 0;
  let last24h = 0;
  for (const r of convRows) {
    const phase = r.state.phase ?? 'NEW';
    byPhase[phase] = (byPhase[phase] ?? 0) + 1;
    if (r.state.handedOff) handedOff++;
    if (r.state.proposal?.status === 'pending') awaitingApproval++;
    if (new Date(r.updated_at).getTime() >= dayAgo) last24h++;
  }

  const toolAll = rowsOf<{
    total: string;
    failed: string;
    p50: number | null;
    p95: number | null;
  }>(
    await db.execute(sql`
      SELECT count(*) AS total,
             count(*) FILTER (WHERE t.status = 'error') AS failed,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY t.latency_ms) AS p50,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY t.latency_ms) AS p95
      FROM tool_calls t JOIN conversations c ON c.id = t.conversation_id ${convJoinFilter}`),
  )[0];

  const perTool: ToolStat[] = rowsOf<{
    tool: string;
    calls: string;
    failures: string;
    avg: number;
    p95: number;
  }>(
    await db.execute(sql`
      SELECT t.tool, count(*) AS calls,
             count(*) FILTER (WHERE t.status = 'error') AS failures,
             avg(t.latency_ms) AS avg,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY t.latency_ms) AS p95
      FROM tool_calls t JOIN conversations c ON c.id = t.conversation_id ${convJoinFilter}
      GROUP BY t.tool ORDER BY calls DESC`),
  ).map((r) => ({
    tool: r.tool,
    calls: num(r.calls),
    failures: num(r.failures),
    avgLatencyMs: Math.round(num(r.avg)),
    p95LatencyMs: Math.round(num(r.p95)),
  }));

  const handoffRows = await db
    .select({ status: handoffs.status, n: sql<number>`count(*)` })
    .from(handoffs)
    .where(clientId ? eq(handoffs.clientId, clientId) : undefined)
    .groupBy(handoffs.status);
  const handoffCount = (status: string) => num(handoffRows.find((r) => r.status === status)?.n);

  const runs = await db
    .select()
    .from(evalRuns)
    .where(clientId ? eq(evalRuns.clientId, clientId) : undefined)
    .orderBy(desc(evalRuns.startedAt))
    .limit(12);
  const finished = runs.filter((r) => r.status === 'done');
  const latest = finished[0];

  const audits = await db
    .select()
    .from(auditEvents)
    .where(clientId ? eq(auditEvents.clientId, clientId) : undefined)
    .orderBy(desc(auditEvents.createdAt))
    .limit(10);
  const recentHandoffs = await db
    .select()
    .from(handoffs)
    .where(clientId ? eq(handoffs.clientId, clientId) : undefined)
    .orderBy(desc(handoffs.createdAt))
    .limit(10);
  const activity: ActivityItem[] = [
    ...audits.map((a) => ({
      id: `a-${a.id}`,
      at: a.createdAt.toISOString(),
      kind: 'audit' as const,
      label: a.type.replace(/_/g, ' '),
      clientId: a.clientId,
      conversationId: a.conversationId,
    })),
    ...recentHandoffs.map((h) => ({
      id: `h-${h.id}`,
      at: h.createdAt.toISOString(),
      kind: 'handoff' as const,
      label: `handoff: ${h.reason}`,
      clientId: h.clientId,
      conversationId: h.conversationId,
    })),
    ...finished.slice(0, 5).map((r) => ({
      id: `e-${r.id}`,
      at: (r.finishedAt ?? r.startedAt).toISOString(),
      kind: 'eval' as const,
      label: `eval run ${r.passed}/${r.total} passed`,
      clientId: r.clientId,
    })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 12);

  return {
    clientId,
    generatedAt: new Date().toISOString(),
    conversations: { total: convRows.length, last24h, handedOff, awaitingApproval, byPhase },
    handoffs: {
      pending: handoffCount('pending'),
      accepted: handoffCount('accepted'),
      resolved: handoffCount('resolved'),
    },
    tools: {
      total: num(toolAll?.total),
      failed: num(toolAll?.failed),
      p50LatencyMs: numOrNull(toolAll?.p50),
      p95LatencyMs: numOrNull(toolAll?.p95),
      perTool,
    },
    evals: {
      latest: latest && {
        id: latest.id,
        clientId: latest.clientId,
        passed: latest.passed,
        total: latest.total,
        startedAt: latest.startedAt.toISOString(),
      },
      history: finished
        .map((r) => ({
          id: r.id,
          passed: r.passed,
          total: r.total,
          startedAt: r.startedAt.toISOString(),
        }))
        .reverse(),
    },
    llmUsage: null,
    recentActivity: activity,
  };
}

/** Documents the agent can cite, from the ingested chunks. */
export async function listKnowledgeDocs(db: Db, clientId: string): Promise<KnowledgeDoc[]> {
  const rows = await db
    .select({
      source: knowledgeChunks.source,
      heading: knowledgeChunks.heading,
      length: sql<number>`length(${knowledgeChunks.content})`,
      updatedAt: knowledgeChunks.updatedAt,
    })
    .from(knowledgeChunks)
    .where(eq(knowledgeChunks.clientId, clientId))
    .orderBy(knowledgeChunks.source);
  const docs = new Map<string, KnowledgeDoc>();
  for (const r of rows) {
    const d = docs.get(r.source) ?? {
      source: r.source,
      chunks: 0,
      headings: [],
      characters: 0,
      updatedAt: r.updatedAt.toISOString(),
    };
    d.chunks++;
    d.characters += num(r.length);
    if (!d.headings.includes(r.heading)) d.headings.push(r.heading);
    if (r.updatedAt.toISOString() > d.updatedAt) d.updatedAt = r.updatedAt.toISOString();
    docs.set(r.source, d);
  }
  return [...docs.values()];
}
