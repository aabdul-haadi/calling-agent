import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { resolve } from 'node:path';
import { REPO_ROOT } from '@backend/config/repo-root';
import { loadScenarios, runDeterministicChecks, runScenario, scenarioSchema, type Scenario } from '@backend/evals';
import { skylinkModule } from '@clients/skylink-air';
import { createHarness, say, callTool, type Harness } from '../helpers/harness';

const scenarioDir = resolve(REPO_ROOT, 'clients/skylink-air/scenarios');

describe('SkyLink scenario files', () => {
  it('has 20 valid scenarios covering the required cases', async () => {
    const scenarios = await loadScenarios(scenarioDir);
    expect(scenarios).toHaveLength(20);
    const ids = scenarios.map((s) => s.id).join(' ');
    for (const needle of ['happy-path', 'unverified', 'injection', 'api-down', 'duplicate', 'multi-intent', 'angry', 'out-of-scope', 'unknown-policy']) {
      expect(ids).toContain(needle);
    }
  });

  it('only reference tools that exist for the client', async () => {
    const tools = new Set(skylinkModule.config.tools);
    for (const s of await loadScenarios(scenarioDir)) {
      for (const t of [...s.expectedTools, ...s.forbiddenTools, ...Object.keys(s.maxToolSuccesses)]) {
        expect(tools.has(t), `${s.id} references unknown tool ${t}`).toBe(true);
      }
    }
  });

  it('rejects malformed scenarios', () => {
    expect(scenarioSchema.safeParse({ id: 'Bad Id', title: 'x' }).success).toBe(false);
  });
});

const base: Scenario = scenarioSchema.parse({
  id: 's', title: 't', persona: 'p', turns: ['hi'], expectedOutcome: 'o',
});

describe('deterministic checks', () => {
  const obs = (tools: [string, boolean][], replies = ['hello'], handedOff = false) => ({
    replies, tools: tools.map(([tool, ok]) => ({ tool, ok })), handedOff,
  });

  it('expected tools must appear in order (as a subsequence)', () => {
    const s = { ...base, expectedTools: ['a', 'b'] };
    expect(runDeterministicChecks(s, obs([['a', true], ['x', true], ['b', true]]))).toEqual([]);
    expect(runDeterministicChecks(s, obs([['b', true], ['a', true]]))).toHaveLength(1);
    expect(runDeterministicChecks(s, obs([['a', true], ['b', false]]))).toHaveLength(1); // failed calls do not count
  });

  it('forbidden tools may be attempted but must never succeed', () => {
    const s = { ...base, forbiddenTools: ['change_flight'] };
    expect(runDeterministicChecks(s, obs([['change_flight', false]]))).toEqual([]);
    expect(runDeterministicChecks(s, obs([['change_flight', true]]))[0]).toMatch(/rule violation/);
  });

  it('caps successful calls, scans phrases and checks handoff expectations', () => {
    expect(runDeterministicChecks({ ...base, maxToolSuccesses: { change_flight: 1 } }, obs([['change_flight', true], ['change_flight', true]]))[0]).toMatch(/max 1/);
    expect(runDeterministicChecks({ ...base, forbiddenPhrases: ['SECRET'] }, obs([], ['the secret is out']))).toHaveLength(1);
    expect(runDeterministicChecks({ ...base, expectHandoff: true }, obs([], ['x'], false))[0]).toMatch(/Expected a handoff/);
    expect(runDeterministicChecks({ ...base, expectHandoff: false }, obs([], ['x'], true))[0]).toMatch(/Unexpected handoff/);
  });
});

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());
beforeEach(() => h.llm.reset());

describe('scenario runner', () => {
  const rebook: Scenario = {
    ...base,
    id: 'mini-rebook',
    turns: ['Rahman SK1001 my flight was cancelled', 'yes the first one'],
    expectedTools: ['verify_customer', 'get_booking', 'search_alternatives', 'change_flight'],
    maxToolSuccesses: { change_flight: 1 },
  };

  const script = () =>
    h.llm.script(
      callTool('verify_customer', { bookingRef: 'SK1001', lastName: 'Rahman' }),
      callTool('get_booking', { bookingRef: 'SK1001' }),
      callTool('search_alternatives', { bookingRef: 'SK1001' }),
      say('Here are your options.'),
      (req) => ({ toolCalls: [{ id: '', name: 'change_flight', input: { bookingRef: 'SK1001', newFlightId: /"flightId":"([^"]+)"/.exec(req.system)?.[1], customerConfirmed: true } }] }),
      say('You are rebooked.'),
    );

  it('passes when tools are right and the judge agrees', async () => {
    await fetch(`${h.mockUrl}/admin/reset`, { method: 'POST' });
    script();
    const r = await runScenario({ chat: h.evalChat, llm: h.llm.client, clientId: 'skylink-air' }, rebook);
    expect(r.failures).toEqual([]);
    expect(r.passed).toBe(true);
    expect(r.toolsCalled).toEqual(['verify_customer', 'get_booking', 'search_alternatives', 'change_flight']);
    expect(r.transcript).toHaveLength(4);
  });

  it('fails with the judge reason written down when the judge disagrees', async () => {
    await fetch(`${h.mockUrl}/admin/reset`, { method: 'POST' });
    script();
    h.llm.judgeVerdict.pass = false;
    h.llm.judgeVerdict.reason = 'Agent was rude.';
    const r = await runScenario({ chat: h.evalChat, llm: h.llm.client, clientId: 'skylink-air' }, rebook);
    expect(r.passed).toBe(false);
    expect(r.failures).toContain('Judge: Agent was rude.');
    expect(r.judgeReason).toBe('Agent was rude.');
  });

  it('fails deterministic checks even if the judge is happy', async () => {
    h.llm.script(say('Sure, I will do it.'));
    const r = await runScenario({ chat: h.evalChat, llm: h.llm.client, clientId: 'skylink-air' }, { ...base, turns: ['hi'], expectedTools: ['change_flight'] });
    expect(r.passed).toBe(false);
    expect(r.failures[0]).toMatch(/Expected tools in order/);
  });

  it('handoffs raised during tests do not appear in the human inbox', async () => {
    h.llm.script(callTool('transfer_to_human', { reason: 'customer wants a person' }), say('Connecting you.'));
    const before = (await request(h.app).get('/handoffs')).body.data.length;
    const r = await runScenario({ chat: h.evalChat, llm: h.llm.client, clientId: 'skylink-air' }, { ...base, turns: ['I need to talk to a person'], expectHandoff: true });
    expect(r.failures.filter((f) => !f.startsWith('Judge'))).toEqual([]);
    expect((await request(h.app).get('/handoffs')).body.data.length).toBe(before);
  });

  it('test routes validate input', async () => {
    expect((await request(h.app).post('/tests/run').send({})).status).toBe(400);
    expect((await request(h.app).post('/tests/run').send({ clientId: 'nope' })).status).toBe(404);
    expect((await request(h.app).get('/tests/runs')).status).toBe(400);
    expect((await request(h.app).get('/tests/runs/00000000-0000-0000-0000-000000000000')).status).toBe(404);
  });
});
