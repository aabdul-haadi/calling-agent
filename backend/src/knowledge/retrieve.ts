import type { Citation, KnowledgeSearchResult } from '@adk/shared';
import type { Db } from '../database';
import { knowledgeRepo } from '../database';
import type { SearchHit } from '../database/repositories/knowledge';
import type { Logger } from '../logger';
import type { EmbeddingProvider } from './embeddings';
import type { Reranker } from './rerank';
import { stripInstructions } from './safety';
import { expandSearchQuery, tokenize } from './text';
import type { RetrievalContext, Retriever } from './types';

/** How the search decides what counts as evidence. Values were chosen with `pnpm rag:eval`. */
export interface RetrievalConfig {
  /** Candidates taken from each of the two searches. */
  candidates: number;
  /** At most this many passages are given to the agent. */
  maxResults: number;
  /** Total characters of passages given to the agent (keeps the prompt small and fast). */
  maxContextChars: number;
  /** A passage needs at least this similarity by meaning ... */
  minSimilarity: number;
  /** ... and at least this share of the question's words, or a strong keyword match. */
  minOverlap: number;
  /** Two passages sharing this share of their word groups are duplicates. */
  duplicateOverlap: number;
  /** How many fused candidates the reranker reads. */
  rerankTop: number;
  /** With a reranker, a passage must score at least this to count as evidence (chosen from the score spread of answerable and unanswerable test questions). */
  minRerank: number;
  /** Below this relevance score, topical similarity needs stronger lexical support. */
  marginalRerankFloor: number;
  /** Required query-term coverage when a reranker match is marginal. */
  marginalMinOverlap: number;
  /**
   * A customer's own words often share little with the document ("my cash back" for "refund"), and
   * the relevance model then scores the right passage low. Between the strict bar and these limits a
   * passage is a WEAK match: it is handed to the model marked as weak, with the instruction to use it
   * only if it clearly answers the question and otherwise say it cannot confirm. Weak evidence is
   * admitted only when reviewed query expansion or conversation context supplies a direct search path.
   */
  softRerank: number;
  softSimilarity: number;
  softKeyword: number;
  /** Weak matches given to the model at most. */
  weakResults: number;
}

export const DEFAULT_RETRIEVAL: RetrievalConfig = {
  candidates: 20,
  maxResults: 5,
  maxContextChars: 3200,
  minSimilarity: 0.55,
  minOverlap: 0.34,
  duplicateOverlap: 0.6,
  rerankTop: Number(process.env.RAG_RERANK_TOP) || 5,
  minRerank: -4.5,
  marginalRerankFloor: -1.5,
  marginalMinOverlap: 0.6,
  softRerank: -9,
  softSimilarity: 0.66,
  softKeyword: 0.2,
  weakResults: 2,
};

/** With the offline word-matching fallback a similarity score says little, so only word overlap decides. */
export const LEXICAL_RETRIEVAL: RetrievalConfig = {
  ...DEFAULT_RETRIEVAL,
  minSimilarity: 0.05,
  minOverlap: 0.34,
};

export const retrievalFor = (e: EmbeddingProvider): RetrievalConfig =>
  e.profile === 'lexical' ? LEXICAL_RETRIEVAL : DEFAULT_RETRIEVAL;

export const TOP_K = DEFAULT_RETRIEVAL.candidates;

/** Words that mean the customer is continuing an earlier question rather than starting a new one. */
const FOLLOW_UP =
  /^(and|also|but|then|so|what about|how about|what if|why|how long|how much|does that|is that|do i|can i|will it|would it)\b/i;

/** Fraction of the question's meaningful words that appear in the passage (prefix match: bag ~ baggage). */
function lexicalOverlap(queryTokens: string[], chunkTokens: Set<string>): number {
  if (queryTokens.length === 0) return 0;
  const hit = queryTokens.filter((q) => {
    for (const c of chunkTokens)
      if (c === q || (q.length >= 3 && c.length >= 3 && (c.startsWith(q) || q.startsWith(c))))
        return true;
    return false;
  });
  return hit.length / queryTokens.length;
}

/** Word groups used to spot near-duplicate passages (overlapping chunks, repeated boilerplate). */
function shingles(text: string): Set<string> {
  const t = tokenize(text);
  const out = new Set<string>();
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3).join(' '));
  return out;
}

/**
 * A short follow-up ("and how long does it take?") has no topic of its own. Join it to the customer's
 * previous question so the search knows what "it" is. Long, self-contained questions are left alone,
 * and the customer's earlier words are only ever used to search: they never become evidence.
 */
