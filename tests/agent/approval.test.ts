import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fail, ok } from '@adk/shared';
import { auditRepo, conversationsRepo } from '@backend/database';
import {
  PROPOSAL_TTL_MS,
  createProposal,
  isApprovedFor,
  resolveProposal,
  type Proposal,
} from '@backend/agent/approval';
import { PHASES, transition } from '@backend/agent/phase';
import { newState } from '@backend/agent/state';
import { dispatch } from '@backend/tools/dispatcher';
import { createMemoryIdempotencyStore } from '@backend/tools/security';
import { createLogger } from '@backend/logger';
import { skylinkModule } from '@clients/skylink-air';
import { callTool, createHarness, say, type Harness, type ScriptStep } from '../helpers/harness';

describe('phase machine (pure)', () => {
  it('follows the happy path', () => {
    expect(transition('NEW', 'message')).toBe('VERIFYING');
    expect(transition('VERIFYING', 'identity_verified')).toBe('VERIFIED');
    expect(transition('VERIFIED', 'tool_ok')).toBe('PLANNING');
    expect(transition('PLANNING', 'proposal_created')).toBe('AWAITING_APPROVAL');
    expect(transition('AWAITING_APPROVAL', 'approval_granted')).toBe('EXECUTING');
    expect(transition('EXECUTING', 'executed')).toBe('COMPLETED');
  });

  it('refuses shortcuts: nothing executes without approval, nothing leaves a handoff', () => {
    expect(transition('PLANNING', 'executed')).toBeNull();
    expect(transition('PLANNING', 'approval_granted')).toBeNull();
    expect(transition('VERIFYING', 'proposal_created')).toBeNull();
    expect(transition('NEW', 'executed')).toBeNull();
    for (const p of PHASES) {
      if (p !== 'HANDOFF') expect(transition(p, 'handoff')).toBe('HANDOFF');
    }
    expect(transition('HANDOFF', 'reopened')).toBeNull();
    expect(transition('HANDOFF', 'message')).toBeNull();
  });

  it('a rejected or expired approval goes back to planning, a failure to FAILED', () => {
    expect(transition('AWAITING_APPROVAL', 'approval_rejected')).toBe('PLANNING');
    expect(transition('AWAITING_APPROVAL', 'approval_expired')).toBe('PLANNING');
    expect(transition('EXECUTING', 'execution_failed')).toBe('FAILED');
    expect(transition('FAILED', 'reopened')).toBe('VERIFIED');
  });
});

describe('proposals (pure)', () => {
  const binding = { bookingRef: 'SK1001', newFlightId: 'F2', changesMade: 0 };
  const make = (now = Date.now()) => createProposal('change_flight', 'Move it', binding, 'p1', now);

  it('only a clear yes approves, and a no rejects', () => {
    expect(resolveProposal(make(), 'yes').event).toBe('approved');
    expect(resolveProposal(make(), 'no').event).toBe('rejected');
    expect(resolveProposal(make(), 'none').event).toBeUndefined();
    expect(resolveProposal(make(), 'none').proposal?.status).toBe('pending');
  });

  it('a proposal past its expiry cannot be approved', () => {
    const old = make(Date.now() - PROPOSAL_TTL_MS - 1000);
    const r = resolveProposal(old, 'yes');
    expect(r.event).toBe('expired');
    expect(r.proposal?.status).toBe('expired');
  });

  it('an approval that was not used in its turn dies', () => {
    const approved: Proposal = { ...make(), status: 'approved' };
    expect(resolveProposal(approved, 'none').proposal?.status).toBe('expired');
  });

  it('is valid only for the same tool, customer and exact binding', () => {
    const approved: Proposal = { ...make(), status: 'approved' };
    expect(isApprovedFor(approved, 'change_flight', 'p1', binding)).toBe(true);
    expect(isApprovedFor(approved, 'change_flight', 'p2', binding)).toBe(false);
    expect(isApprovedFor(approved, 'other_tool', 'p1', binding)).toBe(false);
    expect(isApprovedFor(approved, 'change_flight', 'p1', { ...binding, newFlightId: 'F3' })).toBe(
      false,
    );
    expect(isApprovedFor(approved, 'change_flight', 'p1', { ...binding, changesMade: 1 })).toBe(
      false,
    );
    expect(isApprovedFor({ ...approved, status: 'pending' }, 'change_flight', 'p1', binding)).toBe(
      false,
    );
  });
});

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());
beforeEach(async () => {
  h.llm.reset();
  await fetch(`${h.mockUrl}/admin/reset`, { method: 'POST' });
});

const flightAt = (n: number) => (req: { system: string }) =>
  [...req.system.matchAll(/"flightId":"([^"]+)"/g)][n]?.[1];
