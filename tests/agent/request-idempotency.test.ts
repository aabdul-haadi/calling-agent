import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { conversationsRepo } from '@backend/database';
import { createHarness, type Harness } from '../helpers/harness';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());
beforeEach(() => h.llm.reset());

const request = {
  clientId: 'skylink-air',
  message: 'hello',
};

describe('chat request idempotency', () => {
  it('coalesces concurrent duplicate requests and replays the completed response', async () => {
    h.llm.script({ text: 'Hello, how can I help?', delayMs: 100 });
    const options = { idempotencyKey: 'same-logical-turn-0001' };
    const [first, concurrent] = await Promise.all([
      h.chat.chat(request, options),
      h.chat.chat(request, options),
    ]);

    expect(concurrent).toEqual(first);
    expect(await h.chat.chat(request, options)).toEqual(first);
    expect(
      await h.chat.chat({ ...request, conversationId: first.conversationId }, options),
    ).toEqual(first);
    expect(h.llm.calls).toHaveLength(1);
    expect(await conversationsRepo.listMessages(h.db.db, first.conversationId)).toHaveLength(2);
  });

  it('rejects reusing a key for a different request', async () => {
    h.llm.script({ text: 'Hello, how can I help?' });
    const options = { idempotencyKey: 'same-logical-turn-0002' };
    await h.chat.chat(request, options);

    await expect(
      h.chat.chat({ ...request, message: 'Can I bring a pet?' }, options),
    ).rejects.toMatchObject({
      status: 409,
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(h.llm.calls).toHaveLength(1);
  });

  it('allows the customer to repeat the same text as a new turn with a new key', async () => {
    h.llm.script({ text: 'Hello, how can I help?' }, { text: 'Hello, how can I help?' });
    const first = await h.chat.chat(request, { idempotencyKey: 'new-logical-turn-0001' });
    const second = await h.chat.chat(
      { ...request, conversationId: first.conversationId },
      { idempotencyKey: 'new-logical-turn-0002' },
    );

    expect(second.conversationId).toBe(first.conversationId);
    expect(await conversationsRepo.listMessages(h.db.db, first.conversationId)).toHaveLength(4);
    expect(h.llm.calls).toHaveLength(2);
  });
});
