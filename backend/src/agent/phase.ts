/**
 * Explicit conversation phases. The model never sets the phase: the engine moves it, and only along
 * the edges in TRANSITIONS. An event with no edge from the current phase is refused (and traced).
 */
export const PHASES = [
  'NEW',
  'VERIFYING',
  'VERIFIED',
  'PLANNING',
  'AWAITING_APPROVAL',
  'EXECUTING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'HANDOFF',
] as const;
export type Phase = (typeof PHASES)[number];

export type PhaseEvent =
  | 'message' // first customer message
  | 'identity_verified'
  | 'tool_ok' // a read tool succeeded: we are working on a plan
  | 'proposal_created'
  | 'approval_granted'
  | 'approval_rejected'
  | 'approval_expired'
  | 'executed'
  | 'execution_failed'
  | 'cancelled'
  | 'reopened' // a new request after a finished one
  | 'handoff';

const WORKING: Phase[] = ['VERIFYING', 'VERIFIED', 'PLANNING'];

const TRANSITIONS: Record<Phase, Partial<Record<PhaseEvent, Phase>>> = {
  NEW: { message: 'VERIFYING', identity_verified: 'VERIFIED', handoff: 'HANDOFF' },
  VERIFYING: { identity_verified: 'VERIFIED', handoff: 'HANDOFF', cancelled: 'CANCELLED' },
  VERIFIED: {
    tool_ok: 'PLANNING',
    proposal_created: 'AWAITING_APPROVAL',
    handoff: 'HANDOFF',
    cancelled: 'CANCELLED',
  },
  PLANNING: {
    tool_ok: 'PLANNING',
    proposal_created: 'AWAITING_APPROVAL',
    handoff: 'HANDOFF',
    cancelled: 'CANCELLED',
  },
  AWAITING_APPROVAL: {
    approval_granted: 'EXECUTING',
    approval_rejected: 'PLANNING',
    approval_expired: 'PLANNING',
    proposal_created: 'AWAITING_APPROVAL', // a different change replaces the pending one
    handoff: 'HANDOFF',
    cancelled: 'CANCELLED',
  },
  EXECUTING: {
    executed: 'COMPLETED',
    execution_failed: 'FAILED',
    approval_expired: 'PLANNING',
    proposal_created: 'AWAITING_APPROVAL', // a different change needs its own approval
    handoff: 'HANDOFF',
    cancelled: 'CANCELLED',
  },
  COMPLETED: { reopened: 'VERIFIED', handoff: 'HANDOFF' },
  FAILED: { reopened: 'VERIFIED', handoff: 'HANDOFF' },
  CANCELLED: { reopened: 'VERIFIED', handoff: 'HANDOFF' },
  HANDOFF: {},
};

/** The next phase, or null when the event is not allowed from `from`. */
export function transition(from: Phase, event: PhaseEvent): Phase | null {
  return TRANSITIONS[from][event] ?? null;
}

export const isWorking = (p: Phase): boolean => WORKING.includes(p);
