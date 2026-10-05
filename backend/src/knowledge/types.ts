import type { Citation } from '@adk/shared';

export interface RetrievalResult {
  /** Chunks judged relevant enough to show the model (and the customer, as citations). */
  citations: Citation[];
  /** False means "we have no policy for this" - the agent must NOT improvise. */
  relevant: boolean;
}

export type Retriever = (clientId: string, query: string) => Promise<RetrievalResult>;

/** Shown when a policy question has no matching policy. Never improvise policy. */
export const NO_POLICY_REPLY =
  "I'm not sure about that, and I don't want to give you wrong information. I can connect you with a human agent who can confirm. Would you like that?";
