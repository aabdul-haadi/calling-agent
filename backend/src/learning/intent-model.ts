// A small local intent classifier trained from approved examples. It exists to show, with numbers,
// whether learned data can match the language model's intent labelling at a fraction of its time
// and cost. Multinomial naive Bayes over word and word-pair features: it trains in milliseconds on
// a CPU, is fully reproducible, and has no dependencies. It never decides a handoff or an approval.

export interface Labelled {
  say: string;
  intent: string;
}

export interface IntentModel {
  kind: 'naive_bayes_v1';
  classes: string[];
  /** log P(class) */
  prior: Record<string, number>;
  /** log P(feature | class), with a fallback for unseen features */
  likelihood: Record<string, Record<string, number>>;
  unseen: Record<string, number>;
  trainedOn: number;
}

const STOP = new Set('a an the is are to of and i my me you your it in on for at be do does can could would will please'.split(' '));

const stem = (w: string): string => (w.length > 4 ? w.replace(/(ing|ed|es|s)$/, '') : w);

export function features(text: string): string[] {
  const w = text
    .toLowerCase()
    .replace(/\[[a-z_]+\]/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((x) => x.length > 0);
  const content = w.filter((x) => !STOP.has(x)).map(stem);
  const out: string[] = [];
  for (const x of content) {
    out.push(x);
    // A shared start ("complain", "complaint") still counts when the exact word was never seen.
    if (x.length >= 6) out.push(`p4:${x.slice(0, 5)}`);
  }
  for (let i = 0; i + 1 < content.length; i++) out.push(`${content[i]}_${content[i + 1]}`);
  return out;
}

export function train(examples: Labelled[]): IntentModel {
  const classes = [...new Set(examples.map((e) => e.intent))].sort();
  const docs: Record<string, number> = {};
  const counts: Record<string, Map<string, number>> = {};
  const totals: Record<string, number> = {};
  const vocab = new Set<string>();
  for (const e of examples) {
    docs[e.intent] = (docs[e.intent] ?? 0) + 1;
    const m = (counts[e.intent] ??= new Map());
    for (const f of features(e.say)) {
      m.set(f, (m.get(f) ?? 0) + 1);
      totals[e.intent] = (totals[e.intent] ?? 0) + 1;
      vocab.add(f);
    }
  }
  const v = vocab.size;
  const prior: Record<string, number> = {};
  const likelihood: Record<string, Record<string, number>> = {};
  const unseen: Record<string, number> = {};
  for (const k of classes) {
    prior[k] = Math.log((docs[k] ?? 0) / examples.length);
    const denom = (totals[k] ?? 0) + v + 1;
    unseen[k] = Math.log(1 / denom);
    likelihood[k] = {};
    for (const [f, n] of counts[k] ?? []) likelihood[k]![f] = Math.log((n + 1) / denom);
  }
  return { kind: 'naive_bayes_v1', classes, prior, likelihood, unseen, trainedOn: examples.length };
}

export interface Prediction {
  intent: string;
  /** 0..1, softmax over the class scores */
  confidence: number;
}

export function predict(model: IntentModel, text: string): Prediction {
  const fs = features(text);
  const scores = model.classes.map((k) => {
    let s = model.prior[k] ?? -Infinity;
    for (const f of fs) s += model.likelihood[k]?.[f] ?? model.unseen[k] ?? -20;
    return { k, s };
  });
  scores.sort((a, b) => b.s - a.s);
  const best = scores[0];
  if (!best) return { intent: 'unknown', confidence: 0 };
  const denom = scores.reduce((sum, x) => sum + Math.exp(x.s - best.s), 0);
  return { intent: best.k, confidence: 1 / denom };
}

export interface IntentScore {
  accuracy: number;
  n: number;
  /** Intents that never came out right, which would be silently wrong in use. */
  missedClasses: string[];
  perClass: Record<string, { n: number; correct: number }>;
  /** Share answered with confidence above the line, and how accurate those were. */
  confident: { share: number; accuracy: number };
}

export function score(model: IntentModel, cases: Labelled[], confidentAt = 0.8): IntentScore {
  const perClass: Record<string, { n: number; correct: number }> = {};
  let right = 0;
  let confidentN = 0;
  let confidentRight = 0;
  for (const c of cases) {
    const p = predict(model, c.say);
    const pc = (perClass[c.intent] ??= { n: 0, correct: 0 });
    pc.n++;
    if (p.intent === c.intent) {
      right++;
      pc.correct++;
    }
    if (p.confidence >= confidentAt) {
      confidentN++;
      if (p.intent === c.intent) confidentRight++;
    }
  }
  return {
    accuracy: cases.length ? right / cases.length : 0,
    n: cases.length,
    missedClasses: Object.entries(perClass)
      .filter(([, v]) => v.correct === 0)
      .map(([k]) => k),
    perClass,
    confident: {
      share: cases.length ? confidentN / cases.length : 0,
      accuracy: confidentN ? confidentRight / confidentN : 0,
    },
  };
}
