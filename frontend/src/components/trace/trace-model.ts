import type { TraceEvent, TraceStatus } from '@adk/shared';

export interface Turn {
  index: number;
  events: TraceEvent[];
  startedAt: string;
  /** Sum of recorded latencies in the turn. */
  totalMs: number;
  /** Worst status in the turn. */
  status: TraceStatus;
}

const RANK: Record<TraceStatus, number> = { ok: 0, warn: 1, error: 2 };

/** A turn starts at each "intent" event (the engine always records one first). */
export function groupTurns(events: TraceEvent[]): Turn[] {
  const turns: TraceEvent[][] = [];
  for (const e of events) {
    if (e.type === 'intent' || turns.length === 0) turns.push([]);
    turns[turns.length - 1]!.push(e);
  }
  return turns.map((evs, i) => ({
    index: i + 1,
    events: evs,
    startedAt: evs[0]!.at,
    totalMs: evs.reduce((n, e) => n + (e.latencyMs ?? 0), 0),
    status: evs.reduce<TraceStatus>((w, e) => (RANK[e.status] > RANK[w] ? e.status : w), 'ok'),
  }));
}

export type EventKind =
  | 'understanding'
  | 'retrieval'
  | 'tool'
  | 'authorization'
  | 'policy'
  | 'approval'
  | 'state'
  | 'handoff'
  | 'model'
  | 'voice'
  | 'guard';

interface ToolDetail {
  tool?: string;
  input?: unknown;
  output?: { error?: string; message?: string } & Record<string, unknown>;
}

/** What kind of step this is, in the words an engineer would use. Authorization and policy outcomes are called out. */
export function classifyEvent(e: TraceEvent): { kind: EventKind; outcome?: string } {
  if (e.type === 'tool') {
    const out = (e.detail as ToolDetail | undefined)?.output;
    const code = out?.error;
    if (code === 'AUTH_REQUIRED' || code === 'UNAUTHORIZED')
      return { kind: 'authorization', outcome: 'Authorization denied' };
    if (code === 'RULE_BLOCKED') return { kind: 'policy', outcome: 'Blocked by a business rule' };
    if (code === 'UNAVAILABLE') return { kind: 'tool', outcome: 'Company system unavailable' };
    if (code === 'INVALID_ARGS') return { kind: 'tool', outcome: 'Rejected: invalid arguments' };
    if (code === 'NOT_FOUND') return { kind: 'tool', outcome: 'Not found' };
    if ((e.detail as { awaitingApproval?: boolean } | undefined)?.awaitingApproval)
      return { kind: 'approval', outcome: 'Proposed, waiting for approval' };
    return { kind: 'tool' };
  }
  const map: Record<string, EventKind> = {
    intent: 'understanding',
    knowledge: 'retrieval',
    approval: 'approval',
    state: 'state',
    handoff: 'handoff',
    llm: 'model',
    voice: 'voice',
    guard: 'guard',
  };
  return { kind: map[e.type] ?? 'state' };
}

export function toolName(e: TraceEvent): string | undefined {
  return (e.detail as ToolDetail | undefined)?.tool;
}

export interface TraceFilter {
  query: string;
  status: TraceStatus | 'all';
  kind: EventKind | 'all';
}

export const NO_FILTER: TraceFilter = { query: '', status: 'all', kind: 'all' };

/** Search matches the label, tool name and the JSON detail, so "SK1001" or "RULE_BLOCKED" both work. */
export function matchesFilter(e: TraceEvent, f: TraceFilter): boolean {
  if (f.status !== 'all' && e.status !== f.status) return false;
  if (f.kind !== 'all' && classifyEvent(e).kind !== f.kind) return false;
  const q = f.query.trim().toLowerCase();
  if (!q) return true;
  const hay =
    `${e.label} ${toolName(e) ?? ''} ${e.type} ${JSON.stringify(e.detail ?? '')}`.toLowerCase();
  return hay.includes(q);
}

export function filterTurns(turns: Turn[], f: TraceFilter): Turn[] {
  return turns
    .map((t) => ({ ...t, events: t.events.filter((e) => matchesFilter(e, f)) }))
    .filter((t) => t.events.length > 0);
}
