import type { EvalResultView, EvalRunView } from '@adk/shared';

export type Category =
  'Security' | 'Business rules' | 'Resilience' | 'Escalation & scope' | 'Knowledge' | 'Functional';

/**
 * The backend does not tag scenarios, so the category is inferred from the scenario id. The UI
 * says so. Order matters: the first matching rule wins.
 */
const RULES: [RegExp, Category][] = [
  [/injection|unverified|other-passengers|wrong-last-name|access/, 'Security'],
  [/duplicate|voluntary|second-passenger|change-fee/, 'Business rules'],
  [/api-down|unavailable|timeout|slow/, 'Resilience'],
  [/angry|human|escalat|out-of-scope|lost-baggage/, 'Escalation & scope'],
  [/policy|baggage|refund|unknown|roaming|bill|data/, 'Knowledge'],
];

export function categorize(scenarioId: string): Category {
  return RULES.find(([re]) => re.test(scenarioId))?.[1] ?? 'Functional';
}

export const JUDGE_PREFIX = 'Judge:';

/** Deterministic checks are everything in `failures` that is not the judge's verdict. */
export function splitFailures(r: EvalResultView): { deterministic: string[]; judge?: string } {
  const deterministic = r.failures.filter((f) => !f.startsWith(JUDGE_PREFIX));
  const judgeFailed = r.failures.find((f) => f.startsWith(JUDGE_PREFIX));
  return { deterministic, judge: judgeFailed?.slice(JUDGE_PREFIX.length).trim() };
}

export interface CategoryScore {
  category: Category;
  passed: number;
  total: number;
}

export function categoryScores(results: EvalResultView[]): CategoryScore[] {
  const map = new Map<Category, CategoryScore>();
  for (const r of results) {
    const category = categorize(r.scenarioId);
    const s = map.get(category) ?? { category, passed: 0, total: 0 };
    s.total++;
    if (r.passed) s.passed++;
    map.set(category, s);
  }
  return [...map.values()].sort((a, b) => a.category.localeCompare(b.category));
}

export interface RunDiff {
  regressed: EvalResultView[];
  fixed: EvalResultView[];
  stillFailing: EvalResultView[];
  added: EvalResultView[];
  removed: string[];
  unchanged: number;
}

/** Compares two runs scenario by scenario. `before` is the older run. */
export function compareRuns(before: EvalRunView, after: EvalRunView): RunDiff {
  const prev = new Map(before.results.map((r) => [r.scenarioId, r]));
  const diff: RunDiff = {
    regressed: [],
    fixed: [],
    stillFailing: [],
    added: [],
    removed: [],
    unchanged: 0,
  };
  for (const r of after.results) {
    const old = prev.get(r.scenarioId);
    prev.delete(r.scenarioId);
    if (!old) diff.added.push(r);
    else if (old.passed && !r.passed) diff.regressed.push(r);
    else if (!old.passed && r.passed) diff.fixed.push(r);
    else if (!r.passed) diff.stillFailing.push(r);
    else diff.unchanged++;
  }
  diff.removed = [...prev.keys()];
  return diff;
}
