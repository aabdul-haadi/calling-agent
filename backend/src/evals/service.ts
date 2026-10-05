import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { EvalResultView, EvalRunView } from '@adk/shared';
import type { ChatService } from '../agent';
import { clientDir, type ClientRegistry } from '../clients';
import { evalsRepo, type Db } from '../database';
import { fallbackSummary, customerLabel, REASON_TEXT, type HandoffService } from '../handoff';
import { HttpError } from '../middleware';
import type { LlmClient } from '../llm';
import type { Logger } from '../logger';
import type { EvalService } from '../routes/tests';
import { runScenario } from './runner';
import { loadScenarios } from './scenario';

/** Handoffs raised during tests stay in memory so they never pollute the real human inbox. */
export const evalHandoffService: HandoffService = {
  async create(input) {
    return {
      id: randomUUID(),
      conversationId: input.conversationId,
      clientId: input.clientId,
      reason: REASON_TEXT[input.reason],
      summary: fallbackSummary(input),
      sentiment: input.state.lastSentiment,
      customerMasked: customerLabel(input),
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
  },
};

export interface EvalServiceDeps {
  db: Db;
  registry: ClientRegistry;
  llm: LlmClient;
  logger: Logger;
  /** Chat service wired with `evalHandoffService`. */
  chat: ChatService;
  mockServicesUrl: string;
}

export interface EvalRunner extends EvalService {
  /** Runs a whole suite and waits for it (used by the CLI). */
  run(clientId: string, onResult?: (r: Omit<EvalResultView, 'id'>) => void): Promise<EvalRunView>;
}

export function createEvalService(deps: EvalServiceDeps): EvalRunner {
  const active = new Map<string, string>();

  async function resetMock() {
    try {
      await fetch(`${deps.mockServicesUrl}/admin/reset`, { method: 'POST', signal: AbortSignal.timeout(3000) });
    } catch {
      deps.logger.warn('could not reset mock services before the run');
    }
  }

  async function prepare(clientId: string) {
    const module = deps.registry.get(clientId);
    if (!module) throw new HttpError(404, 'NOT_FOUND', `Unknown client "${clientId}"`);
    const scenarios = await loadScenarios(resolve(clientDir(module), module.config.scenariosDir));
    if (scenarios.length === 0) throw new HttpError(400, 'NO_SCENARIOS', 'This client has no scenarios yet');
    const runId = await evalsRepo.createRun(deps.db, clientId, scenarios.length);
    return { scenarios, runId };
  }

  async function execute(
    clientId: string,
    prepared: Awaited<ReturnType<typeof prepare>>,
    onResult?: (r: Omit<EvalResultView, 'id'>) => void,
  ): Promise<void> {
    const { scenarios, runId } = prepared;
    let passed = 0;
    try {
      await resetMock();
      for (const s of scenarios) {
        const result = await runScenario({ chat: deps.chat, llm: deps.llm, clientId }, s);
        if (result.passed) passed++;
        await evalsRepo.addResult(deps.db, runId, result);
        onResult?.(result);
      }
      await evalsRepo.finishRun(deps.db, runId, passed, 'done');
    } catch (err) {
      deps.logger.error({ err: err instanceof Error ? err.message : String(err) }, 'eval run failed');
      await evalsRepo.finishRun(deps.db, runId, passed, 'error');
    } finally {
      active.delete(clientId);
    }
  }

  return {
    async start(clientId) {
      const existing = active.get(clientId);
      if (existing) return existing;
      const prepared = await prepare(clientId);
      active.set(clientId, prepared.runId);
      void execute(clientId, prepared);
      return prepared.runId;
    },
    async run(clientId, onResult) {
      const prepared = await prepare(clientId);
      active.set(clientId, prepared.runId);
      await execute(clientId, prepared, onResult);
      return (await evalsRepo.getRun(deps.db, prepared.runId))!;
    },
    get: (id) => evalsRepo.getRun(deps.db, id),
    list: (clientId) => evalsRepo.listRuns(deps.db, clientId),
  };
}
