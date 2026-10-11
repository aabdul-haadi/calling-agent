export const AUDIT_TYPES = [
  'proposal_created',
  'approval_granted',
  'approval_rejected',
  'approval_expired',
  'mutation_executed',
  'mutation_failed',
  'mutation_reconciled',
  'phase_refused',
  'handoff_accepted',
  'human_reply',
  'handoff_resolved',
] as const;
export type AuditType = (typeof AUDIT_TYPES)[number];

/** An append-only record of a decision that mattered: who/what, when, and the exact values. */
export interface AuditEvent {
  type: AuditType;
  at: string;
  data: Record<string, unknown>;
}

export const auditEvent = (type: AuditType, data: Record<string, unknown>): AuditEvent => ({
  type,
  at: new Date().toISOString(),
  data,
});
