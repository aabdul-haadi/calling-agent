import type { ParsedClientConfig } from '@adk/shared';
import type { ClientRegistry } from '../clients';
import type { TurnObservation } from '../agent/service';
import type { Db } from '../database/client';
import { DEFAULT_RETRIEVAL, NO_POLICY_REPLY, retrievalFor, type EmbeddingProvider, type Searcher } from '../knowledge';
import type { LlmClient } from '../llm';
import type { Logger } from '../logger';
import { REASON_TEXT } from '../handoff/triggers';
import { similarity } from './analyze';
import { createMlWorkflows, type MlOptions } from './ml-service';
import type { KnowledgeService } from '../knowledge';
import { REPO_ROOT } from '../config/repo-root';
import { resolve as resolvePath } from 'node:path';
import { createLearningCapture, normalize, type LearningCapture, type TurnInput } from './capture';
import { checkExample, createSftDataset, renderDataset, type DatasetReport } from './dataset';
import {
  DEFAULT_GRID_LEXICAL,
  DEFAULT_GRID_RERANK,
  evaluateBehaviorRelease,
  evaluateIntentModel,
  evaluateRetrievalRelease,
  liveBehaviorCheck,
  rankCases,
  splitRanked,
  tuneRetrieval,
  type RankedCase,
} from './evaluate';
import { EVAL_SETS, type RetrievalCase } from './evalsets';
import { findGaps, type GapReport } from './gaps';
import { predict, train, type IntentModel, type Labelled } from './intent-model';
import { leftovers, namesFrom, redact } from './redact';
import {
  createRegistry,
  createRuntime,
  ReleaseError,
  type BehaviorConfig,
  type Channel,
  type Envelope,
  type Evaluation,
  type LearningRuntime,
  type Registry,
  type RetrievalOverride,
} from './registry';
import { createLearningStore, type LearningStore, type ReleaseKind, type ReleaseRow, type TurnRow } from './store';

export interface LearningConfig {
  enabled: boolean;
  retentionDays: number;
  minSftExamples: number;
  minIntentExamples: number;
}

export interface LearningDeps {
  db: Db;
  logger: Logger;
  registry: ClientRegistry;
  config: LearningConfig;
  searcher?: Searcher | undefined;
  embeddings?: EmbeddingProvider | undefined;
  llm?: LlmClient | undefined;
  knowledge?: KnowledgeService | undefined;
  /** Where learning artifacts (runs, proposals) are kept. */
  dataDir?: string | undefined;
  ml?: Partial<MlOptions> | undefined;
  /** Test hooks: replace the trainer command or the local model client. */
  trainingOverride?: Record<string, unknown> | undefined;
  localOverride?: unknown;
}

export class ReviewError extends Error {
  constructor(
    public readonly code: 'NOT_FOUND' | 'INVALID',
    message: string,
  ) {
    super(message);
  }
}

export interface ReviewInput {
  decision: 'approve' | 'reject' | 'exclude';
  reviewer: string;
  note?: string | undefined;
  /** The answer the reviewer says is right. Defaults to the human reply, then the AI reply. */
  approvedReply?: string | undefined;
  uses?: ('sft' | 'retrieval_eval' | 'behavior' | 'intent')[] | undefined;
  /** For retrieval_eval: the document that must answer this question (omit for "no document should"). */
  expectedSource?: string | null | undefined;
  /** For intent: the correct intent label. */
  intent?: string | undefined;
}

export interface CycleReport {
  clientId: string;
  trigger: string;
  gaps: GapReport;
  expired: number;
  pendingReview: number;
  dataset?: { version: number; examples: number; ready: boolean; threshold: number };
  intentModel?: { trainedOn: number; accuracy: number; passed: boolean; releaseVersion: number };
  retrieval?: { proposed: boolean; releaseVersion?: number; passed?: boolean; note: string };
  behavior?: { proposed: boolean; releaseVersion?: number; openers: string[] };
  skipped: string[];
}

