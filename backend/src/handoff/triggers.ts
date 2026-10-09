import { sentimentAtLeast, type ParsedClientConfig, type Sentiment } from '@adk/shared';
import type { ConversationState } from '../agent/state';

export type HandoffReason =
  | 'user_request'
  | 'failed_turns'
  | 'frustration'
  | 'always_escalate_intent'
  | 'loop_guard'
  | 'tool_unavailable'
  | 'ai_unavailable'
  | 'agent_requested';

export interface TurnClassification {
  intent: string;
  sentiment: Sentiment;
  wantsHuman: boolean;
  isPolicyQuestion: boolean;
  /** Does the message agree (yes) or refuse (no) the change awaiting approval? */
  confirmation: 'yes' | 'no' | 'none';
}

/** Plain-language reason shown to the human agent and in the UI. */
export const REASON_TEXT: Record<HandoffReason, string> = {
  user_request: 'Customer asked for a human',
  failed_turns: 'Agent could not make progress after repeated attempts',
  frustration: 'Customer sounds frustrated',
  always_escalate_intent: 'This type of request always goes to a human',
  loop_guard: 'Agent hit its step limit',
  tool_unavailable: 'A company system was unavailable twice in a row',
  ai_unavailable: 'The AI model was unavailable',
  agent_requested: 'Agent decided a human should take over',
};

/** Checked BEFORE the agent loop, from what the customer just said. Pure function: easy to test. */
export function evaluatePreTurn(
  config: ParsedClientConfig,
  c: TurnClassification,
): HandoffReason | null {
  const esc = config.escalation;
  if (esc.onUserRequest && c.wantsHuman) return 'user_request';
  if (esc.alwaysEscalateIntents.includes(c.intent)) return 'always_escalate_intent';
  if (sentimentAtLeast(c.sentiment, esc.sentimentThreshold)) return 'frustration';
  return null;
}

export interface PostTurnFacts {
  loopGuardHit: boolean;
  aiUnavailable: boolean;
}

/** Checked AFTER the agent loop, from what happened during the turn. */
export function evaluatePostTurn(
  config: ParsedClientConfig,
  state: Readonly<ConversationState>,
  facts: PostTurnFacts,
): HandoffReason | null {
  if (facts.loopGuardHit) return 'loop_guard';
  if (facts.aiUnavailable) return 'ai_unavailable';
  if (state.pendingHandoff) return 'agent_requested';
  if (state.unavailableStreak >= 2) return 'tool_unavailable';
  if (state.failedTurns >= config.escalation.maxFailedTurns) return 'failed_turns';
  return null;
}
