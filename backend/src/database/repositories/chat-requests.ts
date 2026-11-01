import { and, eq, lt, lte } from 'drizzle-orm';
import type { ChatResponse } from '@adk/shared';
import type { Db } from '../client';
import { chatRequestKeys } from '../schema';

const LEASE_MS = 5 * 60_000;
const RETENTION_MS = 30 * 24 * 60 * 60_000;

export type ChatRequestReservation =
  | { kind: 'owner' }
  | { kind: 'pending' }
  | { kind: 'conflict' }
  | { kind: 'completed'; response: ChatResponse };

export async function reserveChatRequest(
  db: Db,
  key: string,
  fingerprint: string,
  conversationId: string | null,
  ownerToken: string,
): Promise<ChatRequestReservation> {
  const now = new Date();
  const inserted = await db
    .insert(chatRequestKeys)
    .values({
      key,
      fingerprint,
      conversationId,
      status: 'processing',
      ownerToken,
      leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
    })
    .onConflictDoNothing()
    .returning({ key: chatRequestKeys.key });
  if (inserted.length > 0) return { kind: 'owner' };

  const [existing] = await db.select().from(chatRequestKeys).where(eq(chatRequestKeys.key, key));
  if (!existing) return { kind: 'pending' };
  if (existing.fingerprint !== fingerprint) return { kind: 'conflict' };
  if (existing.status === 'completed') {
    const sameConversation =
      existing.conversationId === conversationId ||
      (existing.conversationId === null && existing.response?.conversationId === conversationId);
    if (!sameConversation) return { kind: 'conflict' };
    if (!existing.response) throw new Error('Completed chat request has no stored response');
    return { kind: 'completed', response: existing.response };
  }
  if (existing.status !== 'processing')
    throw new Error(`Unexpected chat request idempotency status: ${existing.status}`);
  if (existing.conversationId !== null && existing.conversationId !== conversationId)
    return { kind: 'conflict' };
  if (!existing.leaseExpiresAt) throw new Error('Processing chat request has no lease expiry');
  if (existing.leaseExpiresAt <= now) {
    const claimed = await db
      .update(chatRequestKeys)
      .set({
        ownerToken,
        leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
        updatedAt: now,
      })
      .where(
        and(
          eq(chatRequestKeys.key, key),
          eq(chatRequestKeys.status, 'processing'),
          lte(chatRequestKeys.leaseExpiresAt, now),
        ),
      )
      .returning({ key: chatRequestKeys.key });
    if (claimed.length > 0) return { kind: 'owner' };
  }
  return { kind: 'pending' };
}

export async function pruneExpiredChatRequests(db: Db): Promise<void> {
  await db
    .delete(chatRequestKeys)
    .where(
      and(
        eq(chatRequestKeys.status, 'completed'),
        lt(chatRequestKeys.createdAt, new Date(Date.now() - RETENTION_MS)),
      ),
    );
}

export async function renewChatRequestLease(
  db: Db,
  key: string,
  ownerToken: string,
): Promise<boolean> {
  const [row] = await db
    .update(chatRequestKeys)
    .set({ leaseExpiresAt: new Date(Date.now() + LEASE_MS), updatedAt: new Date() })
    .where(
      and(
        eq(chatRequestKeys.key, key),
        eq(chatRequestKeys.status, 'processing'),
        eq(chatRequestKeys.ownerToken, ownerToken),
      ),
    )
    .returning({ key: chatRequestKeys.key });
  return row !== undefined;
}

export async function completeChatRequest(
  db: Db,
  key: string,
  ownerToken: string,
  response: ChatResponse,
): Promise<boolean> {
  const [row] = await db
    .update(chatRequestKeys)
    .set({
      status: 'completed',
      ownerToken: null,
      response,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(chatRequestKeys.key, key),
        eq(chatRequestKeys.status, 'processing'),
        eq(chatRequestKeys.ownerToken, ownerToken),
      ),
    )
    .returning({ key: chatRequestKeys.key });
  return row !== undefined;
}

export async function releaseChatRequest(db: Db, key: string, ownerToken: string): Promise<void> {
  await db
    .delete(chatRequestKeys)
    .where(
      and(
        eq(chatRequestKeys.key, key),
        eq(chatRequestKeys.status, 'processing'),
        eq(chatRequestKeys.ownerToken, ownerToken),
      ),
    );
}

export const CHAT_REQUEST_LEASE_MS = LEASE_MS;
