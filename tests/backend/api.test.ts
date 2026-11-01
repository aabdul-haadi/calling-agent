import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { formatForSpeech } from '@adk/shared';
import { createHarness, nextChatRequestKey, say, type Harness } from '../helpers/harness';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());
beforeEach(() => h.llm.reset());

const postChat = () => request(h.app).post('/chat').set('Idempotency-Key', nextChatRequestKey());

describe('HTTP API', () => {
  it('lists clients and returns a client config', async () => {
    const list = await request(h.app).get('/clients');
    expect(list.body.data.map((c: { id: string }) => c.id)).toContain('skylink-air');
    const one = await request(h.app).get('/clients/skylink-air');
    expect(one.body.data.persona.name).toBe('Ava');
    expect((await request(h.app).get('/clients/nope')).status).toBe(404);
  });

  it('POST /chat validates the body and the client', async () => {
    expect((await postChat().send({})).status).toBe(400);
    expect((await postChat().send({ clientId: 'skylink-air', message: '' })).status).toBe(400);
    expect(
      (await postChat().send({ clientId: 'skylink-air', message: 'x'.repeat(2001) })).status,
    ).toBe(400);
    expect((await postChat().send({ clientId: 'nope', message: 'hi' })).status).toBe(404);
    const res = await postChat().send({
      clientId: 'skylink-air',
      message: 'hi',
      channel: 'voice',
      conversationId: '00000000-0000-0000-0000-000000000000',
    });
    expect(res.status).toBe(404); // unknown conversation
  });

  it('a chat round trip returns { data } with reply, state, trace and the view endpoint matches', async () => {
    h.llm.script(say('Hello! How can I help?'));
    const res = await postChat().send({ clientId: 'skylink-air', message: 'hello' });
    expect(res.status).toBe(200);
    expect(res.body.data.reply).toBe('Hello! How can I help?');
    expect(
      res.body.data.trace.some((t: { label: string }) => t.label.startsWith('Understood intent')),
    ).toBe(true);
    const id = res.body.data.conversationId;
    const view = await request(h.app).get(`/conversations/${id}`);
    expect(view.body.data.messages).toHaveLength(2);
  });

  it('replays a request with the same idempotency key and rejects a different payload', async () => {
    h.llm.script(say('One checked bag is included.'));
    const body = { clientId: 'skylink-air', message: 'hello' };
    const key = 'api-logical-turn-0001';
    const first = await request(h.app).post('/chat').set('Idempotency-Key', key).send(body);
    const replay = await request(h.app).post('/chat').set('Idempotency-Key', key).send(body);
    const conflict = await request(h.app)
      .post('/chat')
      .set('Idempotency-Key', key)
      .send({ ...body, message: 'Can I bring a pet?' });

    expect(first.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(h.llm.calls).toHaveLength(1);
  });

  it('replays a streamed turn without running the agent twice', async () => {
    h.llm.script(say('Hello, how can I help?'));
    const body = { clientId: 'skylink-air', message: 'hello' };
    const key = 'stream-logical-turn-0001';
    const first = await request(h.app).post('/chat/stream').set('Idempotency-Key', key).send(body);
    const replay = await request(h.app).post('/chat/stream').set('Idempotency-Key', key).send(body);
    const events = (text: string) =>
      text
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { type: string; reply?: string; text?: string });

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(events(first.text).at(-1)).toMatchObject({
      type: 'turn.completed',
      reply: 'Hello, how can I help?',
    });
    expect(events(replay.text).at(-1)).toMatchObject({
      type: 'turn.completed',
      reply: 'Hello, how can I help?',
    });
    expect(h.llm.calls).toHaveLength(1);
  });

  it('speaks a non-repetitive acknowledgement for details added while waiting for a human', async () => {
    h.llm.script(
      { toolCalls: [{ id: '', name: 'transfer_to_human', input: { reason: 'customer request' } }] },
      say('I will connect you.'),
    );
    const streamTurn = async (body: Record<string, unknown>) => {
      const response = await request(h.app)
        .post('/chat/stream')
        .set('Idempotency-Key', nextChatRequestKey())
        .send(body);
      expect(response.status).toBe(200);
      return response.text
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { type: string; conversationId?: string; text?: string; reply?: string });
    };

    const first = await streamTurn({
      clientId: 'skylink-air',
      message: 'Please connect me with a person.',
      channel: 'voice',
    });
    const conversationId = first.find((event) => event.type === 'turn.completed')?.conversationId;
    expect(conversationId).toBeDefined();

    await streamTurn({
      clientId: 'skylink-air',
      conversationId,
      message: 'How long is the queue?',
      channel: 'voice',
    });
    const update = await streamTurn({
      clientId: 'skylink-air',
      conversationId,
      message: 'My booking reference is SK1001 and my last name is Rahman.',
      channel: 'voice',
    });

    expect(update.find((event) => event.type === 'agent.text.delta')?.text).toBe(
      "Thanks, I've added that to the conversation for your colleague.",
    );
    expect(update.find((event) => event.type === 'turn.completed')?.reply).toBe(
      "Thanks, I've added that to the conversation for your colleague.",
    );
  });

  it('requires an idempotency key for every logical chat request', async () => {
    const res = await request(h.app)
      .post('/chat')
      .send({ clientId: 'skylink-air', message: 'hello' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('voice-capable clients accept the voice channel and record latency in the trace', async () => {
    h.llm.script(say('Hi, this is Ava.'));
    const res = await postChat().send({
      clientId: 'skylink-air',
      message: 'hello',
      channel: 'voice',
    });
    const id = res.body.data.conversationId;
    expect(h.llm.calls[0]!.system).toContain('VOICE CALL');
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
    const id = (await postChat().send({ clientId: 'skylink-air', message: 'hello' })).body.data
      .conversationId;
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
    const id = (await postChat().send({ clientId: 'skylink-air', message: 'hello' })).body.data
      .conversationId;
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
