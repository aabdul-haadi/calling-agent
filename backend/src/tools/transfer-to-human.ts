import { z } from 'zod';
import { ok } from '@adk/shared';
import { defineTool } from './types';

/**
 * Shared by every client: hand the conversation to a human. The tool only RECORDS the request;
 * the engine creates the real handoff (summary + signed webhook) at the end of the turn.
 */
export const transferToHuman = defineTool({
  name: 'transfer_to_human',
  description:
    'Transfer the customer only when they explicitly ask for a person or accept an offer to speak with one. Do not transfer for an unfamiliar, ambiguous, or out-of-scope request alone; explain what you can help with and ask a brief clarification instead.',
  input: z.object({ reason: z.string().trim().min(3).max(200) }),
  label: 'Requested a human agent',
  summarize: () => 'Transfer requested',
  run: async () => ok({ queued: true }),
  remember: (_data, input) => ({ pendingHandoff: { reason: input.reason }, step: 'close' }),
});
