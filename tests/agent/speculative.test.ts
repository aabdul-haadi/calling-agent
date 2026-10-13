import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TurnEvent } from '@adk/shared';
import { callTool, createHarness, say, type Harness, type ScriptStep } from '../helpers/harness';

/**
 * The model's first answer is started while the message is still being classified. These tests pin
 * down what that is allowed to do: save time, and nothing else.
 */

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ ingestKnowledge: true, classify: () => ({ intent: 'rebooking' }) });
});
afterAll(() => h.close());
beforeEach(async () => {
  h.llm.reset();
  await fetch(`${h.mockUrl}/admin/reset`, { method: 'POST' });
});

const ask = (message: string, conversationId?: string) => ({
  clientId: 'skylink-air',
  conversationId,
  message,
  channel: 'voice' as const,
});

/** A scripted step that notes when the model call began. */
function stamped(step: ScriptStep, into: number[]): ScriptStep {
  return (req) => {
    into.push(Date.now());
    return typeof step === 'function' ? step(req) : step;
  };
}

const spoken = (events: TurnEvent[]) =>
  events.flatMap((e) => (e.type === 'agent.text.delta' ? [e.text] : [])).join('');

describe('starting the answer early', () => {
  it('begins the model call while the classifier is still working, and speaks only afterwards', async () => {
    h.llm.timing.classifyDelayMs = 200;
    const startedAt: number[] = [];
    h.llm.script(stamped(say('Happy to help with that.'), startedAt));
    const events: { at: number; e: TurnEvent }[] = [];
    const t0 = Date.now();
    await h.chat.chat(ask('I have a question about my trip'), {
      onEvent: (e) => events.push({ at: Date.now() - t0, e }),
    });

    expect(startedAt[0]! - t0).toBeLessThan(120); // the model did not wait for the 200 ms classification
    const firstWord = events.find((x) => x.e.type === 'agent.text.delta')!;
    expect(firstWord.at).toBeGreaterThanOrEqual(190); // but nothing was said before it came back
  });

  it('is sequential when switched off', async () => {
    const off = await createHarness({
      env: { AGENT_SPECULATIVE: 'off' },
      classify: () => ({ intent: 'rebooking' }),
    });
    off.llm.timing.classifyDelayMs = 200;
    const startedAt: number[] = [];
    off.llm.script(stamped(say('Happy to help with that.'), startedAt));
    const t0 = Date.now();
    await off.chat.chat(ask('I have a question about my trip'));
    expect(startedAt[0]! - t0).toBeGreaterThanOrEqual(190);
    await off.close();
  });

  it('does not start early when a change is waiting for approval', async () => {
    h.llm.script(
      callTool('verify_customer', { bookingRef: 'SK1001', lastName: 'Rahman' }),
      callTool('search_alternatives', { bookingRef: 'SK1001' }),
      say('Here are your options.'),
    );
    const first = await h.chat.chat(ask('SK1001 Rahman, my flight was cancelled'));
    h.llm.reset();
    h.llm.script(
      (req) => ({
        toolCalls: [
          {
            id: '',
            name: 'change_flight',
            input: {
              bookingRef: 'SK1001',
              newFlightId: /"flightId":"([^"]+)"/.exec(req.system)?.[1],
            },
          },
        ],
      }),
      say('I can move you to that flight. Say yes to confirm.'),
    );
    await h.chat.chat(ask('The first option please', first.conversationId));

    // now a change is waiting: what the model is told depends on the classification (yes / no)
    h.llm.reset();
    h.llm.timing.classifyDelayMs = 200;
    const startedAt: number[] = [];
    h.llm.script(stamped(say('Done.'), startedAt));
    const t0 = Date.now();
    await h.chat.chat(ask('Yes, please go ahead and book it for me', first.conversationId));
    expect(startedAt[0]! - t0).toBeGreaterThanOrEqual(190);
  });
});

