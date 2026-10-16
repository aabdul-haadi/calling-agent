import type { ClientRegistry } from '../clients';
import type { Db } from '../database/client';
import type { KnowledgeService, Searcher } from '../knowledge';
import type { LlmClient } from '../llm';
import { createLocalLlm, type LocalLlm } from '../llm/local';
import type { Logger } from '../logger';
import type { TurnInput } from './capture';
import { buildEvalSet, evalSetJsonl, renderDataset } from './dataset';
import { createKnowledgeChange } from './knowledge-change';
import { f1, compareModels, runModel, DEFAULT_LIMITS, type ModelCase } from './model-eval';
import { createMlStore } from './ml-store';
import { redact } from './redact';
import { createTraining, type TrainingConfig } from './training';
import type { Evaluation, LearningRuntime, Registry } from './registry';
import type { LearningStore, ReleaseRow } from './store';

export class ModelReleaseError extends Error {
  constructor(
    public readonly code: 'NOT_FOUND' | 'INVALID' | 'SERVER_MISMATCH' | 'NOT_EVALUATED' | 'GATES_FAILED' | 'NOT_ENOUGH_SHADOW' | 'LOCAL_MODEL_DOWN',
    message: string,
  ) {
    super(message);
  }
}

export interface MlOptions {
  localModelUrl: string;
  route: boolean;
  minEval: number;
  p95Ms: number;
  minShadow: number;
}

export interface MlDeps {
  db: Db;
  logger: Logger;
  registry: ClientRegistry;
  store: LearningStore;
  releases: Registry;
  runtime: LearningRuntime;
  llm?: LlmClient | undefined;
  searcher?: Searcher | undefined;
  knowledge?: KnowledgeService | undefined;
  root: string;
  dataDir: string;
  options: MlOptions;
  /** Test hooks. */
  local?: LocalLlm;
  training?: Partial<Parameters<typeof createTraining>[0]>;
}

interface AdapterParams {
  rollout: number;
  config: { base: string; adapterDir: string; adapterSha256: string; runId: string; datasetId: string };
}

const SYSTEM: Record<'voice' | 'chat', string> = {
  voice: 'You are a support agent on a phone call. Your words are spoken aloud: short sentences, contractions, no lists or formatting, one question at a time.',
  chat: 'You are a support agent in a chat. Answer clearly and directly. Cite the document when you state a policy.',
};

