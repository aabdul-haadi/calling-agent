import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { classifyPlainMessage } from '@backend/agent/classify';
import { callTool, createHarness, say, type Harness, type ScriptStep } from '../helpers/harness';

const PENDING = 'Move booking SK1001 to flight SK110';

describe('plain messages are answered by rules', () => {
  it.each([
    'yes',
    'Yes.',
    'yeah',
    'go ahead',
    'Yes, go ahead',
    'confirm',
    'sounds good',
    'yes please',
  ])('"%s" approves only when a change is waiting', (m) => {
    expect(classifyPlainMessage(m, PENDING, 'rebooking')?.confirmation).toBe('yes');
    expect(classifyPlainMessage(m, undefined, 'rebooking')).toBeUndefined(); // nothing to approve: the model decides
  });

  it.each(['no', 'nope', 'No thanks', 'never mind', 'not now'])(
    '"%s" declines a waiting change',
    (m) => {
      expect(classifyPlainMessage(m, PENDING, 'rebooking')?.confirmation).toBe('no');
    },
  );

  it.each(['hi', 'Hello there', 'thanks', 'Thank you!', 'ok', 'good morning', 'bye'])(
    '"%s" is small talk',
    (m) => {
      const c = classifyPlainMessage(m, undefined, 'rebooking')!;
      expect(c).toMatchObject({
        confirmation: 'none',
        wantsHuman: false,
        isPolicyQuestion: false,
        sentiment: 'neutral',
      });
    },
  );

  it.each([
    'yes, but make it the evening flight',
    'yes I want to talk to a person',
    'no I want a human',
    'yes and also what is the baggage allowance',
    'thanks but this is ridiculous',
    'hi I want to cancel my plan',
    'ok so what happens now',
    '',
    'y'.repeat(60),
  ])('"%s" still goes to the model', (m) => {
    expect(classifyPlainMessage(m, PENDING, 'rebooking')).toBeUndefined();
    expect(classifyPlainMessage(m, undefined, 'rebooking')).toBeUndefined();
  });

  it('keeps the intent already understood, so the progress of the journey does not reset', () => {
    expect(classifyPlainMessage('yes', PENDING, 'flight_cancelled')?.intent).toBe(
      'flight_cancelled',
    );
  });
});

describe('in a conversation', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ classify: () => ({ intent: 'rebooking' }) });
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
  });

  const pick: ScriptStep = (req) => ({
    toolCalls: [
      {
        id: '',
        name: 'change_flight',
        input: { bookingRef: 'SK1001', newFlightId: /"flightId":"([^"]+)"/.exec(req.system)?.[1] },
      },
    ],
  });

  it('a greeting costs no classification call', async () => {
    h.llm.script(say('Hi! How can I help?'));
    await h.chat.chat(ask('Hi'));
    expect(h.llm.timing.classifyCalls).toBe(0);
    h.llm.script(say('Of course.'));
    await h.chat.chat(ask('I want to cancel my flight please'));
    expect(h.llm.timing.classifyCalls).toBe(1);
  });

  it('a bare "yes" approves the waiting change exactly like a classified one, and changes it once', async () => {
    h.llm.script(
      callTool('verify_customer', { bookingRef: 'SK1001', lastName: 'Rahman' }),
      callTool('search_alternatives', { bookingRef: 'SK1001' }),
      say('Here are your options.'),
    );
    const first = await h.chat.chat(ask('SK1001 Rahman, my flight was cancelled'));
    h.llm.script(pick, say('I can move you to that flight. Say yes to confirm.'));
    const proposed = await h.chat.chat(ask('The first one please', first.conversationId));
    expect(proposed.state.pendingApproval).toBeDefined();

    const before = h.llm.timing.classifyCalls;
    h.llm.script(pick, say('Done, you are on the new flight.'));
    const done = await h.chat.chat(ask('Yes', first.conversationId));
    expect(h.llm.timing.classifyCalls).toBe(before); // decided by rules
    expect(done.trace.some((t) => t.type === 'approval' && /approved/i.test(t.label))).toBe(true);
    const executed = done.trace.filter((t) => {
      const d = t.detail as { tool?: string; awaitingApproval?: boolean } | undefined;
      return (
        t.type === 'tool' && d?.tool === 'change_flight' && !d.awaitingApproval && t.status === 'ok'
      );
    });
    expect(executed).toHaveLength(1);
  });

  it('"yes, but" is not an approval: the model reads it', async () => {
    h.llm.script(
      callTool('verify_customer', { bookingRef: 'SK1001', lastName: 'Rahman' }),
      callTool('search_alternatives', { bookingRef: 'SK1001' }),
      say('Here are your options.'),
    );
    const first = await h.chat.chat(ask('SK1001 Rahman, my flight was cancelled'));
    h.llm.script(pick, say('I can move you to that flight. Say yes to confirm.'));
    await h.chat.chat(ask('The first one please', first.conversationId));
    const before = h.llm.timing.classifyCalls;
    h.llm.script(say('Which flight would you prefer instead?'));
    await h.chat.chat(ask('Yes, but make it the evening one', first.conversationId));
    expect(h.llm.timing.classifyCalls).toBe(before + 1);
  });

  it('can be switched off', async () => {
    const off = await createHarness({ env: { AGENT_FAST_CLASSIFY: 'off' }, classify: () => ({}) });
    off.llm.script(say('Hi!'));
    await off.chat.chat(ask('Hi'));
    expect(off.llm.timing.classifyCalls).toBe(1);
    await off.close();
  });
});