describe('what an early answer can never do', () => {
  it('cannot run a tool or say a word when the classification sends the customer to a person', async () => {
    const angry = await createHarness({ classify: () => ({ sentiment: 'angry' }) });
    angry.llm.timing.classifyDelayMs = 150;
    angry.llm.script(
      callTool(
        'verify_customer',
        { bookingRef: 'SK1001', lastName: 'Rahman' },
        'Sure, let me look that up.',
      ),
    );
    const events: TurnEvent[] = [];
    const res = await angry.chat.chat(ask('This is ridiculous'), {
      onEvent: (e) => events.push(e),
    });

    expect(res.handoff).toBeDefined();
    expect(res.trace.some((t) => t.type === 'tool')).toBe(false);
    expect(events.some((e) => e.type === 'tool.started')).toBe(false);
    expect(spoken(events)).not.toContain('let me look that up');
    expect(spoken(events).trim()).toBe(res.reply.trim());
    await angry.close();
  });

  it('cannot answer a policy question the documents do not cover', async () => {
    const policy = await createHarness({
      ingestKnowledge: true,
      classify: () => ({ intent: 'baggage_policy', isPolicyQuestion: true }),
    });
    policy.llm.script(say('Yes, rockets are free on Tuesdays!'));
    const events: TurnEvent[] = [];
    // a statement, so only the classification (not the shape of a question) can refuse it
    const res = await policy.chat.chat(ask('Tell me about your rocket rides to the moon'), {
      onEvent: (e) => events.push(e),
    });
    expect(res.reply).toMatch(/not sure/i);
    expect(spoken(events)).not.toContain('rockets are free');
    await policy.close();
  });

  it('stops everything when the customer interrupts during the early call', async () => {
    h.llm.timing.classifyDelayMs = 100;
    h.llm.script({ delayMs: 400, text: 'This is a long answer that should never be spoken.' });
    const controller = new AbortController();
    const events: TurnEvent[] = [];
    const run = h.chat.chat(ask('I have a question about my trip'), {
      onEvent: (e) => events.push(e),
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 60);
    const res = await run;
    expect(res.cancelled).toBe(true);
    expect(events.some((e) => e.type === 'agent.text.delta')).toBe(false);
  });
});

describe('time is recorded where it is spent', () => {
  it('shows the model call overlapping the classification', async () => {
    h.llm.timing.classifyDelayMs = 150;
    h.llm.script(say('Hi, how can I help?'));
    const res = await h.chat.chat(ask('I have a question about my trip'));
    const understand = res.timings!.stages.find((s) => s.stage === 'understand')!;
    const model = res.timings!.stages.find((s) => s.stage === 'llm')!;
    expect(understand.ms).toBeGreaterThanOrEqual(140);
    expect(model.startMs).toBeLessThan(understand.startMs + understand.ms); // began before understanding ended
    expect(model.startMs).toBeLessThan(60); // it did not wait for the classification
    expect(res.timings!.totalMs).toBeLessThan(understand.ms + 40); // so the model's time hid inside the wait
  });
});

describe('timing summary', () => {
  it('puts a plain-language line in the trace and the stages in the response', async () => {
    h.llm.script(say('Hello!'));
    const res = await h.chat.chat(ask('I have a question about my trip'));
    const line = res.trace.find((t) => t.type === 'timing')!;
    expect(line.label).toMatch(/^Where the time went: .*\(turn \d+(\.\d)? (ms|s)\)$/);
    expect((line.detail as { stages: unknown[] }).stages.length).toBeGreaterThanOrEqual(2);
    expect(res.timings!.stages.map((s) => s.stage)).toEqual(
      expect.arrayContaining(['understand', 'llm']),
    );
  });

  it('records the time a model call spent waiting for the provider limit, not as model time', async () => {
    const { describeTimings } = await import('@backend/agent/loop');
    const text = describeTimings({
      totalMs: 4200,
      stages: [
        { stage: 'understand', label: 'x', startMs: 0, ms: 700 },
        { stage: 'llm', label: 'x', startMs: 0, ms: 2500, rateLimitMs: 1800 },
        { stage: 'tool', label: 'get_booking', startMs: 2500, ms: 90 },
      ],
    });
    expect(text).toBe(
      'Where the time went: understanding 700 ms, model 2.5 s, tools 90 ms (turn 4.2 s)',
    );
  });
});
