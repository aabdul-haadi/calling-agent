import { fail, type Rule, type ToolResult } from '@adk/shared';
import type { ConversationState } from '../../agent/state';

/**
 * Business rules enforced in CODE. The system prompt may mention them, but nothing the model
 * says (or a customer tricks it into saying) can bypass them.
 */
export function checkRules(
  rules: Rule[],
  tool: string,
  state: Readonly<ConversationState>,
): ToolResult<null> {
  for (const rule of rules) {
    if (rule.kind === 'requiresVerification' && rule.tools.includes(tool) && !state.verified) {
      return fail(
        'AUTH_REQUIRED',
        'The customer must be verified before this action. Ask for their details.',
      );
    }
    if (rule.kind === 'maxCallsPerConversation' && rule.tool === tool) {
      const used = state.toolCallCounts[tool] ?? 0;
      if (used >= rule.limit) {
        return fail(
          'RULE_BLOCKED',
          `${rule.description} Offer to transfer the customer to a human agent.`,
        );
      }
    }
  }
  return { ok: true, data: null };
}
