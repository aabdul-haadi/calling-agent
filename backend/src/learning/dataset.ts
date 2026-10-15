import { normalize, sha } from './capture';
import { wordCount } from './analyze';
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
}

const originOf = (t: TurnRow): SftExample['meta']['origin'] => {
  const approved = (t.approvedReply ?? '').trim();
  if (approved && approved === t.aiReply.trim()) return 'ai';
  if (approved && t.humanReply && approved === t.humanReply.trim()) return 'human';
  return 'edited';
};

/** Automatic checks on top of the human approval. A reviewer's yes does not waive them. */
export function checkExample(t: TurnRow): string | undefined {
  const reply = (t.approvedReply ?? '').trim();
  if (!reply) return 'no approved reply';
  if (t.split !== 'train') return 'held out for evaluation';
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
  const approved = (await store.listTurns(clientId, { status: 'approved', limit: 5000 })).filter(
    (t) => (t.uses as string[]).includes('sft') && (!channel || t.channel === channel),
  );
  const rejected: Rejection[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  const examples: SftExample[] = [];
  for (const t of [...approved].sort((a, b) => a.id.localeCompare(b.id))) {
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
    const history = (await store.turnsOfConversation(clientId, t.conversationId))
      .filter((h) => h.turnIndex < t.turnIndex)
      .slice(-3)
      .flatMap((h) => [
        { role: 'user' as const, content: h.customerText },
        { role: 'assistant' as const, content: h.approvedReply?.trim() || h.aiReply },
      ]);
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
  return { examples, rejected, duplicates };
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
