import { writeFile, mkdir } from 'node:fs/promises';
import '../config/load-dotenv';
import { loadEnv } from '../config';
import { loadClients } from '../clients';
import { classifyTurn } from '../agent/classify';
import { createLlm } from '../llm';
import { waitContext } from '../llm/http';

// Usage: pnpm --filter @adk/backend classify-eval <model> [<model> ...]
// How good is each model at the one-line classification of a customer message (intent, mood, asks for
// a person, asks about a policy, approves the waiting change)? Hand-labelled messages, SkyLink Air's
// configuration. Reports accuracy per field, and the time of a call WITHOUT the time spent waiting for
// the provider's rate limit. Use it before pointing LLM_CLASSIFIER_MODEL at a smaller model.

interface Case {
  say: string;
  pending?: string;
  /** Acceptable answers; a field that is not listed is not checked for this message. */
  intent?: string[];
  sentiment?: ('positive' | 'neutral' | 'frustrated' | 'angry')[];
  wantsHuman?: boolean;
  isPolicyQuestion?: boolean;
  confirmation?: ('yes' | 'no' | 'none')[];
}
const PENDING = 'Move booking SK1001 to flight SK110 on November 10 at 11:00 AM, no fee';
const CASES: Case[] = [
  // approval of a waiting change: the part where a mistake is expensive
  { say: 'Yes, go ahead', pending: PENDING, confirmation: ['yes'] },
  { say: "Yeah that's fine, book it", pending: PENDING, confirmation: ['yes'] },
  { say: 'Sounds good, please confirm it', pending: PENDING, confirmation: ['yes'] },
  { say: "No, I don't want that one", pending: PENDING, confirmation: ['no'] },
  {
    say: 'Actually can I get the evening flight instead?',
    pending: PENDING,
    confirmation: ['no', 'none'],
  },
  {
    say: 'Yes, but what is the baggage allowance?',
    pending: PENDING,
    confirmation: ['none', 'no'],
  },
  { say: 'How much does that cost again?', pending: PENDING, confirmation: ['none'] },
  { say: 'Hmm, let me think about it', pending: PENDING, confirmation: ['none', 'no'] },
  { say: 'Who is the pilot on that flight?', pending: PENDING, confirmation: ['none'] },
  { say: 'Yes', confirmation: ['none'] }, // nothing is waiting
  // asks for a person
  { say: 'I want to speak to a real person', wantsHuman: true },
  { say: 'Can you get me a manager please', wantsHuman: true },
  { say: 'Transfer me to a human agent', wantsHuman: true },
  { say: 'Can you help me change my flight?', wantsHuman: false },
  { say: 'My booking reference is SK1001 and my name is Rahman', wantsHuman: false },
  { say: 'How many bags can I bring on economy?', wantsHuman: false },
  // mood: tone, not situation
  { say: 'My flight was cancelled and I need to rebook it', sentiment: ['neutral'] },
  {
    say: 'My bag did not arrive and I would like to know what happens next',
    sentiment: ['neutral'],
  },
  {
    say: "This is ridiculous, I've been waiting forever and nobody helps",
    sentiment: ['frustrated', 'angry'],
  },
  { say: "You people are useless, I'm absolutely furious", sentiment: ['angry', 'frustrated'] },
  {
    say: "I'm a bit annoyed, this is the third time I am asking",
    sentiment: ['frustrated', 'angry'],
  },
  { say: 'Thanks so much, that was really helpful', sentiment: ['positive', 'neutral'] },
  { say: 'Hi there', sentiment: ['neutral', 'positive'] },
  // policy question or not
  { say: 'How many checked bags can I take?', isPolicyQuestion: true },
  { say: "What's your refund policy?", isPolicyQuestion: true },
  { say: 'Can I get a refund if you cancel my flight?', isPolicyQuestion: true },
  { say: 'How much is the change fee on an international ticket?', isPolicyQuestion: true },
  { say: 'My booking reference is SK1001', isPolicyQuestion: false },
  { say: 'Please move me to the first option', isPolicyQuestion: false },
  { say: 'Hello', isPolicyQuestion: false },
  { say: 'My name is Rahman', isPolicyQuestion: false },
  // intent
  { say: 'My flight got cancelled', intent: ['flight_cancelled', 'rebooking'] },
  { say: 'How many bags can I bring?', intent: ['baggage_policy'] },
  { say: "What's the change fee?", intent: ['change_fee_policy', 'refund_policy'] },
  { say: 'Can I get my money back?', intent: ['refund_policy'] },
  {
    say: 'I would like to move to a later flight',
    intent: ['rebooking', 'voluntary_change', 'change_fee_policy'],
  },
];

