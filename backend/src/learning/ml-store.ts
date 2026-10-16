import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../database/client';
import { knowledgeProposals, shadowOutputs, trainingRuns } from '../database/learning-schema';

export type RunRow = typeof trainingRuns.$inferSelect;
export type ShadowRow = typeof shadowOutputs.$inferSelect;
export type ProposalRow = typeof knowledgeProposals.$inferSelect;

export type RunStatus = 'queued' | 'running' | 'cancelling' | 'cancelled' | 'interrupted' | 'done' | 'failed' | 'refused';
export type ProposalStatus = 'draft' | 'building' | 'evaluated' | 'approved' | 'deployed' | 'rejected' | 'rolled_back' | 'failed';

export function createMlStore(db: Db) {
  return {
    // ---- training runs -----------------------------------------------------------------------
    async insertRun(r: typeof trainingRuns.$inferInsert): Promise<RunRow> {
      const [row] = await db.insert(trainingRuns).values(r).returning();
      return row!;
    },
    async getRun(clientId: string, id: string): Promise<RunRow | undefined> {
      const [row] = await db.select().from(trainingRuns).where(and(eq(trainingRuns.id, id), eq(trainingRuns.clientId, clientId)));
      return row;
    },
    async getRunById(id: string): Promise<RunRow | undefined> {
      const [row] = await db.select().from(trainingRuns).where(eq(trainingRuns.id, id));
      return row;
    },
    async updateRun(id: string, patch: Partial<typeof trainingRuns.$inferInsert>): Promise<RunRow | undefined> {
      const [row] = await db.update(trainingRuns).set(patch).where(eq(trainingRuns.id, id)).returning();
      return row;
    },
    async listRuns(clientId: string, limit = 30): Promise<RunRow[]> {
      return db.select().from(trainingRuns).where(eq(trainingRuns.clientId, clientId)).orderBy(desc(trainingRuns.startedAt)).limit(limit);
    },
    async runsWithStatus(statuses: RunStatus[]): Promise<RunRow[]> {
      return db.select().from(trainingRuns).where(inArray(trainingRuns.status, statuses));
    },

    // ---- shadow outputs ----------------------------------------------------------------------
    async insertShadow(r: typeof shadowOutputs.$inferInsert): Promise<void> {
      await db.insert(shadowOutputs).values(r);
    },
    async listShadow(clientId: string, releaseId: string, limit = 100): Promise<ShadowRow[]> {
      return db
        .select()
        .from(shadowOutputs)
        .where(and(eq(shadowOutputs.clientId, clientId), eq(shadowOutputs.releaseId, releaseId)))
        .orderBy(desc(shadowOutputs.createdAt))
        .limit(limit);
    },
    async shadowStats(clientId: string, releaseId: string) {
      const [row] = await db
        .select({
          n: sql<number>`count(*)::int`,
          failed: sql<number>`count(*) filter (where ${shadowOutputs.error} is not null)::int`,
          meanSimilarity: sql<number>`coalesce(avg(${shadowOutputs.similarity}), 0)::float`,
          p50: sql<number>`coalesce(percentile_cont(0.5) within group (order by ${shadowOutputs.candidateMs}), 0)::float`,
          p95: sql<number>`coalesce(percentile_cont(0.95) within group (order by ${shadowOutputs.candidateMs}), 0)::float`,
        })
        .from(shadowOutputs)
        .where(and(eq(shadowOutputs.clientId, clientId), eq(shadowOutputs.releaseId, releaseId)));
      return row ?? { n: 0, failed: 0, meanSimilarity: 0, p50: 0, p95: 0 };
    },

    // ---- knowledge proposals -----------------------------------------------------------------
    async insertProposal(p: typeof knowledgeProposals.$inferInsert): Promise<ProposalRow> {
      const [row] = await db.insert(knowledgeProposals).values(p).returning();
      return row!;
    },
    async getProposal(clientId: string, id: string): Promise<ProposalRow | undefined> {
      const [row] = await db.select().from(knowledgeProposals).where(and(eq(knowledgeProposals.id, id), eq(knowledgeProposals.clientId, clientId)));
      return row;
    },
    async updateProposal(clientId: string, id: string, patch: Partial<typeof knowledgeProposals.$inferInsert>): Promise<ProposalRow | undefined> {
      const [row] = await db
        .update(knowledgeProposals)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(knowledgeProposals.id, id), eq(knowledgeProposals.clientId, clientId)))
        .returning();
      return row;
    },
    async listProposals(clientId: string): Promise<ProposalRow[]> {
      return db.select().from(knowledgeProposals).where(eq(knowledgeProposals.clientId, clientId)).orderBy(desc(knowledgeProposals.createdAt));
    },
  };
}

export type MlStore = ReturnType<typeof createMlStore>;