export function searchText(question: string, recentQuestions: string[] = []): string {
  const q = question.trim();
  const own = tokenize(q);
  const previous = recentQuestions.filter((m) => tokenize(m).length >= 2).at(-1);
  if (
    !previous &&
    own.length <= 1 &&
    /\b(?:it|that|this|they|them|one|ones|those|these)\b/i.test(q)
  )
    return '';
  if (!previous) return q;
  const isFollowUp = own.length <= 3 || (FOLLOW_UP.test(q) && own.length <= 6);
  return isFollowUp ? `${previous.trim()} ${q}` : q;
}

/** `refund | cancel | airline` for Postgres full-text search: words only, so nothing can be injected. */
export function toTsQuery(text: string): string {
  const words = [...new Set(tokenize(text).filter((w) => /^[a-z0-9]+$/.test(w)))].slice(0, 16);
  return words.join(' | ');
}

export interface Ranked {
  hit: SearchHit;
  similarity: number | undefined;
  keyword: number | undefined;
  overlap: number;
  specificTermCoverage?: number;
  score: number;
  /** Cross-encoder score when a reranker is used. */
  rerank?: number;
  /** Whether a reviewed expansion or available conversation context added search terms. */
  queryExpanded?: boolean;
}

const GENERIC_QUERY_TERMS = new Set(
  'airline airlines flight flights trip baggage carry ticket fare policy guide customer company service support help question item bring hold cabin boarding check allow allowance'.split(
    ' ',
  ),
);

function specificTermCoverage(queryTerms: string[], passageTerms: Set<string>): number | undefined {
  const specific = [...new Set(queryTerms.filter((term) => !GENERIC_QUERY_TERMS.has(term)))];
  if (specific.length === 0) return undefined;
  return specific.filter((term) => passageTerms.has(term)).length / specific.length;
}

/**
 * Merge the two result lists (meaning and words) with reciprocal rank fusion, then score each
 * passage on three independent signals so the decision "is there evidence?" does not hang on one.
 */
export function fuse(
  query: string,
  vector: SearchHit[],
  keyword: SearchHit[],
  queryExpanded = false,
): Ranked[] {
  const q = [...new Set(tokenize(query))];
  const byId = new Map<string, Ranked & { rrf: number }>();
  const maxKw = Math.max(0, ...keyword.map((h) => h.score));
  const add = (hits: SearchHit[], kind: 'vector' | 'keyword') =>
    hits.forEach((hit, rank) => {
      const entry =
        byId.get(hit.id) ??
        ({
          hit,
          similarity: undefined,
          keyword: undefined,
          overlap: 0,
          score: 0,
          queryExpanded,
          rrf: 0,
        } as Ranked & { rrf: number });
      entry.rrf += 1 / (60 + rank);
      if (kind === 'vector') entry.similarity = hit.score;
      else entry.keyword = maxKw > 0 ? hit.score / maxKw : 0;
      byId.set(hit.id, entry);
    });
  add(vector, 'vector');
  add(keyword, 'keyword');
  return [...byId.values()]
    .map((e) => {
      const passageTerms = new Set(tokenize(`${e.hit.heading} ${e.hit.content}`));
      e.overlap = lexicalOverlap(q, passageTerms);
      e.specificTermCoverage = specificTermCoverage(q, passageTerms);
      // Mostly meaning, helped by the words and the fusion rank.
      e.score =
        0.55 * Math.max(0, e.similarity ?? 0) + 0.3 * e.overlap + 0.15 * Math.min(1, e.rrf * 30);
      return e;
    })
    .sort((a, b) => b.score - a.score);
}

export interface Decision {
  /** The best candidate even when it was not good enough (so "why did it refuse?" can be answered). */
  closest?: Ranked;
  passages: Ranked[];
  relevant: boolean;
  /** True when the passages are only weak matches (the model decides whether they answer). */
  weak?: boolean;
  reason: string;
  considered: number;
}

