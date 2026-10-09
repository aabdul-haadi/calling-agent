import type { ZodType } from 'zod';
import type { ToolResult } from '@adk/shared';
import type { AuditType } from '../agent/audit';
import type { Binding, Proposal } from '../agent/approval';
import type { ConversationState } from '../agent/state';
import type { Logger } from '../logger';
import type { ApiClient } from './http';
import type { IdempotencyStore } from './security';

/** What a tool may ask the engine to remember after it succeeds. */
export interface StatePatch {
  verified?: boolean;
  customerId?: string;
  /** Merged into state.collected. */
  collected?: Record<string, unknown>;
  /** Journey step reached (the bar never moves backwards). */
  step?: string;
  pendingHandoff?: { reason: string };
  /** Set by the dispatcher for approval-bound tools; tools themselves never touch it. */
  proposal?: Proposal;
}

export interface ToolContext {
  conversationId: string;
  clientId: string;
  /** Read-only snapshot taken before the call. */
  state: Readonly<ConversationState>;
  /**
   * State as it was BEFORE this customer message. Tools use it to require that something (like
   * flight options) was already shown to the customer in an earlier reply, not just fetched now.
   */
  stateAtTurnStart: Readonly<ConversationState>;
  logger: Logger;
  /** Already bound to this client's API base URL, auth and demo-simulator headers. */
  api: ApiClient;
  idempotency: IdempotencyStore;
  /** Write a decision to the audit log (for example that a timed-out change was reconciled). */
  audit: (type: AuditType, data?: Record<string, unknown>) => void;
}

/**
 * Marks a tool as a change that needs the customer's approval of the EXACT change. `propose` looks at
 * the live world and returns what would change plus a binding of the values that matter. The
 * dispatcher stores it as a proposal, and only runs the tool once a later customer message approved
 * a proposal with an identical binding.
 */
export interface ApprovalSpec<I> {
  propose: (
    input: I,
    ctx: ToolContext,
  ) => Promise<ToolResult<{ summary: string; binding: Binding }>>;
}

export interface ToolDefinition<I = unknown, O = unknown> {
  name: string;
  /** Shown to the model. */
  description: string;
  input: ZodType<I>;
  /** Plain-language trace label, e.g. "Checked the booking system". */
  label: string;
  /** Plain-language summary of a successful result for the trace, e.g. "Found 3 alternative flights". */
  // NoInfer: O and I must be inferred from `input` and `run`, not from these callbacks.
  summarize?: (data: NoInfer<O>, input: NoInfer<I>) => string;
  /** Present on tools that change something. */
  approval?: ApprovalSpec<I>;
  run: (input: I, ctx: ToolContext) => Promise<ToolResult<O>>;
  remember?: (data: NoInfer<O>, input: NoInfer<I>, ctx: ToolContext) => StatePatch;
}

/** Type-erased form stored in registries: tools with different input/output types share one list. */
export type AnyToolDefinition = ToolDefinition<unknown, unknown>;

/**
 * Declares a strongly typed tool and erases its types for the registry. The casts are safe because
 * the dispatcher always parses the model's raw input with `def.input` before calling `run`.
 */
export function defineTool<I, O>(def: ToolDefinition<I, O>): AnyToolDefinition {
  return {
    name: def.name,
    description: def.description,
    label: def.label,
    input: def.input as ZodType<unknown>,
    approval: def.approval && { propose: (input, ctx) => def.approval!.propose(input as I, ctx) },
    run: (input, ctx) => def.run(input as I, ctx),
    summarize: def.summarize && ((data, input) => def.summarize!(data as O, input as I)),
    remember: def.remember && ((data, input, ctx) => def.remember!(data as O, input as I, ctx)),
  };
}
