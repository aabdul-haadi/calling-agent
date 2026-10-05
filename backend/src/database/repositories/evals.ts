import { asc, desc, eq } from 'drizzle-orm';
import type { EvalResultView, EvalRunView } from '@adk/shared';
import type { Db } from '../client';
import { evalResults, evalRuns } from '../schema';

export async function createRun(db: Db, clientId: string, total: number): Promise<string> {
  const [row] = await db.insert(evalRuns).values({ clientId, total }).returning({ id: evalRuns.id });
  return row!.id;
}

export async function addResult(db: Db, runId: string, r: Omit<EvalResultView, 'id'>): Promise<void> {
  const { scenarioId, title, passed, ...detail } = r;
  await db.insert(evalResults).values({ runId, scenarioId, title, passed, detail });
}

export async function finishRun(db: Db, runId: string, passed: number, status: 'done' | 'error'): Promise<void> {
  await db.update(evalRuns).set({ passed, status, finishedAt: new Date() }).where(eq(evalRuns.id, runId));
}

async function results(db: Db, runId: string): Promise<EvalResultView[]> {
  const rows = await db.select().from(evalResults).where(eq(evalResults.runId, runId)).orderBy(asc(evalResults.createdAt));
  return rows.map((r) => ({
    id: r.id,
    scenarioId: r.scenarioId,
    title: r.title,
    passed: r.passed,
    ...(r.detail as Omit<EvalResultView, 'id' | 'scenarioId' | 'title' | 'passed'>),
  }));
}

export async function getRun(db: Db, runId: string): Promise<EvalRunView | undefined> {
  const [r] = await db.select().from(evalRuns).where(eq(evalRuns.id, runId));
  if (!r) return undefined;
  return {
    id: r.id,
    clientId: r.clientId,
    status: r.status as EvalRunView['status'],
    total: r.total,
    passed: r.passed,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString(),
    results: await results(db, r.id),
  };
}

export async function listRuns(db: Db, clientId: string, limit = 10): Promise<EvalRunView[]> {
  const rows = await db.select().from(evalRuns).where(eq(evalRuns.clientId, clientId)).orderBy(desc(evalRuns.startedAt)).limit(limit);
  return Promise.all(rows.map(async (r) => (await getRun(db, r.id))!));
}
