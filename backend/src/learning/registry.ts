import { createHash } from 'node:crypto';
import type { RetrievalConfig } from '../knowledge';
import type { Logger } from '../logger';
import type { IntentModel } from './intent-model';
import type { LearningStore, ReleaseKind, ReleaseRow } from './store';

// Versioned releases of the things learning is allowed to change, with the evidence for each, a
// staged path to live traffic and a way back. Live traffic only ever reads `active` releases.

export type Channel = 'voice' | 'chat' | 'both';

/** What a release carries. `rollout` is the share of conversations (0-100) that get a behaviour release. */
export interface Envelope<T> {
  rollout: number;
  config: T;
}

export interface BehaviorConfig {
  /** Short style lessons added to the reply instructions. */
  styleLines: string[];
  /** Opening phrases the agent must not start a reply with. */
  avoidOpeners: string[];
}

export type RetrievalOverride = Partial<
  Pick<
    RetrievalConfig,
    'minRerank' | 'softRerank' | 'softSimilarity' | 'softKeyword' | 'minSimilarity' | 'minOverlap' | 'maxResults' | 'weakResults'
  >
>;

export interface Gate {
  name: string;
  pass: boolean;
  detail: string;
}
export interface Evaluation {
  passed: boolean;
  gates: Gate[];
  metrics: Record<string, unknown>;
  baseline?: Record<string, unknown>;
  evaluatedAt: string;
}

// ---- validation: what a release is allowed to say --------------------------------------------

const FORBIDDEN =
  /\b(?:ignore|skip|bypass|disable|override|forget|without)\b[^.]{0,60}\b(?:verif\w*|confirm\w*|approval|identity|rules?|polic(?:y|ies)|safety|instructions?|handoff|hand over|tools?|sources?|citations?)\b|\bsystem prompt\b|https?:\/\/|\bsk-[a-z0-9]{10,}/i;
const BEHAVIOR_LIMITS = { lines: 8, lineChars: 200, openers: 12, openerChars: 60 };

export function validateBehavior(c: BehaviorConfig): string[] {
  const problems: string[] = [];
  if (!Array.isArray(c.styleLines) || !Array.isArray(c.avoidOpeners)) return ['malformed behaviour config'];
  if (c.styleLines.length > BEHAVIOR_LIMITS.lines) problems.push(`more than ${BEHAVIOR_LIMITS.lines} style lines`);
  if (c.avoidOpeners.length > BEHAVIOR_LIMITS.openers) problems.push(`more than ${BEHAVIOR_LIMITS.openers} avoided openers`);
  for (const l of c.styleLines) {
    if (typeof l !== 'string' || l.length === 0 || l.length > BEHAVIOR_LIMITS.lineChars)
      problems.push(`a style line is empty or over ${BEHAVIOR_LIMITS.lineChars} characters`);
    else if (FORBIDDEN.test(l)) problems.push(`style line touches a protected rule: "${l.slice(0, 50)}"`);
  }
  for (const o of c.avoidOpeners) {
    if (typeof o !== 'string' || o.length === 0 || o.length > BEHAVIOR_LIMITS.openerChars)
      problems.push('an avoided opener is empty or too long');
    else if (/[\n\r]/.test(o)) problems.push('an avoided opener has line breaks');
  }
  return problems;
}

const RETRIEVAL_RANGES: Record<keyof RetrievalOverride, [number, number]> = {
  minRerank: [-10, 3],
  softRerank: [-14, 0],
  softSimilarity: [0.3, 0.95],
  softKeyword: [0, 0.9],
  minSimilarity: [0.05, 0.95],
  minOverlap: [0.05, 0.95],
  maxResults: [1, 8],
  weakResults: [0, 3],
};

export function validateRetrieval(o: RetrievalOverride): string[] {
  const problems: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    const range = RETRIEVAL_RANGES[k as keyof RetrievalOverride];
    if (!range) problems.push(`"${k}" is not a setting a release may change`);
    else if (typeof v !== 'number' || Number.isNaN(v) || v < range[0] || v > range[1])
      problems.push(`${k} must be between ${range[0]} and ${range[1]}`);
  }
  return problems;
}

export const inRollout = (conversationId: string, percent: number): boolean =>
  percent >= 100 ||
  (percent > 0 && parseInt(createHash('sha256').update(conversationId).digest('hex').slice(0, 6), 16) % 100 < percent);

// ---- registry --------------------------------------------------------------------------------

