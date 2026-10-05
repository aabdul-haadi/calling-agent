import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { clientConfigSchema } from '@adk/shared';
import { signPayload } from '@backend/tools/security';
import { evaluatePostTurn, evaluatePreTurn, deliverHandoff } from '@backend/handoff';
import { newState } from '@backend/agent/state';
import { skylinkAir } from '@clients/skylink-air/client.config';
import { createMockApp, defaultOptions } from '../../mock-services/src/app';
import { createHarness, say, callTool, type Harness } from '../helpers/harness';

const config = clientConfigSchema.parse(skylinkAir);
const base = { intent: 'rebooking', sentiment: 'neutral' as const, wantsHuman: false, isPolicyQuestion: false };

describe('handoff triggers (pure)', () => {
  it('user asks for a human', () => {
    expect(evaluatePreTurn(config, { ...base, wantsHuman: true })).toBe('user_request');
    expect(evaluatePreTurn({ ...config, escalation: { ...config.escalation, onUserRequest: false } }, { ...base, wantsHuman: true })).toBeNull();
  });
  it('frustration at or above the threshold', () => {
    expect(evaluatePreTurn(config, { ...base, sentiment: 'frustrated' })).toBe('frustration');
    expect(evaluatePreTurn(config, { ...base, sentiment: 'angry' })).toBe('frustration');
    expect(evaluatePreTurn(config, { ...base, sentiment: 'neutral' })).toBeNull();
  });
  it('always-escalate intents', () => {
    expect(evaluatePreTurn(config, { ...base, intent: 'lost_baggage_claim' })).toBe('always_escalate_intent');
    expect(evaluatePreTurn(config, { ...base, intent: 'complaint' })).toBe('always_escalate_intent');
  });
  it('post-turn: failed turns, tool unavailable twice, loop guard, agent request, AI down', () => {
    const s = newState(config);
    const none = { loopGuardHit: false, aiUnavailable: false };
    expect(evaluatePostTurn(config, s, none)).toBeNull();
    expect(evaluatePostTurn(config, { ...s, failedTurns: 1 }, none)).toBeNull();
    expect(evaluatePostTurn(config, { ...s, failedTurns: 2 }, none)).toBe('failed_turns');
    expect(evaluatePostTurn(config, { ...s, unavailableStreak: 2 }, none)).toBe('tool_unavailable');
    expect(evaluatePostTurn(config, s, { ...none, loopGuardHit: true })).toBe('loop_guard');
    expect(evaluatePostTurn(config, s, { ...none, aiUnavailable: true })).toBe('ai_unavailable');
    expect(evaluatePostTurn(config, { ...s, pendingHandoff: { reason: 'x' } }, none)).toBe('agent_requested');
  });
});

let h: Harness;
beforeAll(async () => {
  h = await createHarness({
    classify: (m) => {
      if (/talk to a (person|human)/i.test(m)) return { wantsHuman: true };
      if (/furious|ridiculous/i.test(m)) return { sentiment: 'angry' };
      if (/lost my bag|bag is lost/i.test(m)) return { intent: 'lost_baggage_claim' };
      return {};
    },
  });
});
afterAll(() => h.close());
beforeEach(() => h.llm.reset());

