import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Db } from '../database/client';
import {
  learningDatasets,
  learningGaps,
  learningJobs,
  learningTurns,
  modelReleases,
} from '../database/learning-schema';

export type TurnRow = typeof learningTurns.$inferSelect;
export type NewTurn = typeof learningTurns.$inferInsert;
export type GapRow = typeof learningGaps.$inferSelect;
export type DatasetRow = typeof learningDatasets.$inferSelect;
export type ReleaseRow = typeof modelReleases.$inferSelect;
export type JobRow = typeof learningJobs.$inferSelect;

export type ReviewStatus = 'pending' | 'approved' | 'rejected' | 'excluded';
export type ReleaseKind = 'retrieval' | 'behavior' | 'intent_model' | 'llm_adapter' | 'knowledge';

export function createLearningStore(db: Db) {
  const now = () => new Date();
  return {
    // ---- turns -------------------------------------------------------------------------------
    /** Idempotent: the same turn arriving twice (a retry) is stored once. Returns whether it was new. */
    async insertTurn(row: NewTurn): Promise<boolean> {
      const out = await db
        .insert(learningTurns)
        .values(row)
        .onConflictDoNothing({ target: [learningTurns.clientId, learningTurns.dedupeHash] })
        .returning({ id: learningTurns.id });
      return out.length > 0;
    },
    async getTurn(clientId: string, id: string): Promise<TurnRow | undefined> {
      const [row] = await db
        .select()
        .from(learningTurns)
        .where(and(eq(learningTurns.id, id), eq(learningTurns.clientId, clientId)));
      return row;
    },
    async listTurns(
      clientId: string,
      f: { status?: ReviewStatus; flag?: string; limit?: number; split?: string } = {},
    ): Promise<TurnRow[]> {
      const conds = [eq(learningTurns.clientId, clientId)];
      if (f.status) conds.push(eq(learningTurns.reviewStatus, f.status));
      if (f.split) conds.push(eq(learningTurns.split, f.split));
      if (f.flag) conds.push(sql`${learningTurns.flags} ? ${f.flag}`);
      return db
        .select()
        .from(learningTurns)
        .where(and(...conds))
        .orderBy(desc(learningTurns.createdAt))
        .limit(f.limit ?? 200);
    },
    async turnsOfConversation(clientId: string, conversationId: string): Promise<TurnRow[]> {
      return db
        .select()
        .from(learningTurns)
        .where(
          and(eq(learningTurns.clientId, clientId), eq(learningTurns.conversationId, conversationId)),
        )
        .orderBy(learningTurns.turnIndex);
    },
    async updateTurn(clientId: string, id: string, patch: Partial<NewTurn>): Promise<TurnRow | undefined> {
      const [row] = await db
        .update(learningTurns)
        .set({ ...patch, updatedAt: now() })
        .where(and(eq(learningTurns.id, id), eq(learningTurns.clientId, clientId)))
        .returning();
      return row;
    },
    async setConversationResolution(clientId: string, conversationId: string, resolution: string) {
      await db
        .update(learningTurns)
        .set({ resolution, updatedAt: now() })
        .where(
          and(eq(learningTurns.clientId, clientId), eq(learningTurns.conversationId, conversationId)),
        );
    },
    /** The human reply goes on the customer turn it answered: the latest turn that was handed over. */
    async attachHumanReply(clientId: string, conversationId: string, reply: string) {
      const [turn] = await db
        .select({ id: learningTurns.id, humanReply: learningTurns.humanReply })
        .from(learningTurns)
        .where(
          and(eq(learningTurns.clientId, clientId), eq(learningTurns.conversationId, conversationId)),
        )
        .orderBy(desc(learningTurns.turnIndex))
        .limit(1);
      if (!turn) return false;
      const joined = turn.humanReply ? `${turn.humanReply}\n${reply}` : reply;
      await db
        .update(learningTurns)
        .set({ humanReply: joined, updatedAt: now() })
        .where(eq(learningTurns.id, turn.id));
      return true;
    },
    async countsByStatus(clientId: string): Promise<Record<string, number>> {
      const rows = await db
        .select({ status: learningTurns.reviewStatus, n: sql<number>`count(*)::int` })
        .from(learningTurns)
        .where(eq(learningTurns.clientId, clientId))
        .groupBy(learningTurns.reviewStatus);
      return Object.fromEntries(rows.map((r) => [r.status, r.n]));
    },
    /** Deleting a customer's data: every learning row of one conversation. */
    async purgeConversation(clientId: string, conversationId: string): Promise<number> {
      const out = await db
        .delete(learningTurns)
        .where(
          and(eq(learningTurns.clientId, clientId), eq(learningTurns.conversationId, conversationId)),
        )
        .returning({ id: learningTurns.id });
      return out.length;
    },
    /** Retention: pending, rejected and excluded rows expire; approved examples are kept until removed. */
    async expire(clientId: string, olderThan: Date): Promise<number> {
      const out = await db
        .delete(learningTurns)
        .where(
          and(
            eq(learningTurns.clientId, clientId),
            lt(learningTurns.createdAt, olderThan),
            inArray(learningTurns.reviewStatus, ['pending', 'rejected', 'excluded']),
          ),
        )
        .returning({ id: learningTurns.id });
      return out.length;
    },

    // ---- gaps --------------------------------------------------------------------------------
    async upsertGap(
      g: Pick<GapRow, 'clientId' | 'topicKey' | 'label' | 'examples' | 'occurrences' | 'channels' | 'suggestion'>,
    ) {
      await db
        .insert(learningGaps)
        .values(g)
        .onConflictDoUpdate({
          target: [learningGaps.clientId, learningGaps.topicKey],
          set: {
            label: g.label,
            examples: g.examples,
            occurrences: g.occurrences,
            channels: g.channels,
            suggestion: g.suggestion,
            updatedAt: now(),
          },
        });
    },
    async listGaps(clientId: string): Promise<GapRow[]> {
      return db
        .select()
        .from(learningGaps)
        .where(eq(learningGaps.clientId, clientId))
        .orderBy(desc(learningGaps.occurrences));
    },
    async setGapStatus(clientId: string, id: string, status: string, note?: string) {
      const [row] = await db
        .update(learningGaps)
        .set({ status, note: note ?? null, updatedAt: now() })
        .where(and(eq(learningGaps.id, id), eq(learningGaps.clientId, clientId)))
        .returning();
      return row;
    },

    // ---- datasets ----------------------------------------------------------------------------
    async nextDatasetVersion(clientId: string, kind: string): Promise<number> {
      const [row] = await db
        .select({ v: sql<number>`coalesce(max(${learningDatasets.version}), 0)::int` })
        .from(learningDatasets)
        .where(and(eq(learningDatasets.clientId, clientId), eq(learningDatasets.kind, kind)));
      return (row?.v ?? 0) + 1;
    },
    async insertDataset(d: typeof learningDatasets.$inferInsert): Promise<DatasetRow> {
      const [row] = await db.insert(learningDatasets).values(d).returning();
      return row!;
    },
    async listDatasets(clientId: string): Promise<DatasetRow[]> {
      return db
        .select()
        .from(learningDatasets)
        .where(eq(learningDatasets.clientId, clientId))
        .orderBy(desc(learningDatasets.createdAt));
    },
    async getDataset(clientId: string, id: string): Promise<DatasetRow | undefined> {
      const [row] = await db
        .select()
        .from(learningDatasets)
        .where(and(eq(learningDatasets.id, id), eq(learningDatasets.clientId, clientId)));
      return row;
    },

    // ---- releases ----------------------------------------------------------------------------
    async nextReleaseVersion(clientId: string, kind: string, channel: string): Promise<number> {
      const [row] = await db
        .select({ v: sql<number>`coalesce(max(${modelReleases.version}), 0)::int` })
        .from(modelReleases)
        .where(
          and(
            eq(modelReleases.clientId, clientId),
            eq(modelReleases.kind, kind),
            eq(modelReleases.channel, channel),
          ),
        );
      return (row?.v ?? 0) + 1;
    },
    async insertRelease(r: typeof modelReleases.$inferInsert): Promise<ReleaseRow> {
      const [row] = await db.insert(modelReleases).values(r).returning();
      return row!;
    },
    async getRelease(clientId: string, id: string): Promise<ReleaseRow | undefined> {
      const [row] = await db
        .select()
        .from(modelReleases)
        .where(and(eq(modelReleases.id, id), eq(modelReleases.clientId, clientId)));
      return row;
    },
    async listReleases(clientId: string): Promise<ReleaseRow[]> {
      return db
        .select()
        .from(modelReleases)
        .where(eq(modelReleases.clientId, clientId))
        .orderBy(desc(modelReleases.createdAt));
    },
    async activeRelease(
      clientId: string,
      kind: ReleaseKind,
      channel: 'voice' | 'chat',
      status: 'active' | 'shadow' = 'active',
    ): Promise<ReleaseRow | undefined> {
      const rows = await db
        .select()
        .from(modelReleases)
        .where(
          and(
            eq(modelReleases.clientId, clientId),
            eq(modelReleases.kind, kind),
            eq(modelReleases.status, status),
            inArray(modelReleases.channel, [channel, 'both']),
          ),
        )
        .orderBy(desc(modelReleases.deployedAt));
      // a channel-specific release wins over a shared one
      return rows.find((r) => r.channel === channel) ?? rows[0];
    },
    async setReleaseStatus(
      clientId: string,
      id: string,
      patch: Partial<typeof modelReleases.$inferInsert>,
    ): Promise<ReleaseRow | undefined> {
      const [row] = await db
        .update(modelReleases)
        .set(patch)
        .where(and(eq(modelReleases.id, id), eq(modelReleases.clientId, clientId)))
        .returning();
      return row;
    },

    // ---- jobs --------------------------------------------------------------------------------
    async startJob(clientId: string | null, kind: string, trigger: string): Promise<string> {
      const [row] = await db
        .insert(learningJobs)
        .values({ clientId, kind, trigger })
        .returning({ id: learningJobs.id });
      return row!.id;
    },
    async finishJob(id: string, status: 'done' | 'failed', result: unknown, error?: string) {
      await db
        .update(learningJobs)
        .set({
          status,
          result: (result ?? {}) as Record<string, unknown>,
          error: error ?? null,
          finishedAt: now(),
        })
        .where(eq(learningJobs.id, id));
    },
    async listJobs(clientId: string, limit = 50): Promise<JobRow[]> {
      return db
        .select()
        .from(learningJobs)
        .where(sql`${learningJobs.clientId} = ${clientId} or ${learningJobs.clientId} is null`)
        .orderBy(desc(learningJobs.startedAt))
        .limit(limit);
    },
  };
}

export type LearningStore = ReturnType<typeof createLearningStore>;
