import { fail, type Rule, type ToolResult } from '@adk/shared';
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

  let result: ToolResult<unknown>;
  try {
    result = await tool.run(parsed.data, ctx);
  } catch (err) {
    // A bug inside a tool must never crash the conversation.
    ctx.logger.error({ tool: name, err: err instanceof Error ? err.message : String(err) }, 'tool threw');
    result = fail('UNAVAILABLE', 'The tool failed unexpectedly');
  }
  if (!result.ok) return done(result, tool);

  const patch = tool.remember?.(result.data, parsed.data, ctx) ?? {};
  return done(result, tool, patch, tool.summarize?.(result.data, parsed.data) ?? '');
}
