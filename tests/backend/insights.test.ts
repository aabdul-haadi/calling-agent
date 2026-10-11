import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { clientDir, loadClients } from '@backend/clients';
import { ingestClient, localProvider } from '@backend/knowledge';
import { resolve } from 'node:path';
import { callTool, createHarness, say, type Harness } from '../helpers/harness';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
  const module = loadClients().get('skylink-air')!;
  await ingestClient(
    h.db.db,
    localProvider,
    'skylink-air',
    resolve(clientDir(module), module.config.knowledgeDir),
  );
});
afterAll(() => h.close());
beforeEach(() => h.llm.reset());

describe('operations insights', () => {
  it('starts empty: zero counts and nulls, never invented numbers', async () => {
    const res = await request(h.app).get('/overview?clientId=novatel');
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.conversations.total).toBe(0);
    expect(d.tools.total).toBe(0);
    expect(d.tools.p95LatencyMs).toBeNull();
    expect(d.evals.latest).toBeUndefined();
    // Token usage and cost are not recorded, and the API says so instead of returning a number.
    expect(d.llmUsage).toBeNull();
  });

  it('computes metrics from real conversations, tool calls and handoffs', async () => {
    h.llm.script(
      callTool('verify_customer', { bookingRef: 'SK1001', lastName: 'Rahman' }),
      callTool('get_booking', { bookingRef: 'SK1001' }),
      callTool('verify_customer', { bookingRef: 'SK1001', lastName: 'Nobody' }),
      say('Verified, and one attempt failed.'),
    );
    const chat = await request(h.app)
      .post('/chat')
      .send({ clientId: 'skylink-air', message: 'SK1001 Rahman' });
    expect(chat.status).toBe(200);

    const d = (await request(h.app).get('/overview?clientId=skylink-air')).body.data;
    expect(d.conversations.total).toBeGreaterThanOrEqual(1);
    expect(d.tools.total).toBe(3);
    expect(d.tools.failed).toBe(1);
    expect(d.tools.p50LatencyMs).toBeGreaterThanOrEqual(0);
    const verify = d.tools.perTool.find((t: { tool: string }) => t.tool === 'verify_customer');
    expect(verify).toMatchObject({ calls: 2, failures: 1 });
  });

  it('lists conversations without exposing message text', async () => {
    const res = await request(h.app).get('/conversations?clientId=skylink-air');
    expect(res.status).toBe(200);
    const first = res.body.data[0];
    expect(first).toMatchObject({ clientId: 'skylink-air', phase: expect.any(String) });
    expect(first.messageCount).toBeGreaterThan(0);
    expect(JSON.stringify(res.body)).not.toContain('Rahman');
  });

  it('rejects an unknown client', async () => {
    expect((await request(h.app).get('/overview?clientId=nope')).status).toBe(404);
    expect((await request(h.app).get('/conversations?clientId=nope')).status).toBe(404);
    expect((await request(h.app).get('/clients/nope/knowledge')).status).toBe(404);
  });

  it('lists the knowledge documents the agent can cite', async () => {
    const res = await request(h.app).get('/clients/skylink-air/knowledge');
    expect(res.status).toBe(200);
    const sources = res.body.data.map((d: { source: string }) => d.source);
    expect(sources).toContain('refunds');
    const refunds = res.body.data.find((d: { source: string }) => d.source === 'refunds');
    expect(refunds.chunks).toBeGreaterThan(0);
    expect(refunds.headings.length).toBeGreaterThan(0);
  });

  it('exposes a pending approval on the conversation state, but not the proposal itself', async () => {
    const pick = (req: { system: string }) => ({
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
    });
    await fetch(`${h.mockUrl}/admin/reset`, { method: 'POST' });
    h.llm.script(
      callTool('verify_customer', { bookingRef: 'SK1001', lastName: 'Rahman' }),
      callTool('search_alternatives', { bookingRef: 'SK1001' }),
      say('Options listed.'),
      pick,
      say('Please reply yes.'),
    );
    const first = await request(h.app)
      .post('/chat')
      .send({ clientId: 'skylink-air', message: 'SK1001 Rahman' });
    const second = await request(h.app).post('/chat').send({
      clientId: 'skylink-air',
      conversationId: first.body.data.conversationId,
      message: 'The first one',
    });
    const state = second.body.data.state;
    expect(state.phase).toBe('AWAITING_APPROVAL');
    expect(state.pendingApproval.summary).toContain('SK1001');
    expect(Date.parse(state.pendingApproval.expiresAt)).toBeGreaterThan(Date.now());
    expect(state.proposal).toBeUndefined();
  });
});

describe('interrupted eval runs', () => {
  it('a run left "running" by a killed process is marked stopped at startup', async () => {
    const { evalsRepo } = await import('@backend/database');
    const id = await evalsRepo.createRun(h.db.db, 'skylink-air', 20);
    expect((await evalsRepo.getRun(h.db.db, id))?.status).toBe('running');
    expect(await evalsRepo.failInterruptedRuns(h.db.db)).toBeGreaterThanOrEqual(1);
    expect((await evalsRepo.getRun(h.db.db, id))?.status).toBe('error');
    expect(await evalsRepo.failInterruptedRuns(h.db.db)).toBe(0);
  });
});