const models = process.argv.slice(2);
if (models.length === 0) {
  console.error('Usage: pnpm --filter @adk/backend classify-eval <model> [<model> ...]');
  process.exit(1);
}
const env = loadEnv();
const config = loadClients().get('skylink-air')!.config;

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length
    ? Math.round(s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]!)
    : null;
};

const report: unknown[] = [];
for (const model of models) {
  const llm = createLlm(env, model);
  const hits: Record<string, [number, number]> = {};
  const note = (field: string, ok: boolean) => {
    const h = (hits[field] ??= [0, 0]);
    h[0] += ok ? 1 : 0;
    h[1] += 1;
  };
  const ms: number[] = [];
  const wrong: string[] = [];
  let unusable = 0;
  for (const c of CASES) {
    const waits = { waitedMs: 0, hits: 0 };
    const t0 = performance.now();
    const r = await waitContext.run(waits, () => classifyTurn(llm, config, [], c.say, c.pending));
    ms.push(performance.now() - t0 - waits.waitedMs);
    if (
      r.intent === 'unknown' &&
      r.sentiment === 'neutral' &&
      !r.wantsHuman &&
      !r.isPolicyQuestion &&
      r.confirmation === 'none' &&
      c.intent
    )
      unusable++;
    const check = (field: string, ok: boolean | undefined) => {
      if (ok === undefined) return;
      note(field, ok);
      if (!ok)
        wrong.push(
          `${field}: "${c.say}" -> ${JSON.stringify({ intent: r.intent, sentiment: r.sentiment, wantsHuman: r.wantsHuman, isPolicyQuestion: r.isPolicyQuestion, confirmation: r.confirmation })}`,
        );
    };
    check('confirmation', c.confirmation ? c.confirmation.includes(r.confirmation) : undefined);
    check('wantsHuman', c.wantsHuman === undefined ? undefined : r.wantsHuman === c.wantsHuman);
    check('sentiment', c.sentiment ? c.sentiment.includes(r.sentiment) : undefined);
    check(
      'isPolicyQuestion',
      c.isPolicyQuestion === undefined ? undefined : r.isPolicyQuestion === c.isPolicyQuestion,
    );
    check('intent', c.intent ? c.intent.includes(r.intent) : undefined);
    // the dangerous mistake: reading a yes that was not there
    if (c.confirmation && !c.confirmation.includes('yes'))
      note('neverApprovesWrongly', r.confirmation !== 'yes');
    process.stdout.write('.');
  }
  process.stdout.write('\n');
  const accuracy = Object.fromEntries(
    Object.entries(hits).map(([k, [ok, n]]) => [k, `${ok}/${n}`]),
  );
  const row = {
    model,
    cases: CASES.length,
    accuracy,
    callMsWithoutRateLimit: { p50: pct(ms, 0.5), p95: pct(ms, 0.95) },
    unusableAnswers: unusable,
    wrong,
  };
  report.push(row);
  console.log(JSON.stringify(row, null, 1));
}
await mkdir('eval-results', { recursive: true });
await writeFile('eval-results/classify-eval.json', JSON.stringify(report, null, 2));
