import { asc, eq } from 'drizzle-orm';
import type { AuditEvent } from '../../agent/audit';
import type { Db } from '../client';
import { auditEvents } from '../schema';

export async function addAuditEvents(
  db: Db,
  conversationId: string,
  clientId: string,
  events: AuditEvent[],
): Promise<void> {
  if (events.length === 0) return;
  await db.insert(auditEvents).values(
    events.map((e) => ({
      conversationId,
      clientId,
      type: e.type,
      data: e.data,
      createdAt: new Date(e.at),
    })),
  );
}

export async function listAuditEvents(db: Db, conversationId: string) {
  const rows = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.conversationId, conversationId))
    .orderBy(asc(auditEvents.createdAt));
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    data: r.data,
    at: r.createdAt.toISOString(),
  }));
}