const change = (pick: (req: { system: string }) => string | undefined): ScriptStep =>
  ((req: { system: string }) => ({
    toolCalls: [
      { id: '', name: 'change_flight', input: { bookingRef: 'SK1001', newFlightId: pick(req) } },
    ],
  })) as ScriptStep;

/** Verified customer with the alternatives already shown: ready to pick a flight. */
async function readyToPick() {
  h.llm.script(
    callTool('verify_customer', { bookingRef: 'SK1001', lastName: 'Rahman' }),
    callTool('search_alternatives', { bookingRef: 'SK1001' }),
    say('Here are your options.'),
  );
  const first = await h.chat.chat({ clientId: 'skylink-air', message: 'SK1001 Rahman' });
  const next = (message: string) =>
    h.chat.chat({ clientId: 'skylink-air', conversationId: first.conversationId, message });
  return { id: first.conversationId, next };
}

const auditTypes = async (id: string) =>
  (await auditRepo.listAuditEvents(h.db.db, id)).map((a) => a.type);

describe('approval-bound changes', () => {
  it('never executes in the turn that proposed it, even if the model calls the tool again', async () => {
    const { id, next } = await readyToPick();
    h.llm.script(change(flightAt(0)), change(flightAt(0)), say('Please reply yes.'));
    const res = await next('The first one');
    expect(res.state.collected.rebooked).toBeUndefined();
    expect(res.state.phase).toBe('AWAITING_APPROVAL');
    expect(await auditTypes(id)).not.toContain('mutation_executed');
  });

  it('a customer message that is not a yes leaves the change unmade', async () => {
    const { id, next } = await readyToPick();
    h.llm.script(change(flightAt(0)), say('Reply yes to confirm.'), change(flightAt(0)), say('?'));
    await next('The first one');
    const res = await next('What is the baggage allowance?');
    expect(res.state.collected.rebooked).toBeUndefined();
    expect(await auditTypes(id)).not.toContain('mutation_executed');
  });

  it('a no rejects the proposal and nothing is changed', async () => {
    const { id, next } = await readyToPick();
    h.llm.script(change(flightAt(0)), say('Reply yes to confirm.'), say('Okay, left as it is.'));
    await next('The first one');
    const res = await next('No, leave it');
    expect(res.state.collected.rebooked).toBeUndefined();
    expect(res.state.phase).toBe('PLANNING');
    expect(await auditTypes(id)).toEqual(['proposal_created', 'approval_rejected']);
  });

  it('a yes for one flight cannot be used to book a different flight', async () => {
    const { id, next } = await readyToPick();
    h.llm.script(
      change(flightAt(0)),
      say('Reply yes to confirm.'),
      change(flightAt(1)), // the model swaps in another offered flight
      say('Please confirm the other flight.'),
    );
    await next('The first one');
    const res = await next('Yes');
    expect(res.state.collected.rebooked).toBeUndefined();
    expect(res.state.phase).toBe('AWAITING_APPROVAL');
    const types = await auditTypes(id);
    expect(types).toEqual(['proposal_created', 'approval_granted', 'proposal_created']);
  });

  it('a proposal that expired cannot be approved', async () => {
    const { id, next } = await readyToPick();
    h.llm.script(change(flightAt(0)), say('Reply yes to confirm.'), change(flightAt(0)), say('?'));
    await next('The first one');
    const convo = (await conversationsRepo.getConversation(h.db.db, id))!;
    const stale = {
      ...convo.state.proposal!,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    };
    await conversationsRepo.saveConversation(h.db.db, id, { ...convo.state, proposal: stale });
    const res = await next('Yes');
    expect(res.state.collected.rebooked).toBeUndefined();
    expect(await auditTypes(id)).toContain('approval_expired');
    expect(await auditTypes(id)).not.toContain('mutation_executed');
  });

  it('the approval covers one execution only', async () => {
    const { id, next } = await readyToPick();
    h.llm.script(
      change(flightAt(0)),
      say('Reply yes to confirm.'),
      change(flightAt(0)),
      say('Done.'),
    );
    await next('The first one');
    await next('Yes');
    const convo = (await conversationsRepo.getConversation(h.db.db, id))!;
    expect(convo.state.proposal?.status).toBe('executed');
    expect(
      isApprovedFor(
        convo.state.proposal,
        'change_flight',
        convo.state.customerId,
        convo.state.proposal!.binding,
      ),
    ).toBe(false);
  });

  it('records proposal, approval and change in the audit log, in order', async () => {
    const { id, next } = await readyToPick();
    h.llm.script(
      change(flightAt(0)),
      say('Reply yes to confirm.'),
      change(flightAt(0)),
      say('Done.'),
    );
    await next('The first one');
    const res = await next('Yes please');
    expect(res.state.phase).toBe('COMPLETED');
    const events = await auditRepo.listAuditEvents(h.db.db, id);
    expect(events.map((e) => e.type)).toEqual([
      'proposal_created',
      'approval_granted',
      'mutation_executed',
    ]);
    const proposed = events[0]!.data as { binding: Record<string, unknown> };
    expect(proposed.binding.bookingRef).toBe('SK1001');
  });
});

