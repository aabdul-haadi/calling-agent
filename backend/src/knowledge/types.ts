import type { Citation } from '@adk/shared';

export interface RetrievalResult {
  /** Chunks judged relevant enough to show the model (and the customer, as citations). */
  citations: Citation[];
  /** False means "we have no policy for this" - the agent must NOT improvise. */
  relevant: boolean;
  /** The text that was searched, why the decision was made, and how long each step took (for the trace). */
  searched?: string;
  reason?: string;
  timings?: {
    embedMs: number;
    vectorMs: number;
    keywordMs: number;
    rerankMs?: number;
    totalMs: number;
  };
}

export interface RetrievalContext {
  /** What the customer asked before (oldest first), only used to understand a short follow-up. */
  recentQuestions?: string[];
}

export type Retriever = (
  clientId: string,
  query: string,
  ctx?: RetrievalContext,
) => Promise<RetrievalResult>;

/**
 * Shown when a policy question has no matching policy. The agent never improvises policy, and it
 * does not call the model for this: the words are fixed so they can never promise anything.
 */
export const NO_POLICY_REPLY =
  "I'm not sure about that one, and I don't want to guess. I can connect you with a human agent who can confirm it. Would you like that?";
