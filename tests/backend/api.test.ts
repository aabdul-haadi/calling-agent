import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { formatForSpeech } from '@adk/shared';
import { createHarness, say, type Harness } from '../helpers/harness';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());
beforeEach(() => h.llm.reset());

describe('HTTP API', () => {
  it('lists clients and returns a client config', async () => {
    const list = await request(h.app).get('/clients');
    expect(list.body.data.map((c: { id: string }) => c.id)).toContain('skylink-air');
    const one = await request(h.app).get('/clients/skylink-air');
    expect(one.body.data.persona.name).toBe('Ava');
    expect((await request(h.app).get('/clients/nope')).status).toBe(404);
  });

  it('POST /chat validates the body and the client', async () => {
    expect((await request(h.app).post('/chat').send({})).status).toBe(400);
    expect(
      (await request(h.app).post('/chat').send({ clientId: 'skylink-air', message: '' })).status,
    ).toBe(400);
    expect(
      (
        await request(h.app)
          .post('/chat')
          .send({ clientId: 'skylink-air', message: 'x'.repeat(2001) })
      ).status,
    ).toBe(400);
    expect(
      (await request(h.app).post('/chat').send({ clientId: 'nope', message: 'hi' })).status,
    ).toBe(404);
    const res = await request(h.app)
      .post('/chat')
      .send({
        clientId: 'skylink-air',
        message: 'hi',
        channel: 'voice',
        conversationId: '00000000-0000-0000-0000-000000000000',
      });
    expect(res.status).toBe(404); // unknown conversation
  });

  it('a chat round trip returns { data } with reply, state, trace and the view endpoint matches', async () => {
    h.llm.script(say('Hello! How can I help?'));
    const res = await request(h.app)
      .post('/chat')
      .send({ clientId: 'skylink-air', message: 'hello' });
    expect(res.status).toBe(200);
    expect(res.body.data.reply).toBe('Hello! How can I help?');
    expect(
      res.body.data.trace.some((t: { label: string }) => t.label.startsWith('Understood intent')),
    ).toBe(true);
    const id = res.body.data.conversationId;
    const view = await request(h.app).get(`/conversations/${id}`);
    expect(view.body.data.messages).toHaveLength(2);
  });

  it('voice-capable clients accept the voice channel and record latency in the trace', async () => {
    h.llm.script(say('Hi, this is Ava.'));
    const res = await request(h.app)
      .post('/chat')
      .send({ clientId: 'skylink-air', message: 'hello', channel: 'voice' });
    const id = res.body.data.conversationId;
    expect(h.llm.calls[0]!.system).toContain('VOICE call');
    expect(
      (await request(h.app).post(`/conversations/${id}/voice-latency`).send({ ms: 820 })).status,
    ).toBe(204);
    const view = await request(h.app).get(`/conversations/${id}`);
    const ev = view.body.data.trace.find((t: { type: string }) => t.type === 'voice');
    expect(ev.latencyMs).toBe(820);
    expect(ev.status).toBe('ok');
  });

  it('simulator controls are validated and stored', async () => {
    h.llm.script(say('hi'));
    const id = (
      await request(h.app).post('/chat').send({ clientId: 'skylink-air', message: 'hello' })
    ).body.data.conversationId;
    expect(
      (
        await request(h.app)
          .patch(`/conversations/${id}/simulator`)
          .send({ apiFailing: true, latencyMs: 99999 })
      ).status,
    ).toBe(400);
    const ok = await request(h.app)
      .patch(`/conversations/${id}/simulator`)
      .send({ apiFailing: true, latencyMs: 500 });
    expect(ok.body.data.simulator).toEqual({ apiFailing: true, latencyMs: 500 });
  });

  it('DELETE /conversations/:id resets it', async () => {
    h.llm.script(say('hi'));
    const id = (
      await request(h.app).post('/chat').send({ clientId: 'skylink-air', message: 'hello' })
    ).body.data.conversationId;
    const res = await request(h.app).delete(`/conversations/${id}`);
    expect(res.body.data.messages).toEqual([]);
    expect((await request(h.app).get('/conversations/not-a-uuid')).status).toBe(400);
  });
});

describe('speech formatting for voice', () => {
  it('reads references, times and money naturally', () => {
    expect(formatForSpeech('Your booking SK1001 is on flight SK110')).toBe(
      'Your booking S K 1 0 0 1 is on flight S K 1 1 0',
    );
    expect(formatForSpeech('Departs 14:35 and 07:00')).toBe('Departs 2:35 PM and 7 AM');
    expect(formatForSpeech('A fee of $75 or $12.50')).toBe(
      'A fee of 75 dollars or 12 dollars and 50 cents',
    );
  });
  it('strips markdown and citations', () => {
    expect(formatForSpeech('**One bag** is free [Source: checked-baggage].')).toBe(
      'One bag is free .',
    );
  });
});
