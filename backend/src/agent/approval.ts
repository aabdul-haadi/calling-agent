import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/** How long a customer has to say yes to a proposed change. */
export const PROPOSAL_TTL_MS = 10 * 60 * 1000;

export const bindingSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));
export type Binding = z.infer<typeof bindingSchema>;

export const PROPOSAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'expired',
  'executed',
] as const;

/**
 * A change the agent wants to make, frozen at the moment it was proposed. `binding` holds the exact
 * values the customer is agreeing to (booking, target flight, what the booking looked like then).
 * The tool only runs if a fresh look at the world still produces the same binding.
 */
export const proposalSchema = z.object({
  id: z.string(),
  tool: z.string(),
  summary: z.string(),
  binding: bindingSchema,
  customerId: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  status: z.enum(PROPOSAL_STATUSES),
});
export type Proposal = z.infer<typeof proposalSchema>;

/** What the customer's latest message says about the pending proposal (decided by the classifier). */
export type Confirmation = 'yes' | 'no' | 'none';

export function createProposal(
  tool: string,
  summary: string,
  binding: Binding,
  customerId: string,
  now = Date.now(),
): Proposal {
  return {
    id: randomUUID(),
    tool,
    summary,
    binding,
    customerId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + PROPOSAL_TTL_MS).toISOString(),
    status: 'pending',
  };
}

export const sameBinding = (a: Binding, b: Binding): boolean => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

export type ApprovalEvent = 'approved' | 'rejected' | 'expired';

/**
 * Runs once at the start of a customer turn, BEFORE the model is called, so no model output can
 * influence it. Only a proposal made in an earlier turn is ever pending here, which means a yes can
 * never come from the same turn that proposed the change.
 *  - an approved proposal that was not used last turn is dead (approval covers one turn)
 *  - a pending proposal past its expiry is dead
 *  - "yes" approves it, "no" rejects it, anything else leaves it pending
 */
export function resolveProposal(
  proposal: Proposal | undefined,
  confirmation: Confirmation,
  now = Date.now(),
): { proposal: Proposal | undefined; event?: ApprovalEvent } {
  if (!proposal) return { proposal };
  if (proposal.status === 'approved' || Date.parse(proposal.expiresAt) <= now) {
    return proposal.status === 'pending' || proposal.status === 'approved'
      ? { proposal: { ...proposal, status: 'expired' }, event: 'expired' }
      : { proposal };
  }
  if (proposal.status !== 'pending') return { proposal };
  if (confirmation === 'yes')
    return { proposal: { ...proposal, status: 'approved' }, event: 'approved' };
  if (confirmation === 'no')
    return { proposal: { ...proposal, status: 'rejected' }, event: 'rejected' };
  return { proposal };
}

/** Is this approved proposal valid for exactly this call, right now? */
export function isApprovedFor(
  proposal: Proposal | undefined,
  tool: string,
  customerId: string | undefined,
  binding: Binding,
  now = Date.now(),
): boolean {
  return (
    proposal !== undefined &&
    proposal.status === 'approved' &&
    proposal.tool === tool &&
    proposal.customerId === customerId &&
    Date.parse(proposal.expiresAt) > now &&
    sameBinding(proposal.binding, binding)
  );
}