export class ReleaseError extends Error {
  constructor(
    public readonly code: 'NOT_FOUND' | 'NOT_EVALUATED' | 'GATES_FAILED' | 'INVALID' | 'NOT_WIRED' | 'NOTHING_TO_ROLL_BACK',
    message: string,
  ) {
    super(message);
  }
}

export interface Registry {
  propose<T>(
    clientId: string,
    kind: ReleaseKind,
    channel: Channel,
    config: T,
    meta: { datasetId?: string | null; note?: string; createdBy: string; rollout?: number },
  ): Promise<ReleaseRow>;
  attachEvaluation(clientId: string, id: string, evaluation: Evaluation): Promise<ReleaseRow>;
  startShadow(clientId: string, id: string): Promise<ReleaseRow>;
  deploy(clientId: string, id: string, by: string): Promise<ReleaseRow>;
  reject(clientId: string, id: string, by: string, note?: string): Promise<ReleaseRow>;
  rollback(clientId: string, kind: ReleaseKind, channel: Channel, by: string): Promise<{ from: ReleaseRow; to?: ReleaseRow }>;
  /** Live reads. Cached briefly; changed at once on deploy and rollback. */
  active<T>(clientId: string, kind: ReleaseKind, channel: 'voice' | 'chat'): Promise<Envelope<T> | undefined>;
  invalidate(): void;
}

export function createRegistry(store: LearningStore, logger: Logger, opts: { cacheMs?: number } = {}): Registry {
  const ttl = opts.cacheMs ?? 15_000;
  const cache = new Map<string, { at: number; value: Envelope<unknown> | undefined }>();

  const must = async (clientId: string, id: string): Promise<ReleaseRow> => {
    const r = await store.getRelease(clientId, id);
    if (!r) throw new ReleaseError('NOT_FOUND', 'Release not found');
    return r;
  };

  return {
    invalidate: () => cache.clear(),

    async propose(clientId, kind, channel, config, meta) {
      const problems =
        kind === 'behavior'
          ? validateBehavior(config as BehaviorConfig)
          : kind === 'retrieval'
            ? validateRetrieval(config as RetrievalOverride)
            : [];
      if (problems.length > 0) throw new ReleaseError('INVALID', problems.join('; '));
      if (kind === 'retrieval' && channel !== 'both')
        throw new ReleaseError('INVALID', 'Search settings are shared by voice and chat');
      const rollout = Math.max(0, Math.min(100, Math.round(meta.rollout ?? 100)));
      const version = await store.nextReleaseVersion(clientId, kind, channel);
      return store.insertRelease({
        clientId,
        kind,
        channel,
        version,
        datasetId: meta.datasetId ?? null,
        params: { rollout, config } satisfies Envelope<unknown>,
        status: 'candidate',
        note: meta.note ?? null,
        createdBy: meta.createdBy,
      });
    },

    async attachEvaluation(clientId, id, evaluation) {
      const r = await must(clientId, id);
      const updated = await store.setReleaseStatus(clientId, r.id, {
        evaluation,
        ...(evaluation.passed ? {} : r.status === 'candidate' ? {} : {}),
      });
      return updated!;
    },

    async startShadow(clientId, id) {
      const r = await must(clientId, id);
      if (r.status !== 'candidate') throw new ReleaseError('INVALID', `A ${r.status} release cannot start shadow mode`);
      return (await store.setReleaseStatus(clientId, r.id, { status: 'shadow' }))!;
    },

    async deploy(clientId, id, by) {
      const r = await must(clientId, id);
      if (r.kind === 'intent_model')
        throw new ReleaseError(
          'NOT_WIRED',
          'The local intent model runs in shadow mode only. Nothing in the live reply path uses it, so there is nothing to deploy.',
        );
      if (!['candidate', 'shadow'].includes(r.status))
        throw new ReleaseError('INVALID', `A ${r.status} release cannot be deployed`);
      const ev = r.evaluation as Partial<Evaluation>;
      if (!ev || ev.passed === undefined) throw new ReleaseError('NOT_EVALUATED', 'Evaluate this release before deploying it');
      if (!ev.passed) {
        const failed = (ev.gates ?? []).filter((g) => !g.pass).map((g) => g.name);
        throw new ReleaseError('GATES_FAILED', `Not deployed: failed ${failed.join(', ') || 'a quality gate'}`);
      }
      const current = await store.activeRelease(clientId, r.kind as ReleaseKind, r.channel === 'both' ? 'chat' : (r.channel as 'voice' | 'chat'));
      // A release replaces the one active for the same kind and exactly the same channel scope.
      const replaced = current && current.channel === r.channel ? current : undefined;
      if (replaced) await store.setReleaseStatus(clientId, replaced.id, { status: 'superseded' });
      const live = await store.setReleaseStatus(clientId, r.id, {
        status: 'active',
        deployedAt: new Date(),
        rollbackTo: replaced?.id ?? null,
        note: `${r.note ?? ''}${r.note ? ' | ' : ''}deployed by ${by}`,
      });
      cache.clear();
      logger.info({ clientId, kind: r.kind, channel: r.channel, version: r.version, by }, 'release deployed');
      return live!;
    },

    async reject(clientId, id, by, note) {
      const r = await must(clientId, id);
      if (r.status === 'active') throw new ReleaseError('INVALID', 'Roll an active release back instead of rejecting it');
      return (await store.setReleaseStatus(clientId, r.id, {
        status: 'rejected',
        note: `${note ?? 'rejected'} (by ${by})`,
      }))!;
    },

    async rollback(clientId, kind, channel, by) {
      const rows = (await store.listReleases(clientId)).filter(
        (r) => r.kind === kind && r.channel === channel && r.status === 'active',
      );
      const from = rows[0];
      if (!from) throw new ReleaseError('NOTHING_TO_ROLL_BACK', 'No active release to roll back');
      await store.setReleaseStatus(clientId, from.id, { status: 'rolled_back', note: `${from.note ?? ''} | rolled back by ${by}` });
      let to: ReleaseRow | undefined;
      if (from.rollbackTo) {
        to = await store.setReleaseStatus(clientId, from.rollbackTo, { status: 'active', deployedAt: new Date() });
      }
      cache.clear();
      logger.info({ clientId, kind, channel, from: from.version, to: to?.version ?? 'built-in defaults', by }, 'release rolled back');
      return { from, ...(to ? { to } : {}) };
    },

    async active<T>(clientId: string, kind: ReleaseKind, channel: 'voice' | 'chat') {
      const key = `${clientId}|${kind}|${channel}`;
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < ttl) return hit.value as Envelope<T> | undefined;
      let value: Envelope<unknown> | undefined;
      try {
        const row = await store.activeRelease(clientId, kind, channel);
        value = row ? (row.params as Envelope<unknown>) : undefined;
      } catch (err) {
        // Learning must never break a live call: no release means built-in behaviour.
        logger.error({ err: String(err) }, 'could not read the active release');
      }
      cache.set(key, { at: Date.now(), value });
      return value as Envelope<T> | undefined;
    },
  };
}