/** Remove duplicates, apply the relevance bar, and fit what is left in the context budget. */
export function decide(ranked: Ranked[], cfg: RetrievalConfig = DEFAULT_RETRIEVAL): Decision {
  const considered = ranked.length;
  if (considered === 0)
    return {
      closest: undefined,
      passages: [],
      relevant: false,
      reason: 'No passage matched the question.',
      considered,
    };

  const kept: Ranked[] = [];
  const seen: Set<string>[] = [];
  for (const r of ranked) {
    const sh = shingles(r.hit.content);
    const dup = seen.some((s) => {
      if (sh.size === 0 || s.size === 0) return false;
      let shared = 0;
      for (const x of sh) if (s.has(x)) shared++;
      return shared / Math.min(sh.size, s.size) >= cfg.duplicateOverlap;
    });
    if (dup) continue;
    seen.push(sh);
    kept.push(r);
  }

  const hasSpecificMatch = (r: Ranked) =>
    r.specificTermCoverage === undefined || r.specificTermCoverage > 0;
  const corroborated = (r: Ranked) =>
    hasSpecificMatch(r) &&
    (r.rerank === undefined ||
      r.rerank >= cfg.marginalRerankFloor ||
      r.overlap >= cfg.marginalMinOverlap ||
      (r.keyword ?? 0) >= 0.5);
  const strong = (r: Ranked) =>
    corroborated(r) &&
    (r.rerank !== undefined
      ? r.rerank >= cfg.minRerank
      : ((r.similarity ?? 0) >= cfg.minSimilarity &&
          (r.overlap >= cfg.minOverlap || (r.keyword ?? 0) >= 0.5)) ||
        r.overlap >= 0.75);
  const plausible = (r: Ranked) =>
    hasSpecificMatch(r) &&
    r.queryExpanded === true &&
    r.rerank !== undefined &&
    r.rerank >= cfg.softRerank &&
    (r.similarity ?? 0) >= cfg.softSimilarity &&
    (r.keyword ?? 0) >= cfg.softKeyword;
  const evidence = kept.filter(strong);
  if (evidence.length === 0) {
    const weak = kept.filter(plausible).slice(0, cfg.weakResults);
    if (weak.length > 0) {
      return {
        closest: weak[0],
        passages: weak,
        relevant: true,
        weak: true,
        reason: `Only weak matches (best relevance ${weak[0]!.rerank!.toFixed(1)}): the model decides whether they answer the question.`,
        considered,
      };
    }
    const best = kept[0]!;
    return {
      closest: best,
      passages: [],
      relevant: false,
      reason:
        best.rerank !== undefined
          ? `The closest passage (${best.hit.source}) does not answer the question (relevance ${best.rerank.toFixed(1)}).`
          : `The closest passage (${best.hit.source}) matched too weakly: similarity ${(best.similarity ?? 0).toFixed(2)}, ${Math.round(best.overlap * 100)}% of the question's words.`,
      considered,
    };
  }
  const passages: Ranked[] = [];
  let chars = 0;
  for (const r of evidence) {
    if (passages.length >= cfg.maxResults) break;
    if (chars + r.hit.content.length > cfg.maxContextChars && passages.length > 0) break;
    passages.push(r);
    chars += r.hit.content.length;
  }
  return {
    closest: passages[0],
    passages,
    relevant: true,
    reason: `${passages.length} passage(s) supported the question.`,
    considered,
  };
}

export function toCitation(r: Ranked, weak = false): Citation {
  const cleaned = stripInstructions(r.hit.content);
  return {
    source: r.hit.source,
    heading: r.hit.heading,
    snippet: cleaned,
    score: Math.round(r.score * 100) / 100,
    ...(weak ? { weak: true } : {}),
    ...(r.hit.documentId ? { documentId: r.hit.documentId } : {}),
    version: r.hit.version,
    ...(r.hit.page ? { page: r.hit.page } : {}),
    ...(r.hit.pageEnd && r.hit.pageEnd !== r.hit.page ? { pageEnd: r.hit.pageEnd } : {}),
    match: {
      ...(r.rerank !== undefined ? { rerank: Math.round(r.rerank * 10) / 10 } : {}),
      ...(r.similarity !== undefined ? { vector: Math.round(r.similarity * 100) / 100 } : {}),
      ...(r.keyword !== undefined ? { keyword: Math.round(r.keyword * 100) / 100 } : {}),
    },
  };
}

/** Everything the search learned about a question before the relevance bar is applied. */
export interface RankedSet {
  searched: string;
  ranked: Ranked[];
  timings: { embedMs: number; vectorMs: number; keywordMs: number; rerankMs: number; totalMs: number };
}

export interface Searcher {
  /** The settings this searcher decides with. */
  config: RetrievalConfig;
  /** Ranks passages without deciding which count as evidence: lets the bar be tried at many values. */
  rank(clientId: string, question: string, ctx?: RetrievalContext): Promise<RankedSet>;
  search(
    clientId: string,
    question: string,
    ctx?: RetrievalContext,
  ): Promise<KnowledgeSearchResult>;
}

