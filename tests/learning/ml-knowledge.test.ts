import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { extractorPython } from '@backend/knowledge';
import { createHarness, say, type Harness } from '../helpers/harness';
import type { TurnInput } from '@backend/learning';
import { makePdf } from './helpers';

const CORPUS = resolve(__dirname, '../../docproc/tests/corpus');
const haveReader = Boolean(extractorPython()) && existsSync(resolve(CORPUS, 'facts.json'));
const pdf = (name: string) => readFile(resolve(CORPUS, `${name}.pdf`));
const NARROW = 'nova-plus-prices.pdf';
const narrowPdf = () =>
  makePdf(['Nova Plus plan prices', 'The Nova Plus plan costs 35 dollars per month.', 'Nova Plus includes unlimited calls and 20 GB of data each month.']);
const api = (client: string, path: string) => `/clients/${client}/learning${path}`;

const QUESTIONS = ['How much is the Nova Plus plan?', 'What does the Nova Plus plan cost per month?', 'what is the price of nova plus'];

(haveReader ? describe : describe.skip)('knowledge changes: from a recurring gap to a published, reversible document', () => {
  let h: Harness;
  const L = () => h.learning!;
  let gapId = '';
  let proposalId = '';

  beforeAll(async () => {
    h = await createHarness({
      ingestKnowledge: true,
      classify: (m) => (/nova|plan|price|bags?|lounge/i.test(m) ? { isPolicyQuestion: true, intent: 'billing_policy' } : {}),
      learning: true,
    });
    // three different people asked the same thing, on both channels, and the documents had no answer
    for (const [i, q] of QUESTIONS.entries()) {
      const input: TurnInput = {
        clientId: 'novatel', conversationId: `00000000-0000-4000-8000-0000000009${i}0`, turnIndex: 0, channel: i % 2 ? 'chat' : 'voice',
        customerText: q, aiReply: "I'm not sure about that one.", intent: 'billing_policy', sentiment: 'neutral', citations: [],
        asksPolicy: true, abstained: true, toolCalls: [], lowConfidence: false, phase: 'NEW', knownNames: [],
      };
      await L().capture.process(input);
    }
    await L().runCycle('novatel', 'test');
    gapId = (await L().store.listGaps('novatel')).find((g) => g.label.includes('nova') || g.label.includes('plan'))!.id;
  }, 60_000);
  afterAll(() => h.close());

  const search = async (client: string, q: string) => (await h.searcher.search(client, q));

  it('names the cause: the documents never covered it, so a document is the smallest justified change', async () => {
    const res = await request(h.app).get(api('novatel', `/knowledge/gaps/${gapId}/diagnosis`)).expect(200);
    expect(res.body.data.cause).toBe('missing_information');
    expect(res.body.data.change).toBe('document');
    expect(res.body.data.recommendation).toMatch(/approved document/);
  });

  it('refuses a conversation as a source, however it is phrased', async () => {
    const pdfBytes = narrowPdf();
    for (const sourceType of ['conversation', 'human_reply', 'chat']) {
      const res = await request(h.app)
        .post(api('novatel', '/knowledge/proposals') + `?title=Nova%20Plus%20prices&docName=${NARROW}&sourceType=${sourceType}&owner=Support&reference=chat%20123&gapId=${gapId}`)
        .set('content-type', 'application/pdf')
        .send(pdfBytes);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/not a source/);
    }
    expect(await L().workflows.ml.listProposals('novatel')).toHaveLength(0);
  });

  it('builds a throwaway candidate index, measures it against the live one, and leaves the live index alone', async () => {
    const before = (await search('novatel', QUESTIONS[0]!)).relevant;
    const res = await request(h.app)
      .post(api('novatel', '/knowledge/proposals') + `?title=Nova%20Plus%20prices&docName=${NARROW}&sourceType=official_document&owner=NovaTel%20Pricing&reference=Price%20list%202026&gapId=${gapId}`)
      .set('content-type', 'application/pdf')
      .set('x-reviewer', 'maria')
      .send(narrowPdf());
    expect(res.status).toBe(201);
    proposalId = res.body.data.id;
    expect(res.body.data.status).toBe('draft');

    // approval before evaluation is refused
    expect((await request(h.app).post(api('novatel', `/knowledge/proposals/${proposalId}/approve`)).send({})).body.error.code).toBe('NOT_EVALUATED');

    const ev = await request(h.app).post(api('novatel', `/knowledge/proposals/${proposalId}/evaluate`)).set('x-reviewer', 'maria').send({});
    expect(ev.status).toBe(202);
    expect(ev.body.data.status, JSON.stringify(ev.body.data)).toBe('evaluated');
    const gates = ev.body.data.evaluation.gates as { name: string; pass: boolean; detail: string }[];
    const gateOf = (prefix: string) => gates.find((g) => g.name.startsWith(prefix))!;
    expect(gateOf('candidate index built').pass).toBe(true);
    expect(gateOf('the gap').pass, gateOf('the gap').detail).toBe(true);
    expect(gateOf('right passage for existing').pass).toBe(true);
    expect(gateOf('no other company').pass).toBe(true);
    expect(ev.body.data.evaluation.passed, JSON.stringify(gates.filter((g) => !g.pass))).toBe(true);

    // the live index did not change, and no candidate rows remain anywhere
    expect((await search('novatel', QUESTIONS[0]!)).relevant).toBe(before);
    const docs = await h.knowledge.list('novatel');
    expect(docs.some((d) => d.source === NARROW)).toBe(false);
    expect(await h.knowledge.list(`novatel~candidate~${proposalId.slice(0, 8)}`)).toEqual([]);
  }, 120_000);

  it('only an approved proposal can be published, and publishing makes both channels answer from the new document', async () => {
    expect((await request(h.app).post(api('novatel', `/knowledge/proposals/${proposalId}/deploy`)).send({})).body.error.code).toBe('NOT_APPROVED');
    await request(h.app).post(api('novatel', `/knowledge/proposals/${proposalId}/approve`)).set('x-reviewer', 'maria').send({}).expect(200);
    const dep = await request(h.app).post(api('novatel', `/knowledge/proposals/${proposalId}/deploy`)).set('x-reviewer', 'maria').send({});
    expect(dep.status, JSON.stringify(dep.body)).toBe(200);
    expect(dep.body.data.proposal.status).toBe('deployed');

    for (const channel of ['voice', 'chat'] as const) {
      h.llm.script(say('Nova Plus is listed in the handbook.'));
      const res = await h.chat.chat({ clientId: 'novatel', message: QUESTIONS[0]!, channel });
      expect(res.citations.some((c) => c.source === NARROW && c.page), channel).toBe(true);
    }
    const rel = (await L().store.listReleases('novatel')).find((r) => r.kind === 'knowledge')!;
    expect(rel.status).toBe('active');
    expect((rel.evaluation as { passed: boolean }).passed).toBe(true);
  }, 120_000);

  it('keeps the other company\'s knowledge and proposals separate', async () => {
    expect((await search('skylink-air', QUESTIONS[0]!)).passages.some((p) => p.source === NARROW)).toBe(false);
    expect((await request(h.app).post(api('skylink-air', `/knowledge/proposals/${proposalId}/rollback`)).send({})).status).toBe(404);
    expect((await request(h.app).get(api('skylink-air', '/knowledge/proposals'))).body.data).toEqual([]);
  });

  it('rolls the change back: the document goes away and the agents are back to not knowing', async () => {
    const rb = await request(h.app).post(api('novatel', `/knowledge/proposals/${proposalId}/rollback`)).set('x-reviewer', 'maria').send({});
    expect(rb.status, JSON.stringify(rb.body)).toBe(200);
    expect(rb.body.data.status).toBe('rolled_back');
    expect((await h.knowledge.list('novatel')).some((d) => d.source === NARROW)).toBe(false);
    expect((await search('novatel', QUESTIONS[0]!)).passages.some((p) => p.source === NARROW)).toBe(false);
    expect((await L().store.listReleases('novatel')).find((r) => r.kind === 'knowledge')!.status).toBe('rolled_back');
  }, 60_000);

  it('a broad handbook that would displace correct citations for existing questions fails its gate and cannot be approved', async () => {
    const res = await request(h.app)
      .post(api('novatel', '/knowledge/proposals') + `?title=Whole%20handbook&docName=novatel-handbook.pdf&sourceType=official_document&owner=NovaTel&reference=Handbook&gapId=${gapId}`)
      .set('content-type', 'application/pdf')
      .send(await pdf('novatel-handbook'));
    const id = res.body.data.id;
    const ev = await request(h.app).post(api('novatel', `/knowledge/proposals/${id}/evaluate`)).send({});
    expect(ev.body.data.status).toBe('evaluated');
    const failed = (ev.body.data.evaluation.gates as { name: string; pass: boolean }[]).filter((g) => !g.pass).map((g) => g.name);
    expect(ev.body.data.evaluation.passed, 'expected the broad handbook to regress something').toBe(false);
    expect(failed.length).toBeGreaterThan(0);
    const approve = await request(h.app).post(api('novatel', `/knowledge/proposals/${id}/approve`)).send({});
    expect(approve.status).toBe(409);
    expect((await h.knowledge.list('novatel')).some((d) => d.source === 'novatel-handbook.pdf')).toBe(false);
  }, 120_000);

  it('a document that carries instructions to the AI is held for a person and cannot be approved', async () => {
    const res = await request(h.app)
      .post(api('skylink-air', '/knowledge/proposals') + '?title=Partner%20notice&docName=skylink-partner-notice.pdf&sourceType=official_document&owner=Partnerships&reference=Notice%2012')
      .set('content-type', 'application/pdf')
      .send(await pdf('skylink-partner-notice'));
    const id = res.body.data.id;
    const ev = await request(h.app).post(api('skylink-air', `/knowledge/proposals/${id}/evaluate`)).send({});
    const gate = ev.body.data.evaluation.gates.find((g: { name: string }) => g.name.startsWith('document has no instruction'));
    expect(gate.pass).toBe(false);
    expect(ev.body.data.evaluation.passed).toBe(false);
    const approve = await request(h.app).post(api('skylink-air', `/knowledge/proposals/${id}/approve`)).send({});
    expect(approve.status).toBe(409);
    expect(approve.body.error.code).toBe('GATES_FAILED');
    expect((await h.knowledge.list('skylink-air')).some((d) => d.source === 'skylink-partner-notice.pdf')).toBe(false);
  }, 120_000);

  it('a colleague\'s answer is shown as a lead and never becomes a document by itself', async () => {
    const docsBefore = (await h.knowledge.list('novatel')).length;
    await L().capture.recordHumanReply('novatel', '00000000-0000-4000-8000-000000000900', 'Nova Plus is 35 dollars a month, trust me.');
    await L().runCycle('novatel', 'test');
    const gap = (await L().store.listGaps('novatel')).find((g) => g.id === gapId)!;
    expect((gap.suggestion as { unverifiedHumanAnswers: string[] }).unverifiedHumanAnswers.join(' ')).toMatch(/35 dollars/);
    expect((await h.knowledge.list('novatel')).length).toBe(docsBefore);
    expect((await search('novatel', QUESTIONS[0]!)).passages.some((p) => /35 dollars/.test(p.snippet))).toBe(false);
  });
});
