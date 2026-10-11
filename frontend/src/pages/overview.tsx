import { ArrowRight, Info } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { OverviewMetrics } from '@adk/shared';
import { AgentOrb } from '@/agent3d/agent-orb';
import { Badge } from '@/components/ui/badge';
import { BarList, Gauge, Sparkline, StackedBar } from '@/components/ui/charts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/state-views';
import { Stat } from '@/components/ui/stat';
import { useTenant } from '@/context/tenant';
import { useAsync } from '@/hooks/use-async';
import { formatDuration, relativeTime } from '@/lib/utils';
import { api } from '@/services/api';

const KIND_TONE = { audit: 'accent', handoff: 'warn', eval: 'ok' } as const;

function Metrics({ m, tenantName }: { m: OverviewMetrics; tenantName: string }) {
  const latest = m.evals.latest;
  const passRate =
    latest && latest.total > 0 ? Math.round((latest.passed / latest.total) * 100) : null;
  const toolSuccess =
    m.tools.total > 0 ? Math.round(((m.tools.total - m.tools.failed) / m.tools.total) * 100) : null;
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
      {/* Hero: the agent, with the headline numbers beside it */}
      <Card className="relative overflow-hidden lg:col-span-7">
        <div className="grid grid-cols-1 items-center gap-2 p-4 sm:grid-cols-[minmax(0,15rem)_1fr] sm:gap-6 sm:p-6">
          <AgentOrb
            mode="idle"
            agentName={tenantName}
            className="mx-auto max-w-[15rem]"
            hideCaption
          />
          <div className="space-y-5">
            <div>
              <p className="eyebrow">{tenantName} · all recorded activity</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Numbers below are computed from stored conversations, tool calls and test runs.
                Conversations created by test runs are included.
              </p>
            </div>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-5">
              <Stat
                label="Conversations"
                value={m.conversations.total}
                hint={`${m.conversations.last24h} in the last 24 h`}
              />
              <Stat
                label="Waiting for a human"
                value={m.handoffs.pending}
                tone={m.handoffs.pending > 0 ? 'warn' : undefined}
                hint={`${m.handoffs.accepted} accepted`}
              />
              <Stat
                label="Awaiting approval"
                value={m.conversations.awaitingApproval}
                tone={m.conversations.awaitingApproval > 0 ? 'warn' : undefined}
                hint="Changes the customer has not yet confirmed"
              />
              <Stat
                label="Tool calls"
                value={m.tools.total}
                hint={`${m.tools.failed} failed or blocked`}
              />
            </dl>
          </div>
        </div>
      </Card>

      <Card className="lg:col-span-5">
        <CardHeader>
          <CardTitle>Evaluation quality</CardTitle>
          {latest && (
            <Badge tone={passRate === 100 ? 'ok' : 'warn'}>
              {latest.passed}/{latest.total} passed
            </Badge>
          )}
        </CardHeader>
        <CardContent>
          {latest ? (
            <div className="grid grid-cols-1 items-center gap-3 sm:grid-cols-[7rem_1fr]">
              <Gauge
                value={passRate}
                max={100}
                display={`${passRate}%`}
                label={`Latest scenario run: ${latest.passed} of ${latest.total} passed`}
                tone={passRate === 100 ? 'ok' : 'accent'}
              />
              <div>
                <p className="eyebrow mb-1">Pass rate by run</p>
                <Sparkline
                  values={m.evals.history.map((h) => (h.total ? (h.passed / h.total) * 100 : 0))}
                  max={100}
                  label="Scenario pass rate over recent runs"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Latest run {relativeTime(latest.startedAt)}. See Evaluations for the scenarios.
                </p>
              </div>
            </div>
          ) : (
            <EmptyState
              title="No evaluation run yet"
              hint="Run the scenario suite on the Evaluations page to see a pass rate here."
            />
          )}
        </CardContent>
      </Card>

      <Card className="lg:col-span-7">
        <CardHeader>
          <CardTitle>Tool executions</CardTitle>
          <span className="text-xs text-muted-foreground">
            {toolSuccess === null ? 'No calls yet' : `${toolSuccess}% succeeded`}
          </span>
        </CardHeader>
        <CardContent className="space-y-4">
          {m.tools.total === 0 ? (
            <p className="text-sm text-muted-foreground">
              No tool calls recorded yet. Talk to the agent and they will appear here.
            </p>
          ) : (
            <>
              <StackedBar
                ariaLabel="Tool calls by outcome"
                segments={[
                  { label: 'Succeeded', value: m.tools.total - m.tools.failed, tone: 'ok' },
                  { label: 'Failed or blocked', value: m.tools.failed, tone: 'danger' },
                ]}
              />
              <BarList
                ariaLabel="Calls per tool"
                items={m.tools.perTool.map((t) => ({
                  label: t.tool,
                  value: t.calls,
                  detail: `${t.calls} calls · p95 ${formatDuration(t.p95LatencyMs)}${t.failures ? ` · ${t.failures} failed` : ''}`,
                  tone: t.failures > 0 ? 'warn' : 'accent',
                }))}
              />
            </>
          )}
        </CardContent>
      </Card>

      <Card className="lg:col-span-5">
        <CardHeader>
          <CardTitle>Latency &amp; cost</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-5">
            <Stat
              label="Tool latency p50"
              value={m.tools.p50LatencyMs === null ? null : formatDuration(m.tools.p50LatencyMs)}
            />
            <Stat
              label="Tool latency p95"
              value={m.tools.p95LatencyMs === null ? null : formatDuration(m.tools.p95LatencyMs)}
            />
            <Stat label="Model tokens" value={m.llmUsage} />
            <Stat label="Model cost" value={m.llmUsage} />
          </dl>
          <p className="mt-4 flex gap-2 rounded-md bg-elevated p-2.5 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            Tool latency is measured. Token usage and cost are not recorded by this system yet, so
            they are shown as unavailable instead of estimated.
          </p>
        </CardContent>
      </Card>

      <Card className="lg:col-span-7">
        <CardHeader>
          <CardTitle>Conversation phases</CardTitle>
        </CardHeader>
        <CardContent>
          {m.conversations.total === 0 ? (
            <p className="text-sm text-muted-foreground">No conversations yet.</p>
          ) : (
            <BarList
              ariaLabel="Conversations by phase"
              items={Object.entries(m.conversations.byPhase)
                .sort((a, b) => b[1] - a[1])
                .map(([phase, n]) => ({
                  label: phase.replace(/_/g, ' ').toLowerCase(),
                  value: n,
                  tone:
                    phase === 'FAILED'
                      ? 'danger'
                      : phase === 'AWAITING_APPROVAL' || phase === 'HANDOFF'
                        ? 'warn'
                        : 'accent',
                }))}
            />
          )}
        </CardContent>
      </Card>

      <Card className="lg:col-span-5">
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
        </CardHeader>
        <CardContent>
          {m.recentActivity.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Proposals, approvals, handoffs and test runs will be listed here.
            </p>
          ) : (
            <ol aria-label="Recent activity" className="space-y-2.5">
              {m.recentActivity.slice(0, 8).map((a) => (
                <li key={a.id} className="flex items-start gap-2.5 text-sm">
                  <Badge tone={KIND_TONE[a.kind]} className="mt-0.5 shrink-0">
                    {a.kind}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate" title={a.label}>
                    {a.label}
                  </span>
                  <time dateTime={a.at} className="shrink-0 text-xs text-muted-foreground">
                    {relativeTime(a.at)}
                  </time>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function OverviewPage() {
  const { tenant, loading: tenantsLoading, error, reload } = useTenant();
  const overview = useAsync(() => api.overview(tenant?.id), [tenant?.id], 8000);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Operations overview"
        title={tenant ? `${tenant.displayName} at a glance` : 'Operations overview'}
        description="A live read of what the agent has done, how well it is doing, and what needs a person."
        actions={
          tenant && (
            <Link
              to={`/agent/${tenant.id}`}
              className="inline-flex h-10 items-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground shadow-glow hover:brightness-110"
            >
              Open agent console <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          )
        }
      />
      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : tenantsLoading || overview.loading ? (
        <div
          role="status"
          aria-label="Loading overview"
          className="grid grid-cols-1 gap-4 lg:grid-cols-12"
        >
          <Skeleton className="h-64 lg:col-span-7" />
          <Skeleton className="h-64 lg:col-span-5" />
          <Skeleton className="h-56 lg:col-span-7" />
          <Skeleton className="h-56 lg:col-span-5" />
        </div>
      ) : overview.error || !overview.data ? (
        <ErrorState message={overview.error ?? 'No data'} onRetry={overview.reload} />
      ) : (
        <Metrics m={overview.data} tenantName={tenant?.displayName ?? 'Agent'} />
      )}
    </div>
  );
}
