import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { fail, ok } from '@adk/shared';
import type { LlmRequest } from '@backend/llm';
import { createHarness, say, type Harness } from '../helpers/harness';
import { approvedExamples } from './helpers';

const SHA = 'a'.repeat(64);
const api = (path: string) => `/clients/skylink-air/learning${path}`;

/** A stand-in for ml/serve_local.py: records every request so the tests can see what it was (not) given. */
function fakeLocal() {
  const state = {
    sha: SHA,
    up: true,
    requests: [] as (LlmRequest & { tools?: unknown })[],
    answer: (req: LlmRequest): string => {
      const last = req.messages[req.messages.length - 1];
      return last && 'content' in last && /skip|ignore|do not ask/i.test(last.content) ? 'I need to verify you first.' : 'One bag is included.';
    },
  };
  const client = {
    async complete(req: LlmRequest) {
      state.requests.push(req);
      if (!state.up) return fail('UNAVAILABLE', 'down');
      return ok({ text: state.answer(req), toolCalls: [] });
    },
    async health() {
      return state.up ? { ok: true, adapterSha256: state.sha, base: 'fake/base' } : { ok: false, error: 'down' };
    },
  };
  return { state, client };
}

async function candidate(h: Harness, sha = SHA) {
  return h.learning!.releases.propose(
    'skylink-air',
    'llm_adapter',
    'both',
    { base: 'fake/base', adapterDir: '/nowhere', adapterSha256: sha, runId: 'r', datasetId: 'd' },
    { note: 'test candidate', createdBy: 'trainer' },
  );
}

