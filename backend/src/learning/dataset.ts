import { normalize, sha } from './capture';
import { similarity, wordCount } from './analyze';
import { leftovers } from './redact';
import type { DatasetRow, LearningStore, TurnRow } from './store';

// Turns reviewed conversations into frozen, versioned datasets. A dataset only contains examples a
// reviewer approved, that passed automatic checks, and that sit on the training side of the fixed
// train/eval split. The evaluation side never enters a training file.

export interface SftExample {
  id: string;
  channel: 'voice' | 'chat';
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  meta: { intent: string; sources: string[]; resolution: string; origin: 'ai' | 'human' | 'edited' };
}

const SYSTEM: Record<'voice' | 'chat', string> = {
  voice:
    'You are a support agent on a phone call. Your words are spoken aloud: short sentences, contractions, no lists or formatting, one question at a time.',
  chat: 'You are a support agent in a chat. Answer clearly and directly. Cite the document when you state a policy.',
};

export interface Rejection {
  id: string;
  reason: string;
}

export interface BuildResult {
  examples: SftExample[];
  rejected: Rejection[];
  duplicates: number;
  splitOverlapExcluded: number;
}

type Split = 'train' | 'eval';
const SPLIT_OVERLAP_THRESHOLD = 0.85;

function conversationSplits(rows: TurnRow[]): Map<string, Split> {
  const ordered = [...rows].sort(
    (a, b) => a.conversationId.localeCompare(b.conversationId) || a.turnIndex - b.turnIndex,
  );
  const splits = new Map<string, Split>();
  for (const row of ordered) {
    if (!splits.has(row.conversationId)) splits.set(row.conversationId, row.split as Split);
  }
  return splits;
}

function turnsByConversation(rows: TurnRow[]): Map<string, TurnRow[]> {
  const grouped = new Map<string, TurnRow[]>();
  for (const row of rows) {
    const turns = grouped.get(row.conversationId) ?? [];
    turns.push(row);
    grouped.set(row.conversationId, turns);
  }
  return grouped;
}

function splitOverlapIds(rows: TurnRow[], splits: ReadonlyMap<string, Split>): Set<string> {
  const train = rows.filter((t) => splits.get(t.conversationId) === 'train');
  const evalRows = rows.filter((t) => splits.get(t.conversationId) === 'eval');
  const overlapping = new Set<string>();
  const text = new Map(rows.map((t) => [t.id, normalize(t.customerText)]));
  for (const a of train) {
    const aText = text.get(a.id)!;
    if (!aText) continue;
    for (const b of evalRows) {
      const bText = text.get(b.id)!;
      if (bText && similarity(aText, bText) >= SPLIT_OVERLAP_THRESHOLD) {
        overlapping.add(a.id);
        overlapping.add(b.id);
      }
    }
  }
  return overlapping;
}

export function partitionReviewedTurns(
  rows: TurnRow[],
  use: 'sft' | 'intent',
): {
  train: TurnRow[];
  evaluation: TurnRow[];
  trainOverlaps: TurnRow[];
  overlapIds: Set<string>;
  conversationSides: Map<string, Split>;
} {
  const conversationSides = conversationSplits(rows);
  const approved = rows.filter(
    (t) => t.reviewStatus === 'approved' && (t.uses as string[]).includes(use),
  );
  const overlapIds = splitOverlapIds(approved, conversationSides);
  return {
    train: approved.filter(
      (t) =>
        conversationSides.get(t.conversationId) === 'train' &&
        t.split === 'train' &&
        !overlapIds.has(t.id),
    ),
    evaluation: approved.filter(
      (t) =>
        conversationSides.get(t.conversationId) === 'eval' &&
        t.split === 'eval' &&
        !overlapIds.has(t.id),
    ),
    trainOverlaps: approved.filter(
      (t) =>
        conversationSides.get(t.conversationId) === 'train' &&
        t.split === 'train' &&
        overlapIds.has(t.id),
    ),
    overlapIds,
    conversationSides,
  };
}

