import { Search } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { ConversationSummary, TraceStatus } from '@adk/shared';
import {
  groupTurns,
  filterTurns,
  NO_FILTER,
  type EventKind,
  type TraceFilter,
} from '@/components/trace/trace-model';
import { KIND_LABEL, TraceTimeline } from '@/components/trace/trace-timeline';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { JsonView } from '@/components/ui/json-view';
import { PageHeader } from '@/components/ui/page-header';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/state-views';
import { useTenant } from '@/context/tenant';
import { useAsync } from '@/hooks/use-async';
import { cn, relativeTime } from '@/lib/utils';
import { api } from '@/services/api';

const PHASE_TONE = (c: ConversationSummary) =>
  c.handedOff
    ? 'warn'
    : c.awaitingApproval
      ? 'warn'
      : c.phase === 'COMPLETED'
        ? 'ok'
        : c.phase === 'FAILED'
          ? 'danger'
          : 'neutral';

function ConversationList({
  items,
  selected,
  onSelect,
}: {
  items: ConversationSummary[];
  selected?: string;
  onSelect: (id: string) => void;
}) {
  return (
    <ul aria-label="Conversations" className="space-y-1.5">
      {items.map((c) => (
        <li key={c.id}>
          <button
            type="button"
            onClick={() => onSelect(c.id)}
            aria-pressed={selected === c.id}
            className={cn(
              'w-full rounded-md border border-border bg-card p-2.5 text-left text-sm transition-colors hover:border-accent/40 hover:bg-elevated',
              selected === c.id && 'border-accent/60 bg-accent/5',
            )}
          >
            <span className="flex items-center justify-between gap-2">
              <span className="truncate font-mono text-xs">{c.id.slice(0, 8)}</span>
              <span className="text-xs text-muted-foreground">{relativeTime(c.updatedAt)}</span>
            </span>
            <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <Badge tone={PHASE_TONE(c)}>{c.phase.replace(/_/g, ' ').toLowerCase()}</Badge>
              <span className="text-xs text-muted-foreground">{c.messageCount} messages</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Explorer({ conversationId }: { conversationId: string }) {
  const view = useAsync(() => api.conversation(conversationId), [conversationId]);
  const audit = useAsync(() => api.audit(conversationId), [conversationId]);
  const [filter, setFilter] = useState<TraceFilter>(NO_FILTER);

  if (view.loading) return <Skeleton className="h-96" />;
  if (view.error || !view.data)
    return <ErrorState message={view.error ?? 'Not found'} onRetry={view.reload} />;

  const turns = groupTurns(view.data.trace);
  const shown = filterTurns(turns, filter);
  const events = view.data.trace;
  const failures = events.filter((e) => e.status === 'error').length;
  const warnings = events.filter((e) => e.status === 'warn').length;
  const kinds = [...new Set(events.map((e) => e.type))];

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
          <div className="min-w-0">
            <dt className="eyebrow">Conversation ID</dt>
            <dd className="truncate font-mono text-xs" title={conversationId}>
              {conversationId}
            </dd>
          </div>
          <div>
            <dt className="eyebrow">Tenant</dt>
            <dd>{view.data.clientId}</dd>
          </div>
          <div>
            <dt className="eyebrow">Phase</dt>
            <dd>{(view.data.state.phase ?? 'NEW').replace(/_/g, ' ').toLowerCase()}</dd>
          </div>
          <div>
            <dt className="eyebrow">Steps</dt>
            <dd>
              {events.length} · {failures} failed · {warnings} warnings
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-muted-foreground">
          Tool inputs and outputs are masked on the server before they are stored (booking
          references, names, e-mail and phone numbers), so what you see here is already redacted.
          The raw model prompt and response are not stored.
        </p>
      </Card>

      <div className="flex flex-wrap items-end gap-3">
        <label className="relative min-w-[14rem] flex-1">
          <span className="sr-only">Search the trace</span>
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            value={filter.query}
            onChange={(e) => setFilter({ ...filter, query: e.target.value })}
            placeholder="Search labels, tools, JSON…"
            className="h-10 w-full rounded-md border border-border bg-card pl-9 pr-3 text-sm"
          />
        </label>
        <Segmented<TraceStatus | 'all'>
          ariaLabel="Filter by status"
          value={filter.status}
          onChange={(status) => setFilter({ ...filter, status })}
          options={[
            { value: 'all', label: 'All' },
            { value: 'ok', label: 'OK' },
            { value: 'warn', label: 'Warnings' },
            { value: 'error', label: 'Failures' },
          ]}
        />
        <label className="text-xs">
          <span className="sr-only">Filter by step type</span>
          <select
            value={filter.kind}
            onChange={(e) => setFilter({ ...filter, kind: e.target.value as EventKind | 'all' })}
            className="h-10 rounded-md border border-border bg-card px-2 text-sm"
          >
            <option value="all">All step types</option>
            {(Object.keys(KIND_LABEL) as EventKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {events.length === 0 ? (
        <EmptyState title="No steps recorded" hint="This conversation has no trace events yet." />
      ) : shown.length === 0 ? (
        <EmptyState
          title="Nothing matches those filters"
          hint={`Recorded step types: ${kinds.join(', ')}.`}
          action={
            <button
              type="button"
              className="text-sm underline"
              onClick={() => setFilter(NO_FILTER)}
            >
              Clear filters
            </button>
          }
        />
      ) : (
        <Card className="p-4">
          <TraceTimeline turns={shown} />
        </Card>
      )}

      <Card className="p-4">
        <h2 className="eyebrow mb-2">Audit log</h2>
        {audit.data && audit.data.length > 0 ? (
          <JsonView value={audit.data} label="Audit log entries" maxHeight="max-h-72" />
        ) : (
          <p className="text-sm text-muted-foreground">
            No audited decisions in this conversation (no change was proposed, approved or made).
          </p>
        )}
      </Card>
    </div>
  );
}

export function TracesPage() {
  const { tenant } = useTenant();
  const [params, setParams] = useSearchParams();
  const list = useAsync(() => api.conversations(tenant?.id, 40), [tenant?.id], 6000);
  const selected = params.get('c') ?? list.data?.[0]?.id;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Traces"
        title="Traces"
        description="Pick a conversation to see every turn: what the agent understood, the policies it read, each tool call and the rules that allowed or blocked it."
      />
      {list.error ? (
        <ErrorState message={list.error} onRetry={list.reload} />
      ) : list.loading ? (
        <div
          role="status"
          aria-label="Loading conversations"
          className="grid grid-cols-1 gap-4 lg:grid-cols-[18rem_1fr]"
        >
          <Skeleton className="h-80" />
          <Skeleton className="h-80" />
        </div>
      ) : !list.data || list.data.length === 0 ? (
        <EmptyState
          title="No conversations yet"
          hint="Start a chat in the Agent Console and its trace will show up here."
        />
      ) : (
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <div className="max-h-[calc(100vh-14rem)] overflow-y-auto lg:sticky lg:top-20">
            <ConversationList
              items={list.data}
              selected={selected}
              onSelect={(id) => setParams({ c: id })}
            />
          </div>
          {selected && <Explorer key={selected} conversationId={selected} />}
        </div>
      )}
    </div>
  );
}
