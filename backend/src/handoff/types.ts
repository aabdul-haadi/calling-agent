import type { HandoffView } from '@adk/shared';
import type { ParsedClientConfig } from '@adk/shared';
import type { ConversationState } from '../agent/state';
import type { HandoffReason } from './triggers';

export interface HandoffInput {
  conversationId: string;
  clientId: string;
  config: ParsedClientConfig;
  reason: HandoffReason;
  /** Free-text reason given by the agent via transfer_to_human, if any. */
  detail?: string;
  state: ConversationState;
  transcript: { role: 'user' | 'assistant'; content: string }[];
  /** Plain-language list of what the agent already did, taken from the trace. */
  tried: string[];
}

export interface HandoffService {
  create(input: HandoffInput): Promise<HandoffView>;
}
