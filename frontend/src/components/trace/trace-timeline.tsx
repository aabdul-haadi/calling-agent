import {
  Brain,
  BookOpen,
  ChevronRight,
  Cpu,
  Headset,
  Mic,
  OctagonAlert,
  ShieldCheck,
  ShieldQuestion,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import type { TraceEvent, TraceStatus } from '@adk/shared';
import { Badge } from '@/components/ui/badge';
import { JsonView } from '@/components/ui/json-view';
import { cn, formatDuration, formatTime } from '@/lib/utils';
import { classifyEvent, toolName, type EventKind, type Turn } from './trace-model';

const ICONS: Record<EventKind, LucideIcon> = {
  understanding: Brain,
  retrieval: BookOpen,
  tool: Wrench,
  authorization: ShieldCheck,
  policy: ShieldCheck,
  approval: ShieldQuestion,
  state: ShieldCheck,
  handoff: Headset,
  model: Cpu,
  voice: Mic,
  guard: OctagonAlert,
};

export const KIND_LABEL: Record<EventKind, string> = {
  understanding: 'Understanding',
  retrieval: 'Retrieval',
  tool: 'Tool call',
  authorization: 'Authorization',
  policy: 'Policy check',
  approval: 'Approval',
  state: 'State',
  handoff: 'Handoff',
  model: 'Model',
  voice: 'Voice',
  guard: 'Safety guard',
};

const TONE: Record<TraceStatus, string> = {
  ok: 'text-ok border-ok/40 bg-ok/10',
  warn: 'text-warn border-warn/40 bg-warn/10',
  error: 'text-danger border-danger/40 bg-danger/10',
};
const STATUS_TEXT: Record<TraceStatus, string> = {
  ok: 'Succeeded',
  warn: 'Needs attention',
  error: 'Failed',
};

function EventRow({ event, maxMs }: { event: TraceEvent; maxMs: number }) {
  const [open, setOpen] = useState(false);
  const { kind, outcome } = classifyEvent(event);
  const Icon = ICONS[kind];
  const tool = toolName(event);
  const hasDetail = event.detail !== undefined && event.detail !== null;
  const detailId = `detail-${event.id}`;
  return (
    <li className="relative pl-9">
      <span
        aria-hidden="true"
        className={cn(
          'absolute left-0 top-0.5 flex h-6 w-6 items-center justify-center rounded-md border',
          TONE[event.status],
        )}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
      <button
        type="button"
        disabled={!hasDetail}
        aria-expanded={hasDetail ? open : undefined}
        aria-controls={hasDetail ? detailId : undefined}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'group flex w-full items-start gap-2 rounded-md text-left',
          hasDetail && 'hover:bg-elevated/70',
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="block text-sm leading-snug">
            <span className="sr-only">{STATUS_TEXT[event.status]}: </span>
            {event.label}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.7rem] text-muted-foreground">
            <span className="font-medium">{KIND_LABEL[kind]}</span>
            {tool && <span className="font-mono text-foreground/80">{tool}</span>}
            {outcome && (
              <Badge tone={event.status === 'error' ? 'danger' : 'warn'}>{outcome}</Badge>
            )}
            <time dateTime={event.at} className="tabular-nums">
              {formatTime(event.at)}
            </time>
          </span>
          {event.latencyMs !== undefined && (
            <span className="mt-1.5 flex items-center gap-2" aria-hidden="true">
              <span className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                <span
                  className={cn(
                    'block h-full rounded-full',
                    event.status === 'error'
                      ? 'bg-danger'
                      : event.status === 'warn'
                        ? 'bg-warn'
                        : 'bg-accent',
                  )}
                  style={{ width: `${Math.max(4, (event.latencyMs / Math.max(1, maxMs)) * 100)}%` }}
                />
              </span>
            </span>
          )}
        </span>
        {event.latencyMs !== undefined && (
          <span className="shrink-0 pt-0.5 font-mono text-xs tabular-nums text-muted-foreground">
            {formatDuration(event.latencyMs)}
          </span>
        )}
        {hasDetail && (
          <ChevronRight
            aria-hidden="true"
            className={cn(
              'mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200',
              open && 'rotate-90',
            )}
          />
        )}
      </button>
      {/* grid-rows animates height without measuring it */}
      <div
        id={detailId}
        className={cn(
          'grid transition-[grid-template-rows] duration-200 ease-out',
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
      >
        <div className="overflow-hidden">
          {open && (
            <div className="pb-1 pt-2">
              <JsonView value={event.detail} label={`Details for ${event.label}`} />
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

export function TurnBlock({ turn }: { turn: Turn }) {
  const maxMs = Math.max(1, ...turn.events.map((e) => e.latencyMs ?? 0));
  return (
    <section aria-label={`Turn ${turn.index}`} className="relative">
      <div className="mb-2 flex items-center gap-2 text-xs">
        <span className="eyebrow">Turn {turn.index}</span>
        <time dateTime={turn.startedAt} className="tabular-nums text-muted-foreground">
          {formatTime(turn.startedAt)}
        </time>
        <span className="h-px flex-1 bg-border" aria-hidden="true" />
        <Badge tone={turn.status === 'ok' ? 'ok' : turn.status === 'warn' ? 'warn' : 'danger'}>
          {STATUS_TEXT[turn.status]}
        </Badge>
        <span className="font-mono tabular-nums text-muted-foreground">
          {formatDuration(turn.totalMs)}
        </span>
      </div>
      <ol className="relative space-y-3 before:absolute before:bottom-2 before:left-3 before:top-2 before:w-px before:bg-border">
        {turn.events.map((e) => (
          <EventRow key={e.id} event={e} maxMs={maxMs} />
        ))}
      </ol>
    </section>
  );
}

/** Hierarchical timeline: turns, each with its steps. Pass already-filtered turns. */
export function TraceTimeline({ turns }: { turns: Turn[] }) {
  return (
    <div className="space-y-6" aria-label="Execution timeline">
      {turns.map((t) => (
        <TurnBlock key={t.index} turn={t} />
      ))}
    </div>
  );
}