describe('change_flight against a flaky booking system', () => {
  const changeTool = skylinkModule.tools.find((t) => t.name === 'change_flight')!;
  const flight = (id: string) => ({
    id,
    flightNumber: id.slice(0, 5),
    origin: 'JFK',
    destination: 'LHR',
    departure: '2026-11-10T11:00:00.000Z',
    arrival: '2026-11-10T19:00:00.000Z',
    seatsLeft: 5,
    status: 'SCHEDULED' as const,
  });
  const booking = (flightId: string) => ({
    ref: 'SK1001',
    passengerId: 'p1',
    firstName: 'Amira',
    lastName: 'Rahman',
    fareClass: 'ECONOMY' as const,
    changesMade: 0,
    flight: { ...flight(flightId), status: 'CANCELLED' as const },
  });

  function ctxWith(
    request: ReturnType<typeof vi.fn>,
    proposal?: Proposal,
    audit = vi.fn(),
  ): Parameters<typeof dispatch>[2] {
    const state = {
      ...newState(skylinkModule.config),
      verified: true,
      customerId: 'p1',
      collected: { alternatives: [{ flightId: 'NEW-1', flightNumber: 'SK110' }] },
      proposal,
    };
    return {
      conversationId: 'c1',
      clientId: 'skylink-air',
      state,
      stateAtTurnStart: state,
      logger: createLogger('silent'),
      api: { request } as never,
      idempotency: createMemoryIdempotencyStore(),
      audit,
    };
  }
  const deps = {
    registry: new Map([[changeTool.name, changeTool]]),
    allowed: ['change_flight'],
    rules: [],
  };

  it('reconciles a write whose answer was lost instead of reporting a failure', async () => {
    // Propose first, then approve exactly that proposal.
    const readOnly = vi.fn(async () => ok(booking('OLD-1')));
    const proposed = await dispatch(
      'change_flight',
      { bookingRef: 'SK1001', newFlightId: 'NEW-1' },
      ctxWith(readOnly),
      deps,
    );
    expect(proposed.approvalStage).toBe('proposed');
    const approved: Proposal = { ...proposed.patch.proposal!, status: 'approved' };

    // The POST times out, but the change actually happened: the next read shows the new flight.
    let writes = 0;
    const request = vi.fn(async (req: { method?: string }) => {
      if (req.method === 'POST') {
        writes++;
        return fail('UNAVAILABLE', 'timed out');
      }
      return ok(writes > 0 ? { ...booking('NEW-1'), flight: flight('NEW-1') } : booking('OLD-1'));
    });
    const audit = vi.fn();
    const out = await dispatch(
      'change_flight',
      { bookingRef: 'SK1001', newFlightId: 'NEW-1' },
      ctxWith(request, approved, audit),
      deps,
    );
    expect(out.result.ok).toBe(true);
    expect(out.approvalStage).toBe('executing');
    expect(audit).toHaveBeenCalledWith('mutation_reconciled', expect.anything());
    expect(writes).toBe(1); // reconciled, not retried a second time
  });

  it('reports the failure when the change really did not happen', async () => {
    const readOnly = vi.fn(async () => ok(booking('OLD-1')));
    const proposed = await dispatch(
      'change_flight',
      { bookingRef: 'SK1001', newFlightId: 'NEW-1' },
      ctxWith(readOnly),
      deps,
    );
    const approved: Proposal = { ...proposed.patch.proposal!, status: 'approved' };
    const request = vi.fn(async (req: { method?: string }) =>
      req.method === 'POST' ? fail('UNAVAILABLE', 'down') : ok(booking('OLD-1')),
    );
    const out = await dispatch(
      'change_flight',
      { bookingRef: 'SK1001', newFlightId: 'NEW-1' },
      ctxWith(request, approved),
      deps,
    );
    expect(out.result).toMatchObject({ ok: false, error: 'UNAVAILABLE' });
  });

  it('refuses to run when the booking changed after the customer approved', async () => {
    const readOnly = vi.fn(async () => ok(booking('OLD-1')));
    const proposed = await dispatch(
      'change_flight',
      { bookingRef: 'SK1001', newFlightId: 'NEW-1' },
      ctxWith(readOnly),
      deps,
    );
    const approved: Proposal = { ...proposed.patch.proposal!, status: 'approved' };
    // Someone else moved the booking in the meantime, so the binding no longer matches.
    const request = vi.fn(async () => ok(booking('OTHER-9')));
    const out = await dispatch(
      'change_flight',
      { bookingRef: 'SK1001', newFlightId: 'NEW-1' },
      ctxWith(request, approved),
      deps,
    );
    expect(out.approvalStage).toBe('proposed');
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ method: 'POST' }));
  });
});
