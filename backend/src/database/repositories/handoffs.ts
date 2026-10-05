import { desc, eq } from 'drizzle-orm';
import type { HandoffSummary, HandoffView, Sentiment } from '@adk/shared';
import type { Db } from '../client';
import { handoffs } from '../schema';

type Row = typeof handoffs.$inferSelect;

const toView = (r: Row): HandoffView => ({
  id: r.id,
  conversationId: r.conversationId,
  clientId: r.clientId,
  reason: r.reason,
  summary: r.summary as HandoffSummary,
  sentiment: r.sentiment as Sentiment,
  customerMasked: r.customerMasked,
  status: r.status === 'accepted' ? 'accepted' : 'pending',
  createdAt: r.createdAt.toISOString(),
});

export async function insertHandoff(
  db: Db,
  v: { conversationId: string; clientId: string; reason: string; summary: HandoffSummary; sentiment: Sentiment; customerMasked: string },
): Promise<HandoffView> {
  const [row] = await db.insert(handoffs).values(v).returning();
  return toView(row!);
}

export async function listHandoffs(db: Db, clientId?: string): Promise<HandoffView[]> {
  const q = db.select().from(handoffs);
  const rows = await (clientId ? q.where(eq(handoffs.clientId, clientId)) : q).orderBy(desc(handoffs.createdAt));
  return rows.map(toView);
}

export async function acceptHandoff(db: Db, id: string): Promise<HandoffView | undefined> {
  const [row] = await db.update(handoffs).set({ status: 'accepted' }).where(eq(handoffs.id, id)).returning();
  return row ? toView(row) : undefined;
}

export async function markDelivered(db: Db, id: string): Promise<void> {
  await db.update(handoffs).set({ delivered: true }).where(eq(handoffs.id, id));
}
