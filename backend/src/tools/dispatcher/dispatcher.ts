import { fail, ok, type Rule, type ToolResult } from '@adk/shared';
import { createProposal, isApprovedFor } from '../../agent/approval';
import type { Proposal } from '../../agent/approval';
import type { AnyToolDefinition, StatePatch, ToolContext } from '../types';
import { checkRules } from './rules';

export interface DispatchDeps {
  /** Every tool the engine knows about, by name. */
  registry: ReadonlyMap<string, AnyToolDefinition>;
  /** The names this client is allowed to use (client config `tools`). */
  allowed: readonly string[];
  rules: Rule[];
}

export interface DispatchOutcome {
  tool: string;
  result: ToolResult<unknown>;
  patch: StatePatch;
  latencyMs: number;
  /** Plain-language trace text. */
  label: string;
  summary: string;
  /**
   * 'proposed': an approval-bound tool created a proposal and did NOT run.
   * 'executing': it ran with a valid approval.
   */
  approvalStage?: 'proposed' | 'executing';
  /** The proposal this call was about (for the audit log). */
  proposal?: Proposal;
}

/**
 * The single door every tool call goes through:
 * allow-list -> zod validation -> auth gate + rules -> execute.
 * Nothing the model sends reaches a tool without passing all four.
 */
export async function dispatch(
  name: string,
  rawInput: unknown,
  ctx: ToolContext,
  deps: DispatchDeps,
): Promise<DispatchOutcome> {
  const started = Date.now();
  const done = (
    result: ToolResult<unknown>,
    tool?: AnyToolDefinition,
    patch: StatePatch = {},
    summary = '',
  ): DispatchOutcome => ({
    tool: name,
    result,
    patch,
    latencyMs: Date.now() - started,
    label: tool?.label ?? 'Tried an unavailable tool',
    summary,
  });

  const tool = deps.registry.get(name);
  if (!tool || !deps.allowed.includes(name)) {
    return done(fail('INVALID_ARGS', `Unknown tool "${name}". Use only the tools you were given.`));
  }

  const parsed = tool.input.safeParse(rawInput);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`);
    return done(fail('INVALID_ARGS', `Invalid arguments: ${issues.join('; ')}`), tool);
  }

  const gate = checkRules(deps.rules, name, ctx.state);
  if (!gate.ok) return done(gate, tool);

  let approvalStage: DispatchOutcome['approvalStage'];
  let activeProposal: Proposal | undefined;
  if (tool.approval) {
    // Look at the live world first. The binding is recomputed on every call, so an approval for
    // yesterday's booking state can never authorise today's.
    const proposed = await tool.approval.propose(parsed.data, ctx);
    if (!proposed.ok) return done(proposed, tool);
    const { summary, binding } = proposed.data;
    if (!isApprovedFor(ctx.state.proposal, name, ctx.state.customerId, binding)) {
      if (!ctx.state.customerId)
        return done(fail('AUTH_REQUIRED', 'The customer must be verified first.'), tool);
      const proposal = createProposal(name, summary, binding, ctx.state.customerId);
      const out = done(
        ok({
          executed: false,
          awaitingCustomerApproval: true,
          willChange: summary,
          instruction:
            'Nothing has been changed yet. Tell the customer exactly this change and ask them to reply yes. Do not say it is done.',
        }),
        tool,
        { proposal },
        `Waiting for the customer to approve: ${summary}`,
      );
      return { ...out, label: 'Proposed a change', approvalStage: 'proposed', proposal };
    }
    approvalStage = 'executing';
    activeProposal = ctx.state.proposal;
  }

  let result: ToolResult<unknown>;
  try {
    result = await tool.run(parsed.data, ctx);
  } catch (err) {
    // A bug inside a tool must never crash the conversation.
    ctx.logger.error(
      { tool: name, err: err instanceof Error ? err.message : String(err) },
      'tool threw',
    );
    result = fail('UNAVAILABLE', 'The tool failed unexpectedly');
  }
  if (!result.ok) return { ...done(result, tool), approvalStage, proposal: activeProposal };

  const patch = tool.remember?.(result.data, parsed.data, ctx) ?? {};
  // One approval covers one execution.
  if (activeProposal) patch.proposal = { ...activeProposal, status: 'executed' };
  return {
    ...done(result, tool, patch, tool.summarize?.(result.data, parsed.data) ?? ''),
    approvalStage,
    proposal: activeProposal,
  };
}
