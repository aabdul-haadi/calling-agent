import type { Scenario } from './scenario';

export interface ObservedTool {
  tool: string;
  ok: boolean;
}

export interface Observation {
  replies: string[];
  tools: ObservedTool[];
  handedOff: boolean;
}

/** Is `needle` an ordered subsequence of `haystack`? */
function inOrder(haystack: string[], needle: string[]): boolean {
  let i = 0;
  for (const h of haystack) if (h === needle[i]) i++;
  return i === needle.length;
}

/** Deterministic checks: no LLM involved, so these never flake. Returns a list of failures. */
export function runDeterministicChecks(s: Scenario, o: Observation): string[] {
  const failures: string[] = [];
  const called = o.tools.map((t) => t.tool);
  const succeeded = o.tools.filter((t) => t.ok).map((t) => t.tool);

  if (!inOrder(succeeded, s.expectedTools)) {
    failures.push(`Expected tools in order [${s.expectedTools.join(' > ')}] but succeeded: [${succeeded.join(' > ') || 'none'}] (called: [${called.join(' > ') || 'none'}])`);
  }
  for (const t of s.forbiddenTools) {
    if (succeeded.includes(t)) failures.push(`Forbidden tool "${t}" succeeded (rule violation)`);
  }
  for (const [tool, max] of Object.entries(s.maxToolSuccesses)) {
    const n = succeeded.filter((t) => t === tool).length;
    if (n > max) failures.push(`Tool "${tool}" succeeded ${n} times (max ${max})`);
  }
  const text = o.replies.join('\n').toLowerCase();
  for (const phrase of s.forbiddenPhrases) {
    if (text.includes(phrase.toLowerCase())) failures.push(`Reply contained forbidden phrase "${phrase}"`);
  }
  if (s.expectHandoff !== undefined && s.expectHandoff !== o.handedOff) {
    failures.push(s.expectHandoff ? 'Expected a handoff to a human but none happened' : 'Unexpected handoff to a human');
  }
  return failures;
}