describe('handoff end-to-end', () => {
  it('trigger: user asks for a human (skips the agent loop, still apologises politely)', async () => {
    const res = await h.chat.chat({ clientId: 'skylink-air', message: 'I want to talk to a person' });
    expect(res.handoff?.reason).toMatch(/asked for a human/i);
    expect(res.reply).toMatch(/human colleague/);
    expect(h.llm.calls).toHaveLength(0);
  });

  it('trigger: frustrated customer', async () => {
    const res = await h.chat.chat({ clientId: 'skylink-air', message: 'This is ridiculous, I am furious' });
    expect(res.handoff?.reason).toMatch(/frustrated/i);
    expect(res.handoff?.sentiment).toBe('angry');
  });

  it('trigger: always-escalate intent', async () => {
    const res = await h.chat.chat({ clientId: 'skylink-air', message: 'I lost my bag at the airport' });
    expect(res.handoff?.reason).toMatch(/always goes to a human/i);
  });

  it('trigger: two failed turns in a row', async () => {
    h.llm.script(
      callTool('verify_customer', { bookingRef: 'SK1007', lastName: 'Wrong' }),
      say('Those details do not match. Could you try again?'),
      callTool('verify_customer', { bookingRef: 'SK1007', lastName: 'Wrong2' }),
      say('Still no match.'),
    );
    const t1 = await h.chat.chat({ clientId: 'skylink-air', message: 'SK1007 Wrong' });
    expect(t1.handoff).toBeUndefined();
    const t2 = await h.chat.chat({ clientId: 'skylink-air', conversationId: t1.conversationId, message: 'SK1007 Wrong2' });
    expect(t2.handoff?.reason).toMatch(/repeated attempts/i);
  });

  it('trigger: agent decides via transfer_to_human', async () => {
    h.llm.script(callTool('transfer_to_human', { reason: 'refund dispute' }), say('I will connect you.'));
    const res = await h.chat.chat({ clientId: 'skylink-air', message: 'I need a refund for my loyalty points' });
    expect(res.handoff?.reason).toMatch(/human should take over/i);
  });

  it('summary has 3 lines, intent, verified status and what was tried, with no raw PII', async () => {
    h.llm.script(
      callTool('verify_customer', { bookingRef: 'SK1009', lastName: 'Petrov' }),
      callTool('get_booking', { bookingRef: 'SK1009' }),
      callTool('transfer_to_human', { reason: 'wants compensation' }),
      say('Transferring you.'),
    );
    const res = await h.chat.chat({ clientId: 'skylink-air', message: 'Petrov SK1009, I want compensation, call me on +1 555 010 0042' });
    const s = res.handoff!.summary;
    expect(s.lines).toHaveLength(3);
    expect(s.intent).toBe('rebooking');
    expect(s.verified).toBe(true);
    expect(s.tried).toEqual([
      'Checked identity — Identity verified',
      'Checked the booking system — Flight is on schedule',
      'Requested a human agent — Transfer requested',
    ]);
    const everything = JSON.stringify(res.handoff);
    expect(everything).not.toContain('Petrov');
    expect(everything).not.toContain('555 010');
    expect(everything).not.toContain('SK1009');
    expect(res.handoff!.customerMasked).toMatch(/\*\*\*/);
  });

  it('delivers a signed webhook to the contact-center queue', async () => {
    const res = await h.chat.chat({ clientId: 'skylink-air', message: 'talk to a human please' });
    const queue = await (await fetch(`${h.mockUrl}/contact-center/handoffs`)).json() as { data: { eventId: string; status: string }[] };
    expect(queue.data.some((i) => i.eventId === res.handoff!.id)).toBe(true);
    const list = await request(h.app).get('/handoffs').query({ clientId: 'skylink-air' });
    expect(list.body.data.some((i: { id: string }) => i.id === res.handoff!.id)).toBe(true);
    const accepted = await request(h.app).post(`/handoffs/${res.handoff!.id}/accept`);
    expect(accepted.body.data.status).toBe('accepted');
  });
});

describe('contact-center webhook security', () => {
  const secret = 'test-webhook-secret';
  const body = JSON.stringify({ hello: 'world' });
  const app = createMockApp(defaultOptions({ webhookSecret: secret }));
  const post = (headers: Record<string, string>, payload = body) =>
    request(app).post('/contact-center/handoffs').set('content-type', 'application/json').set(headers).send(payload);
  const signed = (id: string, ts = String(Date.now())) => ({
    'x-event-id': id,
    'x-timestamp': ts,
    'x-signature': signPayload(secret, ts, body),
  });

  it('rejects bad signatures', async () => {
    const res = await post({ ...signed('e1'), 'x-signature': 'deadbeef' });
    expect(res.status).toBe(401);
  });

  it('rejects a signature made with the wrong secret and tampered bodies', async () => {
    const ts = String(Date.now());
    expect((await post({ 'x-event-id': 'e2', 'x-timestamp': ts, 'x-signature': signPayload('wrong', ts, body) })).status).toBe(401);
    expect((await post(signed('e3'), JSON.stringify({ hello: 'tampered' }))).status).toBe(401);
  });

  it('rejects stale timestamps (replay)', async () => {
    const res = await post(signed('e4', String(Date.now() - 10 * 60_000)));
    expect(res.status).toBe(401);
  });

  it('accepts a valid event once and ignores duplicates', async () => {
    const first = await post(signed('dup-1'));
    const second = await post(signed('dup-1'));
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.data.duplicate).toBe(true);
    const queue = await request(app).get('/contact-center/handoffs');
    expect(queue.body.data.filter((i: { eventId: string }) => i.eventId === 'dup-1')).toHaveLength(1);
  });

  it('the sender treats 2xx (including duplicates) as delivered and 4xx as not', async () => {
    const ok = await deliverHandoff(
      { id: 'send-1', conversationId: 'c', clientId: 'x', reason: 'r', summary: { lines: ['a', 'b', 'c'], intent: 'i', verified: false, tried: [] }, sentiment: 'neutral', customerMasked: 'm', status: 'pending', createdAt: new Date().toISOString() },
      { url: 'http://x/y', secret, fetchImpl: async () => new Response('{}', { status: 200 }) },
    );
    expect(ok).toBe(true);
    let calls = 0;
    const bad = await deliverHandoff(
      { id: 'send-2', conversationId: 'c', clientId: 'x', reason: 'r', summary: { lines: ['a', 'b', 'c'], intent: 'i', verified: false, tried: [] }, sentiment: 'neutral', customerMasked: 'm', status: 'pending', createdAt: new Date().toISOString() },
      { url: 'http://x/y', secret, fetchImpl: async () => { calls++; return new Response('{}', { status: 401 }); } },
    );
    expect(bad).toBe(false);
    expect(calls).toBe(1); // no retry on a 4xx
  });
});

