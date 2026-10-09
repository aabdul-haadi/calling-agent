import { z } from 'zod';
import { PHASES, type Phase } from './phase';
import { proposalSchema } from './approval';
import { SENTIMENTS, type ConversationStateView, type ParsedClientConfig } from '@adk/shared';

export const conversationStateSchema = z.object({
  /** Where the conversation is in its life cycle. Moved only by the engine (see phase.ts). */
  phase: z.enum(PHASES).default('NEW'),
  /** The change waiting for (or just given) the customer's approval. Never set by the model. */
  proposal: proposalSchema.optional(),
  verified: z.boolean(),
  /** Id of the verified customer; tools compare it to the record they fetch (ownership check). */
  customerId: z.string().optional(),
  journeyId: z.string(),
  journeyStep: z.string(),
  /** Small, flattened facts remembered across turns (booking summary, offered flights...). */
  collected: z.record(z.string(), z.unknown()),
  failedTurns: z.number().int(),
  /** Consecutive UNAVAILABLE tool results. Two in a row triggers a handoff. */
  unavailableStreak: z.number().int(),
  toolCallCounts: z.record(z.string(), z.number().int()),
  handedOff: z.boolean(),
  lastIntent: z.string(),
  lastSentiment: z.enum(SENTIMENTS),
  /** Set by transfer_to_human; the engine turns it into a real handoff at end of turn. */
  pendingHandoff: z.object({ reason: z.string() }).optional(),
});

export type ConversationState = z.infer<typeof conversationStateSchema>;

export function newState(config: ParsedClientConfig): ConversationState {
  const journey = config.journeys[0]!;
  return {
    phase: 'NEW' as Phase,
    verified: false,
    journeyId: journey.id,
    journeyStep: journey.steps[0]!.id,
    collected: {},
    failedTurns: 0,
    unavailableStreak: 0,
    toolCallCounts: {},
    handedOff: false,
    lastIntent: 'unknown',
    lastSentiment: 'neutral',
  };
}

export const toStateView = (s: ConversationState): ConversationStateView => ({
  phase: s.phase,
  verified: s.verified,
  journeyId: s.journeyId,
  journeyStep: s.journeyStep,
  collected: s.collected,
  handedOff: s.handedOff,
});

/** Index of a step in the journey, used so the progress bar never moves backwards. */
export function stepIndex(config: ParsedClientConfig, journeyId: string, stepId: string): number {
  const journey = config.journeys.find((j) => j.id === journeyId);
  return journey ? journey.steps.findIndex((s) => s.id === stepId) : -1;
}