export function createMlWorkflows(d: MlDeps) {
  const ml = createMlStore(d.db);
  const local = d.local ?? createLocalLlm({ url: d.options.localModelUrl, timeoutMs: 60_000 });
  const routeLocal = createLocalLlm({ url: d.options.localModelUrl, timeoutMs: 8000 });

  const training = createTraining({
    store: d.store,
    ml,
    releases: d.releases,
    logger: d.logger,
    root: d.root,
    dataDir: d.dataDir,
    exportDataset: async (clientId, datasetId) => {
      const ds = await d.store.getDataset(clientId, datasetId);
      if (!ds) return undefined;
      return {
        train: await renderDataset(d.store, clientId, ds),
        evalSet: evalSetJsonl(await buildEvalSet(d.store, clientId)),
        minExamples: (ds.stats as { minExamples: number }).minExamples,
      };
    },
    ...d.training,
  });

  const knowledgeChange =
    d.knowledge && d.searcher
      ? createKnowledgeChange({
          db: d.db,
          logger: d.logger,
          registry: d.registry,
          store: d.store,
          ml,
          releases: d.releases,
          knowledge: d.knowledge,
          searcher: d.searcher,
          dataDir: d.dataDir,
        })
      : undefined;

  const adapter = async (clientId: string, releaseId: string): Promise<{ row: ReleaseRow; cfg: AdapterParams['config'] }> => {
    const row = await d.store.getRelease(clientId, releaseId);
    if (!row || row.kind !== 'llm_adapter') throw new ModelReleaseError('NOT_FOUND', 'Model candidate not found');
    return { row, cfg: (row.params as AdapterParams).config };
  };

  /** The server must be serving exactly the artifact the release records, or the numbers would describe a different model. */
  async function checkServer(cfg: AdapterParams['config']): Promise<void> {
    const h = await local.health();
    if (!h.ok) throw new ModelReleaseError('LOCAL_MODEL_DOWN', `The local model server is not running at ${d.options.localModelUrl}. Start it with ml/serve_local.py --adapter <adapter folder>.`);
    if (h.adapterSha256 !== cfg.adapterSha256)
      throw new ModelReleaseError('SERVER_MISMATCH', 'The local model server is serving a different adapter than this candidate. Restart it with this candidate\'s adapter folder.');
  }

  // ---- offline comparison with production --------------------------------------------------------

  async function evaluateModel(clientId: string, releaseId: string, opts: { latencyApproved?: boolean } = {}): Promise<ReleaseRow> {
    const { row, cfg } = await adapter(clientId, releaseId);
    if (!d.llm) throw new ModelReleaseError('INVALID', 'The production model is not configured, so there is nothing to compare with');
    await checkServer(cfg);
    const examples = await buildEvalSet(d.store, clientId);
    const cases: ModelCase[] = examples.map((e) => ({
      id: e.id,
      channel: e.channel,
      system: e.messages[0]!.content,
      messages: e.messages.slice(1) as ModelCase['messages'],
      reference: e.reference,
    }));
    const probeSystem = SYSTEM.voice;
    const candidate = await runModel(local, cases, probeSystem);
    const baseline = await runModel(d.llm, cases, probeSystem);
    const evaluation = compareModels(
      candidate,
      baseline,
      { ...DEFAULT_LIMITS, minCases: d.options.minEval, p95Ms: d.options.p95Ms },
      opts,
    );
    return d.releases.attachEvaluation(clientId, row.id, evaluation);
  }

  // ---- shadow mode ----------------------------------------------------------------------------

  async function startShadow(clientId: string, releaseId: string): Promise<ReleaseRow> {
    const { row, cfg } = await adapter(clientId, releaseId);
    await checkServer(cfg);
    return d.releases.startShadow(clientId, row.id);
  }

  const queue: (() => Promise<void>)[] = [];
  let draining = false;
  const MAX_QUEUE = 20;

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      for (let job = queue.shift(); job; job = queue.shift()) await job().catch(() => undefined);
    } finally {
      draining = false;
    }
  }

  /**
   * Asks the shadow candidate the same question the customer asked and records what it would have
   * said. It runs after the real reply was sent, on a queue of one, with no tools and no database
   * access other than writing its own redacted output.
   */
  function observeShadow(input: TurnInput): void {
    void (async () => {
      const rel = await d.store.activeRelease(input.clientId, 'llm_adapter', input.channel, 'shadow').catch(() => undefined);
      if (!rel) return;
      if (queue.length >= MAX_QUEUE) queue.shift(); // a busy CPU drops the oldest rather than falling behind
      queue.push(async () => {
        const history = (await d.store.turnsOfConversation(input.clientId, input.conversationId))
          .filter((h) => h.turnIndex < input.turnIndex)
          .slice(-3)
          .flatMap((h) => [
            { role: 'user' as const, content: h.customerText },
            { role: 'assistant' as const, content: h.approvedReply?.trim() || h.aiReply },
          ]);
        const customer = redact(input.customerText, input.knownNames).text;
        const production = redact(input.aiReply, input.knownNames).text;
        const t0 = performance.now();
        const r = await local.complete({
          system: SYSTEM[input.channel],
          messages: [...history, { role: 'user', content: customer }],
          maxTokens: 200,
        });
        const ms = Math.round(performance.now() - t0);
        const reply = r.ok ? redact(r.data.text, input.knownNames).text : null;
        await ml.insertShadow({
          clientId: input.clientId,
          releaseId: rel.id,
          conversationId: input.conversationId,
          turnIndex: input.turnIndex,
          channel: input.channel,
          customerText: customer,
          productionReply: production,
          candidateReply: reply,
          similarity: reply ? Math.round(f1(reply, production) * 100) : null,
          candidateMs: ms,
          error: r.ok ? null : r.message.slice(0, 200),
        });
      });
      void drain();
    })().catch(() => undefined);
  }

  // ---- promotion ------------------------------------------------------------------------------

  /**
   * A candidate may phrase tool-free policy answers only after: it passed the offline comparison (not
   * merely "inconclusive"), it ran in shadow mode on enough real traffic without failing, the server
   * serves exactly this artifact, and a person said yes. Live use also needs LOCAL_MODEL_ROUTE=on.
   */
  async function promoteModel(clientId: string, releaseId: string, by: string): Promise<ReleaseRow> {
    const { row, cfg } = await adapter(clientId, releaseId);
    const ev = row.evaluation as Partial<Evaluation>;
    if (ev.passed === undefined) throw new ModelReleaseError('NOT_EVALUATED', 'Compare the candidate with production first');
    if (!ev.passed) {
      const why = ev.inconclusive ? 'the comparison was inconclusive' : `failed ${(ev.gates ?? []).filter((g) => !g.pass).map((g) => g.name).join(', ')}`;
      throw new ModelReleaseError('GATES_FAILED', `Not promoted: ${why}`);
    }
    if (row.status !== 'shadow') throw new ModelReleaseError('INVALID', 'Run the candidate in shadow mode before promoting it');
    const stats = await ml.shadowStats(clientId, row.id);
    if (stats.n < d.options.minShadow)
      throw new ModelReleaseError('NOT_ENOUGH_SHADOW', `Only ${stats.n} shadow answers so far; ${d.options.minShadow} are needed.`);
    if (stats.failed / stats.n > 0.05) throw new ModelReleaseError('GATES_FAILED', `Not promoted: ${stats.failed} of ${stats.n} shadow answers failed`);
    await checkServer(cfg);
    return d.releases.deploy(clientId, row.id, by);
  }

  // The live hook: the engine asks; the engine also validates whatever comes back.
  d.runtime.routesLocally = async (clientId, channel) =>
    d.options.route && (await d.releases.active(clientId, 'llm_adapter', channel)) !== undefined;
  d.runtime.localAnswer = async (args) => {
    if (!d.options.route) return undefined;
    const rel = await d.store.activeRelease(args.clientId, 'llm_adapter', args.channel).catch(() => undefined);
    if (!rel) return undefined;
    const r = await (d.local ?? routeLocal).complete({ system: args.system, messages: args.messages, maxTokens: 160 });
    return r.ok ? r.data.text : undefined;
  };

  return {
    ml,
    training,
    knowledgeChange,
    local,
    hardware: training.hardware,
    evaluateModel,
    startShadow,
    observeShadow,
    promoteModel,
    shadowReport: async (clientId: string, releaseId: string) => ({
      stats: await ml.shadowStats(clientId, releaseId),
      recent: await ml.listShadow(clientId, releaseId, 20),
    }),
  };
}

export type MlWorkflows = ReturnType<typeof createMlWorkflows>;
export type { TrainingConfig };