export function createSearcher(
  db: Db,
  embeddings: EmbeddingProvider,
  cfg: RetrievalConfig = retrievalFor(embeddings),
  reranker?: Reranker,
): Searcher {
  async function rank(clientId: string, question: string, ctx?: RetrievalContext): Promise<RankedSet> {
    {
      const t0 = performance.now();
      const searched = searchText(question, ctx?.recentQuestions);
      if (!searched) {
        return {
          searched,
          ranked: [],
          timings: {
            embedMs: 0,
            vectorMs: 0,
            keywordMs: 0,
            rerankMs: 0,
            totalMs: Math.round(performance.now() - t0),
          },
        };
      }
      const retrievalQuery = expandSearchQuery(searched);
      const queryExpanded = searched !== question.trim() || retrievalQuery !== searched;
      const tsQuery = toTsQuery(retrievalQuery);

      // The keyword search needs no embedding, so it runs while the question is being embedded.
      const kwStart = performance.now();
      const keywordP = knowledgeRepo
        .searchKeyword(db, clientId, tsQuery, cfg.candidates)
        .then((h) => ({
          hits: h,
          ms: performance.now() - kwStart,
        }));
      const embStart = performance.now();
      const [vector] = await embeddings.embed([retrievalQuery], 'query');
      const embedMs = performance.now() - embStart;
      const vecStart = performance.now();
      const vectorHits = await knowledgeRepo.searchVector(db, clientId, vector!, cfg.candidates);
      const vectorMs = performance.now() - vecStart;
      const keyword = await keywordP;

      let ranked = fuse(retrievalQuery, vectorHits, keyword.hits, queryExpanded);
      let rerankMs = 0;
      if (reranker && ranked.length > 0) {
        const rrStart = performance.now();
        const top = ranked.slice(0, cfg.rerankTop);
        const scores = await reranker.score(
          searched,
          top.map((r) => `${r.hit.heading}\n${r.hit.content}`),
        );
        ranked = top
          .map((r, i) => ({ ...r, rerank: scores[i]! }))
          .sort((a, b) => b.rerank! - a.rerank! || b.score - a.score);
        rerankMs = performance.now() - rrStart;
      }
      return {
        searched,
        ranked,
        timings: {
          embedMs: Math.round(embedMs),
          vectorMs: Math.round(vectorMs),
          keywordMs: Math.round(keyword.ms),
          rerankMs: Math.round(rerankMs),
          totalMs: Math.round(performance.now() - t0),
        },
      };
    }
  }

  return {
    config: cfg,
    rank,
    async search(clientId, question, ctx) {
      const { searched, ranked, timings } = await rank(clientId, question, ctx);
      const decision = decide(ranked, cfg);
      return {
        question,
        searched,
        relevant: decision.relevant,
        reason: decision.reason,
        embedding: embeddings.name,
        passages: decision.passages.map((p) => toCitation(p, decision.weak)),
        ...(decision.closest ? { closest: toCitation(decision.closest, decision.weak) } : {}),
        timings,
        considered: decision.considered,
      };
    },
  };
}

export function createRetriever(
  db: Db,
  embeddings: EmbeddingProvider,
  logger: Logger,
  cfg: RetrievalConfig = retrievalFor(embeddings),
  reranker?: Reranker,
  /** Reviewed search settings for a company (learning system), or undefined for the built-in ones. */
  overrideFor?: (clientId: string) => Promise<Partial<RetrievalConfig> | undefined>,
): Retriever {
  const base = createSearcher(db, embeddings, cfg, reranker);
  const tuned = new Map<string, Searcher>();
  return async (clientId, query, ctx) => {
    try {
      let searcher = base;
      const override = overrideFor ? await overrideFor(clientId).catch(() => undefined) : undefined;
      if (override && Object.keys(override).length > 0) {
        const key = JSON.stringify(override);
        let s = tuned.get(key);
        if (!s) {
          s = createSearcher(db, embeddings, { ...cfg, ...override }, reranker);
          tuned.set(key, s);
        }
        searcher = s;
      }
      const result = await searcher.search(clientId, query, ctx);
      return {
        citations: result.passages,
        relevant: result.relevant,
        searched: result.searched,
        reason: result.reason,
        timings: result.timings,
      };
    } catch (err) {
      // If search is down we must not improvise policy, so report "nothing relevant".
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'knowledge search failed',
      );
      return { citations: [], relevant: false, reason: 'The policy search was unavailable.' };
    }
  };
}
