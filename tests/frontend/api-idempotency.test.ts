import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../frontend/src/services/api';

afterEach(() => vi.unstubAllGlobals());

describe('chat request retries', () => {
  it('reuses the same idempotency key after a network failure', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('connection reset'))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              conversationId: '00000000-0000-0000-0000-000000000001',
              reply: 'Hello.',
              state: {
                verified: false,
                journeyId: 'support',
                journeyStep: 'start',
                collected: {},
                handedOff: false,
              },
              trace: [],
              citations: [],
            },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    await api.chat({ clientId: 'skylink-air', message: 'hello' }, 'stable-turn-key-0001');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.headers).toMatchObject({ 'idempotency-key': 'stable-turn-key-0001' });
    }
  });
});