// ---- what live traffic reads -----------------------------------------------------------------

export interface LearningRuntime {
  /** Extra reply instructions for this conversation, from the active behaviour release (if it covers it). */
  behaviorLines(clientId: string, channel: 'voice' | 'chat', conversationId: string): Promise<string[]>;
  /** Search settings to use for this tenant instead of the built-in ones. */
  retrievalOverride(clientId: string): Promise<RetrievalOverride | undefined>;
  /** The intent model in shadow mode, if any. */
  shadowIntent(clientId: string, channel: 'voice' | 'chat'): Promise<IntentModel | undefined>;
}

export function createRuntime(registry: Registry, store: LearningStore): LearningRuntime {
  return {
    async behaviorLines(clientId, channel, conversationId) {
      const e = await registry.active<BehaviorConfig>(clientId, 'behavior', channel);
      if (!e || !inRollout(conversationId, e.rollout)) return [];
      const problems = validateBehavior(e.config);
      if (problems.length > 0) return []; // re-checked on every read: a bad row can never reach a prompt
      return [
        ...e.config.styleLines,
        ...(e.config.avoidOpeners.length > 0
          ? [`Never start a reply with: ${e.config.avoidOpeners.map((o) => `"${o}"`).join(', ')}.`]
          : []),
      ];
    },
    async retrievalOverride(clientId) {
      const e = await registry.active<RetrievalOverride>(clientId, 'retrieval', 'chat');
      if (!e || validateRetrieval(e.config).length > 0) return undefined;
      return e.config;
    },
    async shadowIntent(clientId, channel) {
      const row = await store.activeRelease(clientId, 'intent_model', channel, 'shadow');
      return row ? ((row.params as Envelope<IntentModel>).config) : undefined;
    },
  };
}
