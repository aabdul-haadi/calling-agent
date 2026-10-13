import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Citation, SimulatorControls, TraceEvent, TraceStatus } from '@adk/shared';
import { conversationStateSchema, type ConversationState } from '../../agent/state';
import type { Db } from '../client';
import { conversations, messages, toolCalls, traceEvents } from '../schema';

export interface StoredConversation {
  id: string;
  clientId: string;
  state: ConversationState;
  simulator: SimulatorControls;
}

const simulatorSchema = z.object({ apiFailing: z.boolean(), latencyMs: z.number() });
export const DEFAULT_SIMULATOR: SimulatorControls = { apiFailing: false, latencyMs: 0 };

export async function createConversation(
  db: Db,
  clientId: string,
  state: ConversationState,
): Promise<string> {
  const [row] = await db
    .insert(conversations)
    .values({ clientId, state })
    .returning({ id: conversations.id });
  return row!.id;
}

export async function getConversation(db: Db, id: string): Promise<StoredConversation | undefined> {
  const [row] = await db.select().from(conversations).where(eq(conversations.id, id));
  if (!row) return undefined;
  const state = conversationStateSchema.safeParse(row.state);
  if (!state.success) return undefined;
  const sim = simulatorSchema.safeParse(row.simulator);
  return {
    id: row.id,
    clientId: row.clientId,
    state: state.data,
    simulator: sim.success ? sim.data : DEFAULT_SIMULATOR,
  };
}

export async function saveConversation(
  db: Db,
  id: string,
  state: ConversationState,
  simulator?: SimulatorControls,
): Promise<void> {
  await db
    .update(conversations)
    .set({ state, ...(simulator ? { simulator } : {}), updatedAt: new Date() })
    .where(eq(conversations.id, id));
}

export async function addMessage(
  db: Db,
  conversationId: string,
  role: 'user' | 'assistant' | 'human',
  content: string,
) {
  await db.insert(messages).values({ conversationId, role, content });
}

export async function listMessages(db: Db, conversationId: string) {
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));
  return rows.map((r) => ({
    role:
      r.role === 'user'
        ? ('user' as const)
        : r.role === 'human'
          ? ('human' as const)
          : ('assistant' as const),
    content: r.content,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function addToolCalls(
  db: Db,
  conversationId: string,
  calls: { tool: string; input: unknown; output: unknown; status: string; latencyMs: number }[],
) {
  if (calls.length === 0) return;
  await db
    .insert(toolCalls)
    .values(
      calls.map((c) => ({ conversationId, ...c, input: c.input ?? {}, output: c.output ?? {} })),
    );
}

export async function addTraceEvents(db: Db, conversationId: string, events: TraceEvent[]) {
  if (events.length === 0) return;
  await db.insert(traceEvents).values(
    events.map((e) => ({
      id: e.id,
      conversationId,
      type: e.type,
      label: e.label,
      status: e.status,
      latencyMs: e.latencyMs ?? null,
      detail: e.detail ?? null,
      createdAt: new Date(e.at),
    })),
  );
}

export async function listTrace(db: Db, conversationId: string): Promise<TraceEvent[]> {
  const rows = await db
    .select()
    .from(traceEvents)
    .where(eq(traceEvents.conversationId, conversationId))
    .orderBy(asc(traceEvents.createdAt));
  return rows.map((r) => ({
    id: r.id,
    at: r.createdAt.toISOString(),
    type: r.type,
    label: r.label,
    status: r.status as TraceStatus,
    latencyMs: r.latencyMs ?? undefined,
    detail: r.detail ?? undefined,
  }));
}

/** "Knowledge used" = the citations attached to the most recent policy lookup in the trace. */
export function latestCitations(trace: TraceEvent[]): Citation[] {
  const last = [...trace].reverse().find((t) => t.type === 'knowledge' && t.detail);
  const detail = last?.detail as Citation[] | { citations?: Citation[] } | undefined;
  return (Array.isArray(detail) ? detail : detail?.citations) ?? [];
}

export async function resetConversation(db: Db, id: string, state: ConversationState) {
  await db.delete(messages).where(eq(messages.conversationId, id));
  await db.delete(toolCalls).where(eq(toolCalls.conversationId, id));
  await db.delete(traceEvents).where(eq(traceEvents.conversationId, id));
  await saveConversation(db, id, state);
}