export function createLearningService(deps: LearningDeps) {
  const { logger, registry: clients, config } = deps;
  const store: LearningStore = createLearningStore(deps.db);
  const capture: LearningCapture = createLearningCapture({ store, logger, enabled: config.enabled });
  const releases: Registry = createRegistry(store, logger);
  const runtime: LearningRuntime = createRuntime(releases, store);
  const workflows = createMlWorkflows({
    db: deps.db,
    logger,
    registry: clients,
    store,
    releases,
    runtime,
    llm: deps.llm,
    searcher: deps.searcher,
    knowledge: deps.knowledge,
    root: REPO_ROOT,
    dataDir: deps.dataDir ?? resolvePath(REPO_ROOT, 'data'),
    options: { localModelUrl: 'http://127.0.0.1:8790', route: false, minEval: 30, p95Ms: 8000, minShadow: 20, ...deps.ml },
    ...(deps.trainingOverride ? { training: deps.trainingOverride } : {}),
    ...(deps.localOverride ? { local: deps.localOverride as never } : {}),
  });
  const shadow = new Map<string, { n: number; agree: number; confidentN: number; confidentAgree: number }>();
  let cycleRunning = false;

  const module = (clientId: string) => {
    const m = clients.get(clientId);
    if (!m) throw new ReviewError('NOT_FOUND', `Unknown client "${clientId}"`);
    return m;
  };

  // ---- capture ---------------------------------------------------------------------------------

  function toInput(o: TurnObservation): TurnInput | undefined {
    if (o.cancelled || !o.reply.trim()) return undefined;
    const intentEvent = o.trace.find((t) => t.type === 'intent');
    const c = (intentEvent?.detail ?? {}) as { intent?: string; sentiment?: string; isPolicyQuestion?: boolean };
    const noPolicy = o.trace.some((t) => t.type === 'knowledge' && /found nothing relevant/i.test(t.label));
    return {
      clientId: o.clientId,
      conversationId: o.conversationId,
      turnIndex: o.turnIndex,
      channel: o.channel,
      customerText: o.userMessage,
      aiReply: o.reply,
      intent: c.intent ?? 'unknown',
      sentiment: c.sentiment ?? 'neutral',
      citations: o.citations.map((x) => ({ source: x.source, page: x.page, weak: x.weak })),
      asksPolicy: c.isPolicyQuestion === true,
      abstained: o.reply.trim() === NO_POLICY_REPLY || noPolicy,
      toolCalls: o.toolCalls,
      handoffReason: o.handoffReason ? ((Object.entries(REASON_TEXT).find(([, text]) => text === o.handoffReason)?.[0]) ?? o.handoffReason) : undefined,
      lowConfidence: o.lowConfidence,
      latencyMs: o.totalMs,
      phase: o.phase,
      knownNames: namesFrom(o.collected),
    };
  }

  /** Hand a finished turn to the learning pipeline. Returns at once; the work is queued. */
  function observe(o: TurnObservation): void {
    const input = toInput(o);
    if (!input) return;
    capture.record(input);
    void shadowCompare(input);
    workflows.observeShadow(input);
  }

  async function shadowCompare(input: TurnInput): Promise<void> {
    try {
      const model = await runtime.shadowIntent(input.clientId, input.channel);
      if (!model) return;
      const p = predict(model, redact(input.customerText, input.knownNames).text);
      const key = `${input.clientId}|${input.channel}`;
      const s = shadow.get(key) ?? { n: 0, agree: 0, confidentN: 0, confidentAgree: 0 };
      s.n++;
      if (p.intent === input.intent) s.agree++;
      if (p.confidence >= 0.8) {
        s.confidentN++;
        if (p.intent === input.intent) s.confidentAgree++;
      }
      shadow.set(key, s);
    } catch {
      // shadow mode is observation only
    }
  }

  // ---- review ----------------------------------------------------------------------------------

  async function review(clientId: string, id: string, input: ReviewInput): Promise<TurnRow> {
    const turn = await store.getTurn(clientId, id);
    if (!turn) throw new ReviewError('NOT_FOUND', 'Example not found for this company');
    if (!input.reviewer.trim()) throw new ReviewError('INVALID', 'A reviewer name is required');
    if (input.decision !== 'approve') {
      const status = input.decision === 'reject' ? 'rejected' : 'excluded';
      return (await store.updateTurn(clientId, id, {
        reviewStatus: status,
        reviewer: input.reviewer,
        reviewNote: input.note ?? null,
        uses: [],
      }))!;
    }
    const uses = [...new Set(input.uses ?? ['sft'])];
    const reply = (input.approvedReply ?? turn.humanReply ?? turn.aiReply).trim();
    // A reviewer's edit is redacted again and must come out clean: a pasted phone number is caught here.
    const cleaned = redact(reply, []).text;
    const dirty = leftovers(cleaned);
    if (dirty.length > 0) throw new ReviewError('INVALID', `The approved reply still contains ${dirty.join(', ')}`);
    if (uses.includes('sft') && !cleaned) throw new ReviewError('INVALID', 'An example for fine-tuning needs an approved reply');
    const provenance = {
      ...(turn.provenance as Record<string, unknown>),
      ...(input.expectedSource !== undefined ? { expectedSource: input.expectedSource } : {}),
      ...(input.intent ? { reviewedIntent: input.intent } : {}),
      reviewedAt: new Date().toISOString(),
    };
    if (uses.includes('retrieval_eval') && input.expectedSource === undefined)
      throw new ReviewError('INVALID', 'A retrieval example needs the document that should answer it, or null if none should');
    const updated = await store.updateTurn(clientId, id, {
      reviewStatus: 'approved',
      reviewer: input.reviewer,
      reviewNote: input.note ?? null,
      approvedReply: cleaned,
      uses,
      provenance,
      ...(input.intent ? { intent: input.intent } : {}),
    });
    return updated!;
  }

  // ---- datasets --------------------------------------------------------------------------------

  async function buildDataset(clientId: string, channel?: 'voice' | 'chat'): Promise<DatasetReport> {
    module(clientId);
    return createSftDataset(store, clientId, { minExamples: config.minSftExamples, ...(channel ? { channel } : {}) });
  }

  // ---- intent model ----------------------------------------------------------------------------

  async function liveIntentData(clientId: string): Promise<{ train: Labelled[]; heldOut: Labelled[] }> {
    const rows = (await store.listTurns(clientId, { status: 'approved', limit: 5000 })).filter((t) => (t.uses as string[]).includes('intent'));
    const asCase = (t: TurnRow): Labelled => ({ say: t.customerText, intent: t.intent });
    return { train: rows.filter((t) => t.split === 'train').map(asCase), heldOut: rows.filter((t) => t.split === 'eval').map(asCase) };
  }

  async function trainIntentModel(clientId: string, by: string): Promise<{ release: ReleaseRow; model: IntentModel }> {
    module(clientId);
    const set = EVAL_SETS[clientId];
    const live = await liveIntentData(clientId);
    // Seeds first, then reviewed live examples that are not held out. Held-out material is never trained on.
    const model = train([...(set?.seed ?? []), ...live.train]);
    const evaluation = evaluateIntentModel(model, clientId, live.heldOut);
    const release = await releases.propose(clientId, 'intent_model', 'both', model, {
      note: `naive Bayes on ${model.trainedOn} examples (${live.train.length} from reviewed conversations)`,
      createdBy: by,
    });
    await releases.attachEvaluation(clientId, release.id, evaluation);
    const final = evaluation.passed ? await releases.startShadow(clientId, release.id) : release;
    return { release: (await store.getRelease(clientId, final.id))!, model };
  }

  // ---- retrieval -------------------------------------------------------------------------------

  async function retrievalCases(clientId: string): Promise<RetrievalCase[]> {
    const approved = (await store.listTurns(clientId, { status: 'approved', limit: 2000 })).filter(
      (t) => (t.uses as string[]).includes('retrieval_eval') && t.split === 'eval',
    );
    const live: RetrievalCase[] = approved.map((t) => ({
      q: t.customerText,
      source: ((t.provenance as { expectedSource?: string | null }).expectedSource ?? null) as string | null,
      channel: t.channel as 'voice' | 'chat',
    }));
    return [...(EVAL_SETS[clientId]?.retrieval ?? []), ...live];
  }

  async function rankedFor(clientId: string): Promise<RankedCase[]> {
    if (!deps.searcher) throw new ReviewError('INVALID', 'The knowledge search is not available');
    return rankCases(deps.searcher, clientId, await retrievalCases(clientId));
  }

  async function proposeRetrieval(clientId: string, by: string): Promise<{ release?: ReleaseRow; note: string }> {
    module(clientId);
    if (!deps.searcher) return { note: 'The knowledge search is not available.' };
    const ranked = await rankedFor(clientId);
    const base = deps.searcher.config;
    const grid = deps.embeddings && retrievalFor(deps.embeddings) !== DEFAULT_RETRIEVAL && deps.embeddings.profile !== 'semantic' ? DEFAULT_GRID_LEXICAL : DEFAULT_GRID_RERANK;
    const halves = splitRanked(ranked);
    const tuned = tuneRetrieval(halves.tune, deps.searcher.config, grid);
    if (!tuned) return { note: 'No tried setting was better than the current one on every measure, so nothing was proposed.' };
    const foreign = new Set(
      Object.entries(EVAL_SETS)
        .filter(([id]) => id !== clientId)
        .flatMap(([, s]) => s.retrieval.map((r) => r.source))
        .filter((s): s is string => !!s),
    );
    // judged only on the questions it was not tuned on
    const evaluation = evaluateRetrievalRelease(halves.validate, base, tuned.override, foreign);
    const release = await releases.propose(clientId, 'retrieval', 'both', tuned.override, {
      note: `tuned on ${halves.tune.length} questions, judged on ${halves.validate.length} others`,
      createdBy: by,
    });
    await releases.attachEvaluation(clientId, release.id, evaluation);
    return { release: (await store.getRelease(clientId, release.id))!, note: evaluation.passed ? 'Proposed and passed every gate.' : 'Proposed but failed a gate.' };
  }

  // ---- behaviour -------------------------------------------------------------------------------

  /** Openers the agent keeps using that reviewers' data flags as stock phrases. */
  async function frequentOpeners(clientId: string, min = 2): Promise<string[]> {
    const rows = (await store.listTurns(clientId, { flag: 'robotic_opener', limit: 1000 })).filter((t) => t.aiReply);
    const counts = new Map<string, number>();
    for (const t of rows) {
      const opener = t.aiReply.split(/[.!?\n]/)[0]!.trim().split(/\s+/).slice(0, 6).join(' ');
      if (opener.length >= 3) counts.set(opener, (counts.get(opener) ?? 0) + 1);
    }
    return [...counts.entries()].filter(([, n]) => n >= min).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([o]) => o);
  }

  async function proposeBehavior(
    clientId: string,
    channel: Channel,
    by: string,
    input: { styleLines?: string[]; avoidOpeners?: string[]; rollout?: number; evaluateLive?: boolean },
  ): Promise<ReleaseRow> {
    const m = module(clientId);
    const config2: BehaviorConfig = {
      styleLines: input.styleLines ?? [],
      avoidOpeners: input.avoidOpeners ?? (await frequentOpeners(clientId)),
    };
    const release = await releases.propose(clientId, 'behavior', channel, config2, {
      note: 'behaviour lessons',
      createdBy: by,
      ...(input.rollout !== undefined ? { rollout: input.rollout } : {}),
    });
    let live: Parameters<typeof evaluateBehaviorRelease>[3];
    if (input.evaluateLive !== false && deps.llm) {
      const questions = (EVAL_SETS[clientId]?.heldOut ?? []).filter((c) => channel === 'both' || c.channel === channel).map((c) => c.say).slice(0, 10);
      const ch: 'voice' | 'chat' = channel === 'chat' ? 'chat' : 'voice';
      live = {
        baseline: await liveBehaviorCheck(deps.llm, m.config as ParsedClientConfig, ch, undefined, questions),
        candidate: await liveBehaviorCheck(deps.llm, m.config as ParsedClientConfig, ch, config2, questions),
      };
    }
    const evaluation = evaluateBehaviorRelease(config2, channel === 'chat' ? 'chat' : 'voice', m.config as ParsedClientConfig, live);
    await releases.attachEvaluation(clientId, release.id, evaluation);
    return (await store.getRelease(clientId, release.id))!;
  }

  // ---- the cycle -------------------------------------------------------------------------------

  async function job<T>(clientId: string | null, kind: string, trigger: string, run: () => Promise<T>): Promise<T> {
    const id = await store.startJob(clientId, kind, trigger);
    try {
      const result = await run();
      await store.finishJob(id, 'done', result);
      return result;
    } catch (err) {
      await store.finishJob(id, 'failed', {}, String(err));
      logger.error({ err: String(err), kind, clientId }, 'learning job failed');
      throw err;
    }
  }

  /**
   * One pass of the whole lifecycle for one company. Cheap steps always run; anything expensive or
   * consequential is gated by thresholds, and nothing is ever deployed from here: a person does that.
   */
  async function runCycle(clientId: string, trigger = 'manual'): Promise<CycleReport> {
    module(clientId);
    return job(clientId, 'cycle', trigger, async () => {
      await capture.drain();
      const report: CycleReport = {
        clientId,
        trigger,
        gaps: { groups: 0, recurring: 0 },
        expired: 0,
        pendingReview: 0,
        skipped: [],
      };
      report.expired = await store.expire(clientId, new Date(Date.now() - config.retentionDays * 86_400_000));
      report.gaps = await findGaps(store, deps.searcher, clientId);
      const counts = await store.countsByStatus(clientId);
      report.pendingReview = counts['pending'] ?? 0;

      const approvedSft = (await store.listTurns(clientId, { status: 'approved', limit: 5000 })).filter((t) => (t.uses as string[]).includes('sft') && !checkExample(t)).length;
      if (approvedSft >= config.minSftExamples) {
        const d = await buildDataset(clientId);
        report.dataset = { version: d.dataset.version, examples: (d.dataset.stats as { examples: number }).examples, ready: d.meetsThreshold, threshold: d.threshold };
      } else {
        report.skipped.push(`dataset: ${approvedSft} approved examples, needs ${config.minSftExamples}`);
      }

      const live = await liveIntentData(clientId);
      if (live.train.length >= config.minIntentExamples) {
        const { release } = await trainIntentModel(clientId, `cycle:${trigger}`);
        const ev = release.evaluation as Evaluation;
        report.intentModel = { trainedOn: (release.params as Envelope<IntentModel>).config.trainedOn, accuracy: (ev.metrics as { accuracy: number }).accuracy, passed: ev.passed, releaseVersion: release.version };
      } else {
        report.skipped.push(`intent model: ${live.train.length} approved intent examples, needs ${config.minIntentExamples}`);
      }

      const openers = await frequentOpeners(clientId);
      if (openers.length > 0) {
        report.behavior = { proposed: false, openers };
        report.skipped.push('behaviour: stock openers found; propose a behaviour release to evaluate them with the live model');
      }
      return report;
    });
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  function startSchedule(minutes: number): void {
    if (timer || minutes <= 0) return;
    timer = setInterval(() => {
      if (cycleRunning) return;
      cycleRunning = true;
      void (async () => {
        try {
          for (const s of clients.summaries()) await runCycle(s.id, 'schedule').catch(() => undefined);
        } finally {
          cycleRunning = false;
        }
      })();
    }, minutes * 60_000);
    timer.unref?.();
  }

  async function overview(clientId: string) {
    module(clientId);
    const [counts, gaps, datasets, rels, jobs, flagged] = await Promise.all([
      store.countsByStatus(clientId),
      store.listGaps(clientId),
      store.listDatasets(clientId),
      store.listReleases(clientId),
      store.listJobs(clientId, 20),
      store.listTurns(clientId, { limit: 1000 }),
    ]);
    const flagCounts: Record<string, number> = {};
    for (const t of flagged) for (const f of t.flags as string[]) flagCounts[f] = (flagCounts[f] ?? 0) + 1;
    const byChannel: Record<string, number> = {};
    for (const t of flagged) byChannel[t.channel] = (byChannel[t.channel] ?? 0) + 1;
    const sh = Object.fromEntries([...shadow.entries()].filter(([k]) => k.startsWith(`${clientId}|`)).map(([k, v]) => [k.split('|')[1]!, { ...v, agreement: v.n ? v.agree / v.n : 0 }]));
    return {
      review: counts,
      capture: capture.stats(),
      byChannel,
      flags: flagCounts,
      openGaps: gaps.filter((g) => g.status === 'open').length,
      datasets: datasets.length,
      releases: rels.map((r) => ({ id: r.id, kind: r.kind, channel: r.channel, version: r.version, status: r.status })),
      jobs: jobs.slice(0, 5).map((j) => ({ kind: j.kind, status: j.status, startedAt: j.startedAt })),
      shadow: sh,
      thresholds: { minSftExamples: config.minSftExamples, minIntentExamples: config.minIntentExamples, retentionDays: config.retentionDays },
    };
  }

  return {
    store,
    capture,
    releases,
    runtime,
    workflows,
    observe,
    review,
    buildDataset,
    renderDataset: async (clientId: string, datasetId: string) => {
      const d = await store.getDataset(clientId, datasetId);
      if (!d) throw new ReviewError('NOT_FOUND', 'Dataset not found');
      return renderDataset(store, clientId, d);
    },
    trainIntentModel,
    proposeRetrieval,
    proposeBehavior,
    evaluateRelease: async (clientId: string, id: string): Promise<ReleaseRow> => {
      const r = await store.getRelease(clientId, id);
      if (!r) throw new ReleaseError('NOT_FOUND', 'Release not found');
      const env = r.params as Envelope<unknown>;
      let ev: Evaluation;
      if (r.kind === 'retrieval') {
        if (!deps.searcher) throw new ReviewError('INVALID', 'The knowledge search is not available');
        const foreign = new Set(Object.entries(EVAL_SETS).filter(([cid]) => cid !== clientId).flatMap(([, s]) => s.retrieval.map((x) => x.source)).filter((s): s is string => !!s));
        ev = evaluateRetrievalRelease(splitRanked(await rankedFor(clientId)).validate, deps.searcher.config, env.config as RetrievalOverride, foreign);
      } else if (r.kind === 'intent_model') {
        ev = evaluateIntentModel(env.config as IntentModel, clientId, (await liveIntentData(clientId)).heldOut);
      } else {
        const m = module(clientId);
        ev = evaluateBehaviorRelease(env.config as BehaviorConfig, r.channel === 'chat' ? 'chat' : 'voice', m.config as ParsedClientConfig, undefined);
      }
      return releases.attachEvaluation(clientId, id, ev);
    },
    deploy: (clientId: string, id: string, by: string) => job(clientId, 'deploy', by, () => releases.deploy(clientId, id, by)),
    rollback: (clientId: string, kind: ReleaseKind, channel: Channel, by: string) => job(clientId, 'rollback', by, () => releases.rollback(clientId, kind, channel, by)),
    runCycle,
    startSchedule,
    overview,
    purgeConversation: (clientId: string, conversationId: string) => store.purgeConversation(clientId, conversationId),
    normalize,
    similarity,
  };
}

export type LearningService = ReturnType<typeof createLearningService>;
