import { Check, CheckCheck, ExternalLink, Send, ShieldAlert, User } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { HandoffView } from '@adk/shared';
import { classifyEvent, toolName } from '@/components/trace/trace-model';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/state-views';
import { useTenant } from '@/context/tenant';
import { useAsync } from '@/hooks/use-async';
import { cn, formatDateTime, relativeTime } from '@/lib/utils';
import { api } from '@/services/api';

type StatusFilter = 'all' | 'pending' | 'accepted' | 'resolved';

/** Priority is derived from the customer's tone at handoff time; the backend has no priority field. */
export function priorityOf(h: HandoffView): {
  label: 'High' | 'Medium' | 'Normal';
  tone: 'danger' | 'warn' | 'neutral';
} {
  if (h.sentiment === 'angry') return { label: 'High', tone: 'danger' };
  if (h.sentiment === 'frustrated') return { label: 'Medium', tone: 'warn' };
  return { label: 'Normal', tone: 'neutral' };
}

function Context({ handoff }: { handoff: HandoffView }) {
  const view = useAsync(() => api.conversation(handoff.conversationId), [handoff.conversationId]);
  if (view.loading) return <Skeleton className="h-24" />;
  if (view.error || !view.data)
    return (
      <p className="text-sm text-muted-foreground">
        The conversation context is not available ({view.error ?? 'not found'}). Test-run handoffs
        are kept in memory and have no stored conversation.
      </p>
    );
  const tools = view.data.trace.filter((e) => e.type === 'tool');
  const concerns = view.data.trace.filter((e) => {
    const { kind } = classifyEvent(e);
    return (
      e.status !== 'ok' &&
      (kind === 'authorization' || kind === 'policy' || kind === 'guard' || e.status === 'error')
    );
  });
  return (
    <div className="space-y-4">
      <section>
        <h3 className="eyebrow mb-1.5">Tool executions</h3>
        {tools.length === 0 ? (
          <p className="text-sm text-muted-foreground">The agent did not call any tools.</p>
        ) : (
          <ol className="space-y-1">
            {tools.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0 truncate">
                  <span className="font-mono text-xs">{toolName(e)}</span>
                  <span className="text-muted-foreground"> · {e.label}</span>
                </span>
                <Badge tone={e.status === 'ok' ? 'ok' : e.status === 'warn' ? 'warn' : 'danger'}>
                  {e.status === 'ok' ? 'ok' : e.status === 'warn' ? 'blocked' : 'failed'}
                </Badge>
              </li>
            ))}
          </ol>
        )}
      </section>
      <section>
        <h3 className="eyebrow mb-1.5">Policy and safety concerns</h3>
        {concerns.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No blocked actions or failures were recorded before the handoff.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {concerns.map((e) => (
              <li key={e.id} className="flex gap-2 text-sm">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden="true" />
                <span>{classifyEvent(e).outcome ?? e.label}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <Link
        to={`/traces?c=${handoff.conversationId}`}
        className="inline-flex items-center gap-1.5 text-sm text-accent underline-offset-2 hover:underline"
      >
        Open the full trace <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
      </Link>
    </div>
  );
}

/** The conversation so far and the human's reply box. Refreshes while the handoff is open. */
function Conversation({ handoff, onChanged }: { handoff: HandoffView; onChanged: () => void }) {
  const open = handoff.status === 'accepted';
  const view = useAsync(
    () => api.conversation(handoff.conversationId),
    [handoff.conversationId],
    open ? 3000 : undefined,
  );
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<'send' | 'resolve'>();
  const [error, setError] = useState<string>();

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft.trim() || busy) return;
    setBusy('send');
    setError(undefined);
    try {
      await api.replyHandoff(handoff.id, draft.trim());
      setDraft('');
      view.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send');
    } finally {
      setBusy(undefined);
    }
  };

  const resolve = async () => {
    setBusy('resolve');
    setError(undefined);
    try {
      await api.resolveHandoff(handoff.id);
      view.reload();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not resolve');
    } finally {
      setBusy(undefined);
    }
  };

  const labels = { user: 'Customer', assistant: 'AI agent', human: 'Human colleague' } as const;
  return (
    <section aria-label="Conversation">
      <h3 className="eyebrow mb-1.5">Conversation</h3>
      {view.loading ? (
        <Skeleton className="h-24" />
      ) : view.error || !view.data ? (
        <p className="text-sm text-muted-foreground">
          The conversation is not available ({view.error ?? 'not found'}). Test-run handoffs are
          kept in memory and have no stored conversation.
        </p>
      ) : (
        <ol
          aria-label="Conversation messages"
          className="max-h-72 space-y-1.5 overflow-y-auto text-sm"
        >
          {view.data.messages.map((m, i) => (
            <li
              key={i}
              className={cn(
                'rounded-md px-3 py-2',
                m.role === 'user' && 'bg-accent/10',
                m.role === 'assistant' && 'border border-border bg-elevated',
                m.role === 'human' && 'border border-accent-2/50 bg-accent-2/10',
              )}
            >
              <span className="font-medium">{labels[m.role]}: </span>
              {m.content}
            </li>
          ))}
        </ol>
      )}

      {handoff.status === 'resolved' ? (
        <p className="mt-3 flex items-center gap-1.5 text-sm text-ok">
          <CheckCheck className="h-4 w-4" aria-hidden="true" /> Resolved. The customer was told.
        </p>
      ) : (
        <form onSubmit={send} className="mt-3 space-y-2">
          <label htmlFor={`reply-${handoff.id}`} className="eyebrow block">
            Reply to the customer
          </label>
          <textarea
            id={`reply-${handoff.id}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            maxLength={2000}
            disabled={!open || busy !== undefined}
            placeholder={open ? 'Write as the human agent…' : 'Accept the handoff to reply.'}
            className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground/70 disabled:opacity-60"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={!open || !draft.trim() || busy !== undefined}>
              <Send className="h-3.5 w-3.5" aria-hidden="true" /> Send reply
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={resolve}
              disabled={!open || busy !== undefined}
            >
              <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" /> Resolve
            </Button>
            <span className="text-xs text-muted-foreground">
              The customer sees replies in their chat within a few seconds.
            </span>
          </div>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
        </form>
      )}
    </section>
  );
}

function Detail({
  handoff,
  accepting,
  onAccept,
  onChanged,
}: {
  handoff: HandoffView;
  accepting: boolean;
  onAccept: (id: string) => void;
  onChanged: () => void;
}) {
  const accepted = handoff.status !== 'pending';
  const priority = priorityOf(handoff);
  return (
    <Card className="space-y-4 p-4" aria-label="Handoff details">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="eyebrow">Why the AI handed over</p>
          <h2 className="mt-1 text-lg font-semibold leading-snug">{handoff.reason}</h2>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge tone={priority.tone}>Priority: {priority.label}</Badge>
            <Badge
              tone={
                handoff.sentiment === 'angry'
                  ? 'danger'
                  : handoff.sentiment === 'frustrated'
                    ? 'warn'
                    : 'neutral'
              }
            >
              Customer tone: {handoff.sentiment}
            </Badge>
            <Badge tone="accent">{handoff.clientId}</Badge>
          </div>
        </div>
        {accepted ? (
          <Badge tone="ok">
            <Check className="h-3 w-3" aria-hidden="true" />{' '}
            {handoff.status === 'resolved' ? 'Resolved' : 'Accepted'}
          </Badge>
        ) : (
          <Button
            onClick={() => onAccept(handoff.id)}
            disabled={accepting}
            aria-label={`Accept handoff from ${handoff.customerMasked}`}
          >
            Accept handoff
          </Button>
        )}
      </div>

      <section>
        <h3 className="eyebrow mb-1.5">Summary for the human agent</h3>
        <ul className="list-disc space-y-0.5 pl-5 text-sm">
          {handoff.summary.lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">
          Intent: {handoff.summary.intent.replace(/_/g, ' ')} · Identity{' '}
          {handoff.summary.verified ? 'verified' : 'not verified'} · Customer{' '}
          {handoff.customerMasked}
        </p>
      </section>

      <section>
        <h3 className="eyebrow mb-1.5">What the AI already tried</h3>
        {handoff.summary.tried.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing yet.</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {handoff.summary.tried.map((t, i) => (
              <li key={i}>
                <Badge>{t}</Badge>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Conversation handoff={handoff} onChanged={onChanged} />
      <Context handoff={handoff} />
      <p className="border-t border-border pt-3 text-xs text-muted-foreground">
        There is no login yet, so anyone who can open this page can act as the human agent, and
        assignment to a named agent is not supported.
      </p>
    </Card>
  );
}

export function HandoffsPage() {
  const { clients, tenant } = useTenant();
  // Poll so a handoff triggered in another tab shows up without a refresh.
  const handoffs = useAsync(() => api.handoffs(), [], 4000);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [everyTenant, setEveryTenant] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [accepting, setAccepting] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const detailRef = useRef<HTMLDivElement>(null);

  const all = handoffs.data ?? [];
  const scoped = everyTenant || !tenant ? all : all.filter((h) => h.clientId === tenant.id);
  const shown = scoped.filter((h) => status === 'all' || h.status === status);
  const selected = shown.find((h) => h.id === selectedId) ?? shown[0];
  const pending = scoped.filter((h) => h.status === 'pending').length;

  const accept = async (id: string) => {
    setAccepting(id);
    setActionError(undefined);
    try {
      await api.acceptHandoff(id);
      handoffs.reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not accept');
    } finally {
      setAccepting(undefined);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Human handoffs"
        title="Human handoffs"
        description={
          handoffs.data
            ? `${pending} waiting for a human.`
            : 'Customers the AI passed to a person appear here.'
        }
        actions={
          <>
            {clients.length > 1 && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={everyTenant}
                  onChange={(e) => setEveryTenant(e.target.checked)}
                  className="h-4 w-4 accent-[hsl(var(--accent))]"
                />
                All tenants
              </label>
            )}
            <Segmented<StatusFilter>
              ariaLabel="Filter by status"
              value={status}
              onChange={setStatus}
              options={[
                { value: 'all', label: 'All', count: scoped.length },
                { value: 'pending', label: 'Waiting', count: pending },
                {
                  value: 'accepted',
                  label: 'Accepted',
                  count: scoped.filter((h) => h.status === 'accepted').length,
                },
                {
                  value: 'resolved',
                  label: 'Resolved',
                  count: scoped.filter((h) => h.status === 'resolved').length,
                },
              ]}
            />
          </>
        }
      />
      {actionError && <ErrorState message={actionError} />}
      {handoffs.loading ? (
        <div
          role="status"
          aria-label="Loading handoffs"
          className="grid grid-cols-1 gap-4 lg:grid-cols-[22rem_1fr]"
        >
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      ) : handoffs.error ? (
        <ErrorState message={handoffs.error} onRetry={handoffs.reload} />
      ) : shown.length === 0 ? (
        <EmptyState
          asset="allClear"
          title={status === 'all' ? 'Nobody is waiting' : 'Nothing in this view'}
          hint="When the agent hands a customer over, they will show up here with a summary and the reason."
        />
      ) : (
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
          <ul
            aria-label="Handoff queue"
            className="space-y-2 lg:max-h-[calc(100vh-14rem)] lg:overflow-y-auto"
          >
            {shown.map((h) => {
              const p = priorityOf(h);
              return (
                <li key={h.id}>
                  <button
                    type="button"
                    aria-pressed={selected?.id === h.id}
                    onClick={() => {
                      setSelectedId(h.id);
                      detailRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
                    }}
                    className={cn(
                      'w-full rounded-md border border-border bg-card p-3 text-left transition-colors hover:border-accent/40 hover:bg-elevated',
                      selected?.id === h.id && 'border-accent/60 bg-accent/5',
                    )}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-2">
                        <User
                          className="h-4 w-4 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                        <span className="truncate text-sm font-medium">{h.customerMasked}</span>
                      </span>
                      <time
                        dateTime={h.createdAt}
                        title={formatDateTime(h.createdAt)}
                        className="shrink-0 text-xs text-muted-foreground"
                      >
                        {relativeTime(h.createdAt)}
                      </time>
                    </span>
                    <span className="mt-1.5 block text-sm">{h.reason}</span>
                    <span className="mt-2 flex flex-wrap gap-1.5">
                      <Badge tone={p.tone}>{p.label}</Badge>
                      <Badge
                        tone={
                          h.status === 'pending'
                            ? 'warn'
                            : h.status === 'accepted'
                              ? 'accent'
                              : 'ok'
                        }
                      >
                        {h.status === 'pending'
                          ? 'Waiting'
                          : h.status === 'accepted'
                            ? 'Accepted'
                            : 'Resolved'}
                      </Badge>
                      <Badge tone="accent">{h.clientId}</Badge>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div ref={detailRef} className="min-w-0 scroll-mt-20">
            {selected && (
              <Detail
                key={selected.id}
                handoff={selected}
                accepting={accepting === selected.id}
                onAccept={accept}
                onChanged={handoffs.reload}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
