import { createHash } from 'node:crypto';
import type { Logger } from '../logger';
import { flagsFor, resolutionFor, type Resolution } from './analyze';
import { hasSecret, redact } from './redact';
import type { LearningStore } from './store';

/** What the chat service knows about one finished turn. Raw: redaction happens in here, off the live path. */
export interface TurnInput {
  clientId: string;
  conversationId: string;
  turnIndex: number;
  channel: 'voice' | 'chat';
  customerText: string;
  aiReply: string;
  intent: string;
  sentiment: string;
  citations: { source: string; page?: number | undefined; weak?: boolean | undefined }[];
  asksPolicy: boolean;
  abstained: boolean;
  toolCalls: { tool: string; status: string; latencyMs?: number }[];
  handoffReason?: string | undefined;
  lowConfidence: boolean;
  latencyMs?: number | undefined;
  phase: string;
  /** Personal words known from this conversation's tool results, removed from every text. */
  knownNames: string[];
}

/** 20% of distinct customer questions are held out for evaluation; the same text always lands on the same side. */
export const EVAL_SHARE = 5; // 1 in 5
export const normalize = (s: string): string =>
  s
    .toLowerCase()
    .replace(/\[[a-z_]+\]/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
export const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
export const splitFor = (customerText: string): 'train' | 'eval' =>
  parseInt(sha(normalize(customerText)).slice(0, 8), 16) % EVAL_SHARE === 0 ? 'eval' : 'train';

export interface CaptureStats {
  queued: number;
  stored: number;
  duplicates: number;
  excluded: number;
  failed: number;
}

export interface LearningCapture {
  /** Returns at once. The work happens later, so a live call or chat never waits for it. */
  record(input: TurnInput): void;
  recordHumanReply(clientId: string, conversationId: string, text: string, names?: string[]): Promise<void>;
  recordResolution(
    clientId: string,
    conversationId: string,
    phase: string,
    handoff?: 'pending' | 'accepted' | 'resolved',
  ): Promise<Resolution>;
  recordFeedback(
    clientId: string,
    conversationId: string,
    f: { rating?: number | undefined; correction?: string | undefined; names?: string[] | undefined },
  ): Promise<boolean>;
  /** Waits until everything queued so far is stored (tests, shutdown). */
  drain(): Promise<void>;
  stats(): CaptureStats;
  /** Process one input synchronously. Exposed for tests and for retries. */
  process(input: TurnInput): Promise<'stored' | 'duplicate' | 'excluded'>;
}

export function createLearningCapture(opts: {
  store: LearningStore;
  logger: Logger;
  enabled?: boolean;
  retryDelayMs?: number;
}): LearningCapture {
  const { store, logger } = opts;
  const enabled = opts.enabled !== false;
  const retryDelay = opts.retryDelayMs ?? 500;
  const stats: CaptureStats = { queued: 0, stored: 0, duplicates: 0, excluded: 0, failed: 0 };
  let tail: Promise<void> = Promise.resolve();

  async function process(input: TurnInput): Promise<'stored' | 'duplicate' | 'excluded'> {
    // A turn that carries a password, code or card number is never learned from, redacted or not.
    if (hasSecret(input.customerText) || hasSecret(input.aiReply)) return 'excluded';
    const names = input.knownNames;
    const customer = redact(input.customerText, names);
    const reply = redact(input.aiReply, names);
    const previous = (await store.turnsOfConversation(input.clientId, input.conversationId)).filter(
      (t) => t.turnIndex < input.turnIndex,
    );
    const last = previous[previous.length - 1];
    const flags = flagsFor({
      channel: input.channel,
      customerText: customer.text,
      aiReply: reply.text,
      ...(last ? { previousAiReply: last.aiReply, previousCustomerText: last.customerText } : {}),
      asksPolicy: input.asksPolicy,
      abstained: input.abstained,
      ...(input.handoffReason ? { handoffReason: input.handoffReason } : {}),
      lowConfidence: input.lowConfidence,
      toolStatuses: input.toolCalls.map((t) => t.status),
    });
    const dedupeHash = sha(
      `${input.clientId}|${input.conversationId}|${input.turnIndex}|${customer.text}`,
    );
    const inserted = await store.insertTurn({
      clientId: input.clientId,
      conversationId: input.conversationId,
      turnIndex: input.turnIndex,
      channel: input.channel,
      intent: input.intent,
      sentiment: input.sentiment,
      customerText: customer.text,
      aiReply: reply.text,
      sources: input.citations.map((c) => ({ source: c.source, page: c.page ?? null, weak: !!c.weak })),
      asksPolicy: input.asksPolicy,
      abstained: input.abstained,
      toolOutcomes: input.toolCalls.map((t) => ({ tool: t.tool, status: t.status })),
      handoffReason: input.handoffReason ?? null,
      lowConfidence: input.lowConfidence,
      latencyMs: input.latencyMs ?? null,
      resolution: resolutionFor(input.phase),
      flags,
      provenance: {
        source: 'live_turn',
        redactions: { customer: customer.found, reply: reply.found },
        capturedAt: new Date().toISOString(),
      },
      dedupeHash,
      split: splitFor(customer.text),
    });
    return inserted ? 'stored' : 'duplicate';
  }

  async function withRetry(input: TurnInput): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const out = await process(input);
        if (out === 'stored') stats.stored++;
        else if (out === 'duplicate') stats.duplicates++;
        else stats.excluded++;
        return;
      } catch (err) {
        if (attempt === 3) {
          stats.failed++;
          logger.error({ err: String(err), conversationId: input.conversationId }, 'learning capture failed');
          return;
        }
        await new Promise((r) => setTimeout(r, retryDelay * attempt));
      }
    }
  }

  return {
    record(input) {
      if (!enabled) return;
      stats.queued++;
      tail = tail.then(() => withRetry(input));
    },
    process,
    async recordHumanReply(clientId, conversationId, text, names = []) {
      if (!enabled || hasSecret(text)) return;
      await store.attachHumanReply(clientId, conversationId, redact(text, names).text);
    },
    async recordResolution(clientId, conversationId, phase, handoff) {
      const resolution = resolutionFor(phase, handoff);
      if (enabled) await store.setConversationResolution(clientId, conversationId, resolution);
      return resolution;
    },
    async recordFeedback(clientId, conversationId, f) {
      if (!enabled) return false;
      const turns = await store.turnsOfConversation(clientId, conversationId);
      const target = turns[turns.length - 1];
      if (!target) return false;
      const correction = f.correction && !hasSecret(f.correction) ? redact(f.correction, f.names ?? []).text : null;
      await store.updateTurn(clientId, target.id, {
        ...(f.rating !== undefined ? { rating: Math.max(1, Math.min(5, Math.round(f.rating))) } : {}),
        ...(correction ? { correction } : {}),
      });
      return true;
    },
    async drain() {
      await tail;
    },
    stats: () => ({ ...stats }),
  };
}