function approvedHistory(
  turns: ReadonlyMap<string, TurnRow[]>,
  target: TurnRow,
  split: Split,
  splits: ReadonlyMap<string, Split>,
  overlaps: ReadonlySet<string>,
): { role: 'user' | 'assistant'; content: string }[] {
  return (turns.get(target.conversationId) ?? [])
    .filter(
      (h) =>
        h.turnIndex < target.turnIndex &&
        h.split === split &&
        splits.get(h.conversationId) === split &&
        h.reviewStatus === 'approved' &&
        (h.uses as string[]).includes('sft') &&
        !!h.approvedReply &&
        !overlaps.has(h.id) &&
        !checkExample(h, { expectedSplit: split }),
    )
    .sort((a, b) => a.turnIndex - b.turnIndex)
    .slice(-3)
    .flatMap((h) => [
      { role: 'user' as const, content: h.customerText },
      { role: 'assistant' as const, content: h.approvedReply!.trim() },
    ]);
}

const originOf = (t: TurnRow): SftExample['meta']['origin'] => {
  const approved = (t.approvedReply ?? '').trim();
  if (approved && approved === t.aiReply.trim()) return 'ai';
  if (approved && t.humanReply && approved === t.humanReply.trim()) return 'human';
  return 'edited';
};

/** Automatic checks on top of the human approval. A reviewer's yes does not waive them. */
export function checkExample(t: TurnRow, opts: { expectedSplit?: Split } = {}): string | undefined {
  const reply = (t.approvedReply ?? '').trim();
  if (!reply) return 'no approved reply';
  const expectedSplit = opts.expectedSplit ?? 'train';
  if (t.split !== expectedSplit)
    return expectedSplit === 'eval' ? 'not on the evaluation side' : 'held out for evaluation';
  const dirty = [...leftovers(t.customerText), ...leftovers(reply)];
  if (dirty.length > 0) return `contains ${[...new Set(dirty)].join(', ')}`;
  if (t.channel === 'voice') {
    if (wordCount(reply) > 70) return 'too long for a spoken answer';
    if (/(^|\n)\s*(?:[-*•]|\d+[.)])\s|\*\*|\[Source:|https?:\/\//.test(reply)) return 'formatting in a spoken answer';
  }
  if (reply.length < 3) return 'reply too short';
  // A learned reply must never talk the model out of a safety step.
  if (/\b(?:skip|no need for|without|bypass)\b[^.]{0,30}\b(?:verif\w+|confirm\w*|identity|approval)\b/i.test(reply))
    return 'tells the customer a safety step can be skipped';
  return undefined;
}

export async function buildSft(store: LearningStore, clientId: string, channel?: 'voice' | 'chat'): Promise<BuildResult> {
  const rows = await store.listTurns(clientId, { limit: 5000 });
  const partition = partitionReviewedTurns(rows, 'sft');
  const splits = partition.conversationSides;
  const turns = turnsByConversation(rows);
  const overlaps = partition.overlapIds;
  const approved = [...partition.train, ...partition.trainOverlaps].filter(
    (t) => !channel || t.channel === channel,
  );
  const rejected: Rejection[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  let splitOverlapExcluded = 0;
  const examples: SftExample[] = [];
  for (const t of [...approved].sort((a, b) => a.id.localeCompare(b.id))) {
    if (overlaps.has(t.id)) {
      splitOverlapExcluded++;
      rejected.push({ id: t.id, reason: 'near-duplicate across train/evaluation split' });
      continue;
    }
    const why = checkExample(t);
    if (why) {
      rejected.push({ id: t.id, reason: why });
      continue;
    }
    const key = sha(`${t.channel}|${normalize(t.customerText)}|${normalize(t.approvedReply!)}`);
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    const history = approvedHistory(turns, t, 'train', splits, overlaps);
    examples.push({
      id: t.id,
      channel: t.channel as 'voice' | 'chat',
      messages: [
        { role: 'system', content: SYSTEM[t.channel as 'voice' | 'chat'] },
        ...history,
        { role: 'user', content: t.customerText },
        { role: 'assistant', content: t.approvedReply!.trim() },
      ],
      meta: {
        intent: t.intent,
        sources: (t.sources as { source: string }[]).map((s) => s.source),
        resolution: t.resolution,
        origin: originOf(t),
      },
    });
  }
  return { examples, rejected, duplicates, splitOverlapExcluded };
}

export const toJsonl = (examples: SftExample[]): string =>
  examples.map((e) => JSON.stringify({ messages: e.messages, metadata: { id: e.id, channel: e.channel, ...e.meta } })).join('\n');

export interface DatasetReport {
  dataset: DatasetRow;
  meetsThreshold: boolean;
  threshold: number;
  rejected: Rejection[];
}

/** Freezes the current approved training examples as a new dataset version. */
export async function createSftDataset(
  store: LearningStore,
  clientId: string,
  opts: { minExamples: number; channel?: 'voice' | 'chat' },
): Promise<DatasetReport> {
  const built = await buildSft(store, clientId, opts.channel);
  const kind = opts.channel ? `sft_${opts.channel}` : 'sft';
  const version = await store.nextDatasetVersion(clientId, kind);
  const byChannel = { voice: 0, chat: 0 };
  for (const e of built.examples) byChannel[e.channel]++;
  const dataset = await store.insertDataset({
    clientId,
    version,
    kind,
    exampleIds: built.examples.map((e) => e.id),
    stats: {
      examples: built.examples.length,
      byChannel,
      duplicatesRemoved: built.duplicates,
      rejectedByChecks: built.rejected.length,
      splitOverlapExcluded: built.splitOverlapExcluded,
      rejectionReasons: built.rejected.reduce<Record<string, number>>((m, r) => {
        m[r.reason] = (m[r.reason] ?? 0) + 1;
        return m;
      }, {}),
      minExamples: opts.minExamples,
    },
    sha256: sha(toJsonl(built.examples)),
  });
  return {
    dataset,
    meetsThreshold: built.examples.length >= opts.minExamples,
    threshold: opts.minExamples,
    rejected: built.rejected,
  };
}

/** Rebuilds the exact file of a dataset version from the examples it froze. */
export async function renderDataset(store: LearningStore, clientId: string, dataset: DatasetRow): Promise<string> {
  const ids = new Set(dataset.exampleIds as string[]);
  const built = await buildSft(store, clientId, dataset.kind === 'sft_voice' ? 'voice' : dataset.kind === 'sft_chat' ? 'chat' : undefined);
  return toJsonl(built.examples.filter((e) => ids.has(e.id)));
}

export interface EvalExample {
  id: string;
  channel: 'voice' | 'chat';
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  reference: string;
}

/** Held-out, reviewed examples: the questions a candidate model is judged on and never trained on. */
export async function buildEvalSet(store: LearningStore, clientId: string): Promise<EvalExample[]> {
  const allRows = await store.listTurns(clientId, { limit: 5000 });
  const partition = partitionReviewedTurns(allRows, 'sft');
  const splits = partition.conversationSides;
  const turns = turnsByConversation(allRows);
  const overlaps = partition.overlapIds;
  const rows = partition.evaluation.filter((t) => !checkExample(t, { expectedSplit: 'eval' }));
  const out: EvalExample[] = [];
  for (const t of [...rows].sort((a, b) => a.id.localeCompare(b.id))) {
    const history = approvedHistory(turns, t, 'eval', splits, overlaps);
    out.push({
      id: t.id,
      channel: t.channel as 'voice' | 'chat',
      messages: [
        { role: 'system', content: SYSTEM[t.channel as 'voice' | 'chat'] },
        ...history,
        { role: 'user', content: t.customerText },
      ],
      reference: t.approvedReply!.trim(),
    });
  }
  return out;
}

export const evalSetJsonl = (examples: EvalExample[]): string =>
  examples.map((e) => JSON.stringify({ messages: [...e.messages, { role: 'assistant', content: e.reference }], metadata: { id: e.id, channel: e.channel } })).join(String.fromCharCode(10));
