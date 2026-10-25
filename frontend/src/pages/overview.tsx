import { ArrowRight, Bot, Info, MessageSquare, Phone } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { OverviewMetrics } from '@adk/shared';
import { AgentOrb } from '@/agent3d/agent-orb';
import { TenantMark } from '@/components/brand/marks';
import { NetworkIllustration } from '@/components/brand/network-illustration';
import { Badge } from '@/components/ui/badge';
import { BarList, Gauge, Sparkline, StackedBar } from '@/components/ui/charts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/state-views';
import { Stat } from '@/components/ui/stat';
import { useTenant } from '@/context/tenant';
import { useAsync } from '@/hooks/use-async';
import { cn, formatDuration, relativeTime } from '@/lib/utils';
import { api } from '@/services/api';

const KIND_TONE = { audit: 'accent', handoff: 'warn', eval: 'ok' } as const;

function Hero({
  m,
  tenant,
}: {
  m: OverviewMetrics;
  tenant: {
    id: string;
    displayName: string;
    initials: string;
    tagline: string;
    channels: string[];
  };
}) {
  const detail = useAsync(() => api.client(tenant.id), [tenant.id]);
  const persona = detail.data?.persona.name;
  return (
    <Card className="overflow-hidden lg:col-span-12">
      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <div className="flex flex-col justify-between gap-6 p-6 sm:p-7">
          <div className="flex items-start gap-4">
            <TenantMark id={tenant.id} initials={tenant.initials} className="h-12 w-12" />
            <div className="min-w-0">
              <h2 className="text-lg font-semibold leading-tight">{tenant.displayName}</h2>
              <p className="mt-1 max-w-md text-sm text-muted-foreground">{tenant.tagline}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            {persona && (
              <div className="flex items-center gap-3">
                <AgentOrb mode="idle" agentName={persona} hideCaption compact className="w-11" />
                <div className="leading-tight">
                  <p className="text-sm font-medium">{persona}</p>
                  <p className="text-xs text-muted-foreground">AI agent on duty</p>
                </div>
              </div>
            )}
            <ul aria-label="Channels" className="flex items-center gap-2">
              {tenant.channels.map((c) => {
                const Icon = c === 'voice' ? Phone : MessageSquare;
                return (
                  <li
                    key={c}
                    className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs font-medium"
                  >
                    <Icon
                      className="h-3.5 w-3.5 text-muted-foreground"
                      strokeWidth={1.75}
                      aria-hidden="true"
                    />
                    {c === 'voice' ? 'Voice' : 'Chat'}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
        <div className="relative hidden min-h-[13rem] border-l border-border bg-elevated md:block">
          <NetworkIllustration tenantId={tenant.id} className="absolute inset-0" />
        </div>
      </div>
      <dl className="grid grid-cols-2 border-t border-border lg:grid-cols-4">
        {[
          {
            label: 'Conversations',
            value: m.conversations.total,
            hint: `${m.conversations.last24h} in the last 24 h`,
          },
          {
            label: 'Waiting for a human',
            value: m.handoffs.pending,
            tone: m.handoffs.pending > 0 ? ('warn' as const) : undefined,
            hint: `${m.handoffs.accepted} accepted, ${m.handoffs.resolved} resolved`,
          },
          {
            label: 'Awaiting approval',
            value: m.conversations.awaitingApproval,
            tone: m.conversations.awaitingApproval > 0 ? ('warn' as const) : undefined,
            hint: 'Changes the customer has not confirmed',
          },
          {
            label: 'Tool calls',
            value: m.tools.total,
            hint: `${m.tools.failed} failed or blocked`,
          },
        ].map((s, i) => (
          <Stat
            key={s.label}
            label={s.label}
            value={s.value}
            hint={s.hint}
            tone={s.tone}
            className={cn(
              'px-6 py-5',
              i % 2 === 1 && 'border-l border-border',
              i >= 2 && 'border-t border-border lg:border-t-0',
              i === 2 && 'lg:border-l',
            )}
          />
        ))}
      </dl>
    </Card>
  );
}

function Metrics({
  m,
  tenant,
}: {
  m: OverviewMetrics;
  tenant: {
    id: string;
    displayName: string;
    initials: string;
    tagline: string;
    channels: string[];
  };
}) {
  const latest = m.evals.latest;
  const passRate =
    latest && latest.total > 0 ? Math.round((latest.passed / latest.total) * 100) : null;
  const toolSuccess =
    m.tools.total > 0 ? Math.round(((m.tools.total - m.tools.failed) / m.tools.total) * 100) : null;
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
      <Hero m={m} tenant={tenant} />

      <Card className="lg:order-2 lg:col-span-5">
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

      <Card className="lg:order-1 lg:col-span-7">
        <CardHeader>
          <CardTitle>Tool executions</CardTitle>
          <span className="text-xs font-medium text-muted-foreground">
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
                  {
                    label: 'Succeeded',
                    value: m.tools.total - m.tools.failed,
                    tone: 'ok',
                  },
                  {
                    label: 'Failed or blocked',
                    value: m.tools.failed,
                    tone: 'danger',
                  },
                ]}
              />
              <BarList
                ariaLabel="Calls per tool"
                items={m.tools.perTool.map((t) => ({
                  label: t.tool,
                  value: t.calls,
                  detail: `${t.calls} calls, p95 ${formatDuration(t.p95LatencyMs)}${t.failures ? `, ${t.failures} failed` : ''}`,
                  tone: t.failures > 0 ? 'warn' : 'accent',
                }))}
              />
            </>
          )}
        </CardContent>
      </Card>

      <Card className="lg:order-4 lg:col-span-4">
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
          <p className="mt-5 flex gap-2 rounded-md bg-muted p-3 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            Tool latency is measured. Token usage and cost are not recorded by this system yet, so
            they are shown as unavailable instead of estimated.
          </p>
        </CardContent>
      </Card>

      <Card className="lg:order-3 lg:col-span-4">
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

      <Card className="lg:order-5 lg:col-span-4">
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
                  <Badge
                    tone={KIND_TONE[a.kind]}
                    className="mt-0.5 w-16 shrink-0 justify-center capitalize"
                  >
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

function WorkflowGuide({ tenantId }: { tenantId?: string }) {
  const steps = [
    {
      label: 'Configure',
      detail: 'Set up the company and agent',
      to: tenantId ? `/settings/${tenantId}` : '/settings',
    },
    {
      label: 'Add policies',
      detail: 'Upload the knowledge Ava should use',
      to: '/knowledge',
    },
    {
      label: 'Test Ava',
      detail: 'Try chat or voice safely',
      to: tenantId ? `/agent/${tenantId}` : '/agent',
    },
    {
      label: 'Review',
      detail: 'Handle conversations and handoffs',
      to: '/conversations',
    },
    {
      label: 'Improve',
      detail: 'Evaluate and publish changes',
      to: '/learning',
    },
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>How the platform fits together</CardTitle>
        <p className="text-sm text-muted-foreground">
          Start with a company, test Ava, then improve only what passes review.
        </p>
      </CardHeader>
      <CardContent>
        <ol className="grid gap-2 md:grid-cols-5">
          {steps.map((step, index) => (
            <li key={step.label} className="flex min-w-0 items-center gap-2">
              <Link
                to={step.to}
                className="min-w-0 flex-1 rounded-md border border-border bg-elevated p-3 hover:border-accent/50"
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent text-xs text-accent-foreground">
                    {index + 1}
                  </span>
                  {step.label}
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">{step.detail}</span>
              </Link>
              {index < steps.length - 1 && (
                <ArrowRight className="hidden h-4 w-4 shrink-0 text-muted-foreground md:block" aria-hidden="true" />
              )}
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

export function OverviewPage() {
  const { tenant, loading: tenantsLoading, error, reload } = useTenant();
  const overview = useAsync(() => api.overview(tenant?.id), [tenant?.id], 8000);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Operations overview"
        title="Overview"
        description="See what is happening across your companies, start the next task, and follow the path from setup to safe improvement."
        actions={
          tenant && (
            <Link
              to={`/agent/${tenant.id}`}
              className="inline-flex h-10 items-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground shadow-soft hover:bg-accent/90"
            >
              <Bot className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
              Open agent console
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
          <Skeleton className="h-80 lg:col-span-12" />
          <Skeleton className="h-56 lg:col-span-7" />
          <Skeleton className="h-56 lg:col-span-5" />
        </div>
      ) : overview.error || !overview.data ? (
        <ErrorState message={overview.error ?? 'No data'} onRetry={overview.reload} />
      ) : (
        <Metrics
          m={overview.data}
          tenant={
            tenant ?? {
              id: '',
              displayName: 'Agent',
              initials: 'A',
              tagline: '',
              channels: ['chat'],
            }
          }
        />
      )}
      <WorkflowGuide tenantId={tenant?.id} />
    </div>
  );
}
