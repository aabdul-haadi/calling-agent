import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { fail, ok, type Rule } from '@adk/shared';
import { dispatch, checkRules } from '@backend/tools/dispatcher';
import { defineTool, type ToolContext } from '@backend/tools/types';
import { newState, type ConversationState } from '@backend/agent/state';
import { createMemoryIdempotencyStore } from '@backend/tools/security';
import { createLogger } from '@backend/logger';
import { skylinkModule } from '@clients/skylink-air';

const run = vi.fn(async (input: { n: number }) => ok({ doubled: input.n * 2 }));
const echo = defineTool({
  name: 'echo',
  description: 'test tool',
  input: z.object({ n: z.number().int().min(0) }),
  label: 'Ran echo',
  run,
  summarize: (d) => `doubled to ${d.doubled}`,
});
const boom = defineTool({
  name: 'boom',
  description: 'throws',
  input: z.object({}),
  label: 'Boom',
  run: async () => {
    throw new Error('kaboom');
  },
});

const rules: Rule[] = [
  { id: 'v', kind: 'requiresVerification', description: 'verify first', tools: ['echo'] },
  {
    id: 'm',
    kind: 'maxCallsPerConversation',
    description: 'Only one boom.',
    tool: 'boom',
    limit: 1,
  },
];
const registry = new Map([echo, boom].map((t) => [t.name, t]));
const deps = { registry, allowed: ['echo', 'boom'], rules };

function ctx(state: Partial<ConversationState> = {}): ToolContext {
  return {
    conversationId: 'c1',
    clientId: 'x',
    state: { ...newState(skylinkModule.config), ...state },
    logger: createLogger('silent'),
    api: { request: vi.fn() },
    idempotency: createMemoryIdempotencyStore(),
  };
}

describe('dispatcher', () => {
  it('blocks tools that need verification before the customer is verified', async () => {
    run.mockClear();
    const out = await dispatch('echo', { n: 2 }, ctx({ verified: false }), deps);
    expect(out.result).toMatchObject({ ok: false, error: 'AUTH_REQUIRED' });
    expect(run).not.toHaveBeenCalled(); // the tool never ran
  });

  it('runs the tool once verified and returns a summary', async () => {
    const out = await dispatch('echo', { n: 2 }, ctx({ verified: true }), deps);
    expect(out.result).toEqual(ok({ doubled: 4 }));
    expect(out.summary).toBe('doubled to 4');
    expect(out.label).toBe('Ran echo');
  });

  it('rejects invalid arguments before the tool runs', async () => {
    run.mockClear();
    for (const bad of [{ n: -1 }, { n: 'x' }, {}, null, 'text']) {
      const out = await dispatch('echo', bad, ctx({ verified: true }), deps);
      expect(out.result).toMatchObject({ ok: false, error: 'INVALID_ARGS' });
    }
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses tools that are unknown or not on the client allow-list', async () => {
    const unknown = await dispatch('drop_database', {}, ctx(), deps);
    expect(unknown.result).toMatchObject({ ok: false, error: 'INVALID_ARGS' });
    const notAllowed = await dispatch('echo', { n: 1 }, ctx({ verified: true }), {
      ...deps,
      allowed: ['boom'],
    });
    expect(notAllowed.result).toMatchObject({ ok: false, error: 'INVALID_ARGS' });
  });

  it('turns a thrown error into a typed UNAVAILABLE result', async () => {
    const out = await dispatch('boom', {}, ctx(), deps);
    expect(out.result).toMatchObject({ ok: false, error: 'UNAVAILABLE' });
  });

  it('enforces per-conversation call limits', () => {
    expect(checkRules(rules, 'boom', ctx().state).ok).toBe(true);
    const blocked = checkRules(rules, 'boom', { ...ctx().state, toolCallCounts: { boom: 1 } });
    expect(blocked).toMatchObject({ ok: false, error: 'RULE_BLOCKED' });
  });

  it('propagates typed failures from tools and applies state patches only on success', async () => {
    const failing = defineTool({
      name: 'f',
      description: '',
      input: z.object({}),
      label: 'F',
      run: async () => fail('NOT_FOUND', 'nope'),
      remember: () => ({ verified: true }),
    });
    const out = await dispatch('f', {}, ctx(), {
      registry: new Map([[failing.name, failing]]),
      allowed: ['f'],
      rules: [],
    });
    expect(out.result).toMatchObject({ ok: false, error: 'NOT_FOUND' });
    expect(out.patch).toEqual({});
  });
});

describe('SkyLink config wiring', () => {
  it('requires verification for every booking tool, in code', () => {
    const state = newState(skylinkModule.config);
    for (const tool of ['get_booking', 'search_alternatives', 'change_flight']) {
      expect(checkRules(skylinkModule.config.rules, tool, state)).toMatchObject({
        ok: false,
        error: 'AUTH_REQUIRED',
      });
    }
    expect(checkRules(skylinkModule.config.rules, 'verify_customer', state).ok).toBe(true);
    expect(checkRules(skylinkModule.config.rules, 'transfer_to_human', state).ok).toBe(true);
  });
});
