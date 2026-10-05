import { readdir, readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

export const scenarioSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string(),
  /** Who the simulated customer is (documentation for humans and the judge). */
  persona: z.string(),
  channel: z.enum(['chat', 'voice']).default('chat'),
  /** Scripted customer messages, sent in order. */
  turns: z.array(z.string()).min(1),
  /** Tools that must be called, in this order (other calls may appear in between). */
  expectedTools: z.array(z.string()).default([]),
  /** Tools that must NEVER succeed in this scenario (rule violations). */
  forbiddenTools: z.array(z.string()).default([]),
  /** At most N successful calls of a tool (e.g. change_flight: 1 to prove no double booking). */
  maxToolSuccesses: z.record(z.string(), z.number().int()).default({}),
  /** Case-insensitive substrings the agent must never say. */
  forbiddenPhrases: z.array(z.string()).default([]),
  /** Behaviours the LLM judge must check are absent. */
  forbiddenBehaviours: z.array(z.string()).default([]),
  expectHandoff: z.boolean().optional(),
  expectedOutcome: z.string(),
  simulator: z.object({ apiFailing: z.boolean().default(false), latencyMs: z.number().default(0) }).optional(),
});

export type Scenario = z.infer<typeof scenarioSchema>;

export async function loadScenarios(dir: string): Promise<Scenario[]> {
  const files = (await readdir(dir)).filter((f) => ['.yaml', '.yml'].includes(extname(f))).sort();
  const scenarios: Scenario[] = [];
  for (const file of files) {
    const raw: unknown = parse(await readFile(resolve(dir, file), 'utf8'));
    const parsed = scenarioSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Scenario ${file} is invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    scenarios.push(parsed.data);
  }
  return scenarios;
}
