import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { auditRepo } from '@backend/database';
import { createHarness, nextChatRequestKey, say, type Harness } from '../helpers/harness';

let h: Harness;
beforeAll(async () => {
  h = await createHarness({
    classify: (m) => ({ wantsHuman: /person|human/i.test(m) }),
  });
});
afterAll(() => h.close());
beforeEach(() => h.llm.reset());

const postChat = () => request(h.app).post('/chat').set('Idempotency-Key', nextChatRequestKey());

/** A conversation the customer handed to a person, with the resulting handoff. */
async function handedOver() {
  const first = await postChat().send({
    clientId: 'skylink-air',
    message: 'I want to talk to a person',
  });
  const conversationId: string = first.body.data.conversationId;
  const list = await request(h.app).get('/handoffs?clientId=skylink-air');
  const handoff = list.body.data.find(
    (x: { conversationId: string }) => x.conversationId === conversationId,
  );
  return { conversationId, handoffId: handoff.id as string };
}

const messages = async (conversationId: string) =>
  (await request(h.app).get(`/conversations/${conversationId}`)).body.data.messages as {
    role: string;
    content: string;
  }[];

describe('human side of a handoff', () => {
  it('cannot reply or resolve before accepting', async () => {
    const { handoffId } = await handedOver();
    const reply = await request(h.app).post(`/handoffs/${handoffId}/reply`).send({ message: 'Hi' });
    expect(reply.status).toBe(409);
    expect(reply.body.error.code).toBe('ACCEPT_FIRST');
    expect((await request(h.app).post(`/handoffs/${handoffId}/resolve`)).status).toBe(409);
  });

  it('accept, reply and resolve: the customer sees the human reply as a human message', async () => {
    const { conversationId, handoffId } = await handedOver();
    expect((await request(h.app).post(`/handoffs/${handoffId}/accept`)).body.data.status).toBe(
      'accepted',
    );

    const reply = await request(h.app)
      .post(`/handoffs/${handoffId}/reply`)
      .send({ message: '  Hello, this is Sam. Let me look at your booking.  ' });
    expect(reply.status).toBe(201);
    const afterReply = await messages(conversationId);
    expect(afterReply.at(-1)).toEqual(
      expect.objectContaining({
        role: 'human',
        content: 'Hello, this is Sam. Let me look at your booking.',
      }),
    );

    const resolved = await request(h.app).post(`/handoffs/${handoffId}/resolve`);
    expect(resolved.body.data.status).toBe('resolved');
    expect((await messages(conversationId)).at(-1)?.role).toBe('human');

    // Closed: no more replies, no re-opening by accepting.
    expect(
      (await request(h.app).post(`/handoffs/${handoffId}/reply`).send({ message: 'x' })).status,
    ).toBe(409);
    expect((await request(h.app).post(`/handoffs/${handoffId}/accept`)).status).toBe(409);
  });

  it('records every step in the audit log', async () => {
    const { conversationId, handoffId } = await handedOver();
    await request(h.app).post(`/handoffs/${handoffId}/accept`);
    await request(h.app).post(`/handoffs/${handoffId}/accept`); // accepting twice is not audited twice
    await request(h.app).post(`/handoffs/${handoffId}/reply`).send({ message: 'Hi there' });
    await request(h.app).post(`/handoffs/${handoffId}/resolve`);
    const types = (await auditRepo.listAuditEvents(h.db.db, conversationId)).map((a) => a.type);
    expect(types).toEqual(['handoff_accepted', 'human_reply', 'handoff_resolved']);
  });

  it('validates the reply and the id', async () => {
    const { handoffId } = await handedOver();
    await request(h.app).post(`/handoffs/${handoffId}/accept`);
    expect(
      (await request(h.app).post(`/handoffs/${handoffId}/reply`).send({ message: '   ' })).status,
    ).toBe(400);
    expect(
      (
        await request(h.app)
          .post(`/handoffs/${handoffId}/reply`)
          .send({ message: 'x'.repeat(2001) })
      ).status,
    ).toBe(400);
    expect(
      (await request(h.app).post('/handoffs/not-an-id/reply').send({ message: 'x' })).status,
    ).toBe(400);
    expect(
      (
        await request(h.app)
          .post('/handoffs/11111111-1111-1111-1111-111111111111/reply')
          .send({ message: 'x' })
      ).status,
    ).toBe(404);
  });

  it('while waiting the customer is told they are queued; once accepted the agent stays silent', async () => {
    const { conversationId, handoffId } = await handedOver();
    h.llm.script(say('The agent must NOT speak after a handoff.'));

    const waiting = await postChat().send({
      clientId: 'skylink-air',
      conversationId,
      message: 'Hello? Anyone there?',
    });
    expect(waiting.body.data.reply).toMatch(/in the queue/);

    await request(h.app).post(`/handoffs/${handoffId}/accept`);
    const accepted = await postChat().send({
      clientId: 'skylink-air',
      conversationId,
      message: 'My booking is SK1001',
    });
    expect(accepted.body.data.reply).toBe('');
    expect(h.llm.remaining()).toBe(1); // the scripted agent reply was never used

    const log = await messages(conversationId);
    expect(log.at(-1)).toEqual(
      expect.objectContaining({ role: 'user', content: 'My booking is SK1001' }),
    );
  });
});
