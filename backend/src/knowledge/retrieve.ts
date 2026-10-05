import type { Citation } from '@adk/shared';
import type { Db } from '../database';
import { knowledgeRepo } from '../database';
import type { Logger } from '../logger';
import type { EmbeddingProvider } from './embeddings';
import { tokenize } from './text';
import type { Retriever } from './types';

export const TOP_K = 8;
export const MAX_RESULTS = 3;
/** Below this combined score we say "I'm not sure" instead of guessing. */
export const MIN_SCORE = 0.3;

/** Fraction of the question's meaningful words that appear in the chunk (prefix match: bag ~ baggage). */
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

export interface Candidate {
  source: string;
  heading: string;
  content: string;
  similarity: number;
}

/** Simple rerank: vector similarity blended with keyword overlap, then a hard relevance gate. */
export function rerank(query: string, candidates: Candidate[]): Citation[] {
  const q = [...new Set(tokenize(query))];
  return (
    candidates
      .map((c) => {
        const overlap = lexicalOverlap(q, new Set(tokenize(`${c.heading} ${c.content}`)));
        return { c, overlap, score: 0.5 * Math.max(0, c.similarity) + 0.5 * overlap };
      })
      // Vector search always returns *something*; the keyword gate stops unrelated text from passing.
      .filter((r) => r.overlap > 0 && r.score >= MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RESULTS)
      .map(({ c, score }) => ({
        source: c.source,
        heading: c.heading,
        snippet: c.content.length > 600 ? `${c.content.slice(0, 600)}…` : c.content,
        score: Math.round(score * 100) / 100,
      }))
  );
}

export function createRetriever(db: Db, embeddings: EmbeddingProvider, logger: Logger): Retriever {
  return async (clientId, query) => {
    try {
      const [vector] = await embeddings.embed([query]);
      const hits = await knowledgeRepo.searchChunks(db, clientId, vector!, TOP_K);
      const citations = rerank(query, hits);
      return { citations, relevant: citations.length > 0 };
    } catch (err) {
      // If search is down we must not improvise policy, so report "nothing relevant".
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'knowledge search failed',
      );
      return { citations: [], relevant: false };
    }
  };
}