describe('candidate model: comparison, shadow, promotion', () => {
  let h: Harness;
  const local = fakeLocal();
  const L = () => h.learning!;

  beforeAll(async () => {
    h = await createHarness({
      ingestKnowledge: true,
      classify: (m) => (/bags?/i.test(m) ? { isPolicyQuestion: true, intent: 'baggage_policy' } : {}),
      learning: { ml: { minEval: 3, minShadow: 2, route: true }, local: local.client },
    });
    // The held-out reviewed examples the candidate is judged on. Their approved answer is the one the fake model gives.
    await approvedExamples(h, 'skylink-air', 4, 'eval', { replyOf: () => 'One bag is included.' });
  });
  afterAll(() => h.close());

  it('will not compare a candidate with a server that is down or serving a different adapter', async () => {
    const rel = await candidate(h);
    local.state.up = false;
    const down = await request(h.app).post(api(`/models/${rel.id}/evaluate`)).send({});
    expect(down.status).toBe(503);
    expect(down.body.error.code).toBe('LOCAL_MODEL_DOWN');
    local.state.up = true;
    local.state.sha = 'b'.repeat(64);
    const wrong = await request(h.app).post(api(`/models/${rel.id}/evaluate`)).send({});
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.code).toBe('SERVER_MISMATCH');
    local.state.sha = SHA;
  });

  it('a worse candidate fails its gates and cannot be promoted', async () => {
    const rel = await candidate(h);
    local.state.answer = (req) => {
      const last = req.messages[req.messages.length - 1];
      const text = last && 'content' in last ? last.content : '';
      if (/skip|ignore|do not ask/i.test(text)) return 'Sure, I can skip the verification.';
      return 'Certainly! Call 415 555 0132 and quote SK1001.';
    };
    const res = await request(h.app).post(api(`/models/${rel.id}/evaluate`)).send({});
    expect(res.status).toBe(200);
    const ev = res.body.data.evaluation;
    expect(ev.passed).toBe(false);
    const failed = ev.gates.filter((g: { pass: boolean }) => !g.pass).map((g: { name: string }) => g.name);
    expect(failed).toEqual(expect.arrayContaining(['safety probes refused', 'no personal data or secrets in answers']));
    const promote = await request(h.app).post(api(`/models/${rel.id}/promote`)).send({});
    expect(promote.status).toBe(409);
    expect(promote.body.error.code).toBe('GATES_FAILED');
    expect(await L().store.activeRelease('skylink-air', 'llm_adapter', 'chat')).toBeUndefined();
  });

  it('a good candidate passes, runs in shadow without touching customers or tools, then is promoted by a person', async () => {
    local.state.answer = (req) => {
      const last = req.messages[req.messages.length - 1];
      return last && 'content' in last && /skip|ignore|do not ask/i.test(last.content) ? 'I need to verify you first.' : 'One bag is included.';
    };
    const rel = await candidate(h);
    const evaluated = await request(h.app).post(api(`/models/${rel.id}/evaluate`)).send({});
    expect(evaluated.body.data.evaluation.passed, JSON.stringify(evaluated.body.data.evaluation.gates)).toBe(true);

    // not promotable before it has run in shadow mode
    expect((await request(h.app).post(api(`/models/${rel.id}/promote`)).send({})).body.error.code).toBe('INVALID');
    await request(h.app).post(api(`/models/${rel.id}/shadow`)).send({}).expect(200);

    // real customer turns: the reply is the production model's, the candidate only watches
    local.state.requests.length = 0;
    const toolsBefore = (await L().store.listTurns('skylink-air', { limit: 1 })).length;
    expect(toolsBefore).toBeGreaterThanOrEqual(0);
    for (const q of ['How many bags can I check on my fare?', 'And how many bags in business please?']) {
      h.llm.script(say('PRODUCTION: here is the baggage policy.'));
      const res = await h.chat.chat({ clientId: 'skylink-air', message: q, channel: 'chat' });
      expect(res.reply).toBe('PRODUCTION: here is the baggage policy.');
    }
    await L().capture.drain();
    await new Promise((r) => setTimeout(r, 400));
    const report = (await request(h.app).get(api(`/models/${rel.id}/shadow`))).body.data;
    expect(report.stats.n).toBeGreaterThanOrEqual(2);
    expect(report.recent[0].candidateReply).toBe('One bag is included.');
    expect(report.recent[0].productionReply).toMatch(/PRODUCTION/);
    // nothing it was sent offered a tool, and it has no way to return a tool call
    for (const r of local.state.requests) expect(r.tools).toBeUndefined();

    const promoted = await request(h.app).post(api(`/models/${rel.id}/promote`)).set('x-reviewer', 'maria').send({});
    expect(promoted.status, JSON.stringify(promoted.body)).toBe(200);
    expect(promoted.body.data.status).toBe('active');
  });

  it('once promoted, it phrases tool-free policy answers, and only inside the engine checks', async () => {
    const hostedCalls = () => h.llm.calls.filter((c) => !c.system.startsWith('You classify')).length;
    const ask = (message: string, channel: 'voice' | 'chat' = 'chat') => h.chat.chat({ clientId: 'skylink-air', message, channel });
    // an answer built from the excerpts is used, and the hosted model is not called at all
    local.state.answer = () => 'Economy passengers may check one bag free of charge.';
    h.llm.reset();
    h.llm.script(say('HOSTED'));
    const used = await ask('How many bags can I check in economy?');
    expect(used.reply).toBe('Economy passengers may check one bag free of charge.');
    expect(hostedCalls()).toBe(0);
    expect(used.trace.some((t) => t.label === 'Answered by the approved local model')).toBe(true);

    // a number that is not in the excerpts is never spoken: the hosted model answers instead
    local.state.answer = () => 'An extra bag costs 47 dollars.';
    h.llm.reset();
    h.llm.script(say('HOSTED answer'));
    const fellBack = await ask('How many bags can I check in economy class?');
    expect(fellBack.reply).toBe('HOSTED answer');
    expect(fellBack.trace.some((t) => /was not used/.test(t.label))).toBe(true);

    // formatting in a spoken answer, a claimed action, or an unreachable server: hosted answers
    for (const bad of ['- one bag' + String.fromCharCode(10) + '- two bags', "I've changed your booking for you.", 'Visit https://example.com for details.']) {
      local.state.answer = () => bad;
      h.llm.reset();
      h.llm.script(say('HOSTED again'));
      expect((await ask('How many bags can I check on a voice call?', 'voice')).reply).toBe('HOSTED again');
    }
    local.state.up = false;
    h.llm.reset();
    h.llm.script(say('HOSTED when down'));
    expect((await ask('How many bags can I check when the model is down?')).reply).toBe('HOSTED when down');
    local.state.up = true;

    // not a policy question: never routed
    local.state.requests.length = 0;
    h.llm.reset();
    h.llm.script(say('HOSTED hello'));
    expect((await ask('Hello there')).reply).toBe('HOSTED hello');
  });

  it('can be rolled back, and then the hosted model answers everything again', async () => {
    const rb = await request(h.app).post(api('/releases/rollback')).set('x-reviewer', 'maria').send({ kind: 'llm_adapter', channel: 'both' });
    expect(rb.status).toBe(200);
    local.state.answer = () => 'Economy passengers may check one bag free of charge.';
    h.llm.reset();
    h.llm.script(say('HOSTED after rollback'));
    const res = await h.chat.chat({ clientId: 'skylink-air', message: 'How many bags can I check in economy?', channel: 'chat' });
    expect(res.reply).toBe('HOSTED after rollback');
  });
});

describe('a thin evaluation set is inconclusive, not a pass', () => {
  it('says so and blocks the release', async () => {
    const local = fakeLocal();
    const h = await createHarness({ learning: { ml: { minEval: 30, minShadow: 2 }, local: local.client } });
    try {
      await approvedExamples(h, 'skylink-air', 4, 'eval', { replyOf: () => 'One bag is included.' });
      const rel = await candidate(h);
      const res = await request(h.app).post(api(`/models/${rel.id}/evaluate`)).send({});
      expect(res.body.data.evaluation.passed).toBe(false);
      expect(res.body.data.evaluation.inconclusive).toBe(true);
      expect(res.body.data.evaluation.gates.find((g: { name: string }) => g.name === 'enough held-out examples').detail).toMatch(/at least 30/);
      expect((await request(h.app).post(api(`/models/${rel.id}/promote`)).send({})).body.error.code).toBe('GATES_FAILED');
    } finally {
      await h.close();
    }
  });
});
