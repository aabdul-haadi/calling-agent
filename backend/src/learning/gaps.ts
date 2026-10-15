import type { Searcher } from '../knowledge';
import type { LearningStore, TurnRow } from './store';

// Finds topics customers keep asking about that the knowledge base cannot answer, and says what to
// do about each. It never writes policy: a human answer is shown as an unverified lead, and the
// recommended fix is always an approved document or a correction to one.

const STOP = new Set(
  (
    'a an and are as at be but by can could do does for from get got had has have how i if in into is it its me my of on or our so ' +
    'that the their them then there these they this to up us was we were what when where which who why will with would you your ' +
    'flight policy please hi hello hey thanks thank ok okay yes no not just about want need like tell know ask asking question'
  ).split(' '),
);

/** Content words of a question, lightly stemmed so "refunds" and "refund" group together. */
export function topicWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\[[a-z_]+\]/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map((w) => w.replace(/(ing|ed|es|s)$/, ''))
    .filter((w) => w.length > 2);
}

export interface Cluster {
  key: string;
  label: string;
  turns: TurnRow[];
}

/** Greedy grouping by shared content words. Deterministic for a given input order. */
export function clusterQuestions(turns: TurnRow[], threshold = 0.33): Cluster[] {
  const groups: { words: Set<string>; turns: TurnRow[] }[] = [];
  const ordered = [...turns].sort((a, b) => a.customerText.localeCompare(b.customerText));
  for (const t of ordered) {
    const words = new Set(topicWords(t.customerText));
    if (words.size === 0) continue;
    const home = groups.find((g) => {
      let shared = 0;
      for (const w of words) if (g.words.has(w)) shared++;
      // Share of the smaller question's topic words that the group already has.
      return shared >= 1 && shared / Math.min(words.size, g.words.size) >= threshold;
    });
    if (home) {
      home.turns.push(t);
      for (const w of words) home.words.add(w);
    } else groups.push({ words, turns: [t] });
  }
  return groups.map((g) => {
    const freq = new Map<string, number>();
    for (const t of g.turns) for (const w of new Set(topicWords(t.customerText))) freq.set(w, (freq.get(w) ?? 0) + 1);
    const top = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([w]) => w);
    const key = [...top].sort().join('-') || 'other';
    return { key, label: top.join(', ') || 'other', turns: g.turns };
  });
}

export interface GapReport {
  groups: number;
  recurring: number;
}

/** Re-reads the unanswered policy questions of one tenant and refreshes its gap list. */
export async function findGaps(
  store: LearningStore,
  searcher: Searcher | undefined,
  clientId: string,
  opts: { minOccurrences?: number } = {},
): Promise<GapReport> {
  const min = opts.minOccurrences ?? 2;
  const turns = (await store.listTurns(clientId, { limit: 2000 })).filter((t) =>
    (t.flags as string[]).includes('unanswered'),
  );
  const clusters = clusterQuestions(turns);
  let recurring = 0;
  for (const c of clusters) {
    if (c.turns.length < min) continue;
    recurring++;
    const examples = [...new Set(c.turns.map((t) => t.customerText))].slice(0, 5);
    const channels = [...new Set(c.turns.map((t) => t.channel))];
    const humanAnswers = c.turns.map((t) => t.humanReply).filter((x): x is string => !!x).slice(0, 3);
    let nearest: { source: string; heading: string; page?: number } | undefined;
    let recommendation: string;
    if (searcher) {
      try {
        const found = await searcher.search(clientId, examples[0]!);
        const closest = found.closest;
        if (closest) {
          nearest = {
            source: closest.source,
            heading: closest.heading,
            ...(closest.page ? { page: closest.page } : {}),
          };
        }
      } catch {
        // the suggestion is a convenience; the gap itself is already known
      }
    }
    if (nearest) {
      recommendation = `The closest approved text is "${nearest.heading}" in ${nearest.source}${nearest.page ? ` (page ${nearest.page})` : ''}. If it should cover this, a reviewer can add the missing rule to that document and upload a new version; otherwise upload the document that defines this policy.`;
    } else {
      recommendation = 'No related document was found. Upload the approved document that defines this policy.';
    }
    await store.upsertGap({
      clientId,
      topicKey: c.key,
      label: c.label,
      examples,
      occurrences: c.turns.length,
      channels,
      suggestion: {
        nearest: nearest ?? null,
        recommendation,
        // Shown to the reviewer as a lead only. It is not policy until an approved document says so.
        unverifiedHumanAnswers: humanAnswers,
      },
    });
  }
  return { groups: clusters.length, recurring };
}
