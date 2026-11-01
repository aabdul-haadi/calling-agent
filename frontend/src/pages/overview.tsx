import { ArrowRight, Bot, Info } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { OverviewMetrics } from '@adk/shared';
import { useAuth } from '@/auth/context';
import { avatarFor } from '@/avatar/avatar-config';
import { preloadAvatar } from '@/avatar/preload';
import { Badge } from '@/components/ui/badge';
import { BarList, Gauge, Sparkline, StackedBar } from '@/components/ui/charts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/state-views';
import { Stat } from '@/components/ui/stat';
import { AgentIdentityCard } from '@/components/visual/agent-identity-card';
import type { VisualKey } from '@/components/visual/assets';
import { DashboardMetricCard } from '@/components/visual/dashboard-metric-card';
import { QuickActionCard } from '@/components/visual/quick-action-card';
import { VisualAsset } from '@/components/visual/visual-asset';
import { useTenant } from '@/context/tenant';
import { useAsync } from '@/hooks/use-async';
import { formatDuration, relativeTime } from '@/lib/utils';
import { api } from '@/services/api';

const KIND_TONE = { audit: 'accent', handoff: 'warn', eval: 'ok' } as const;

/** The numbers someone should look at first: who is waiting, what is stuck, how busy it is. */
function Attention({ m }: { m: OverviewMetrics }) {
  const waiting = m.handoffs.pending;
  const approvals = m.conversations.awaitingApproval;
  return (
    <section aria-labelledby="attention-title" className="lg:col-span-12">
      <h2 id="attention-title" className="mb-3 text-sm font-semibold">
        Needs attention
      </h2>
      <ul className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <li>
          <DashboardMetricCard
            asset="handoffs"
            label="Waiting for a person"
            value={waiting}
            tone={waiting > 0 ? 'warn' : undefined}
            attention={waiting > 0 ? 'Customers waiting' : undefined}
            hint={`${m.handoffs.accepted} accepted, ${m.handoffs.resolved} resolved`}
            to="/handoffs"
          />
        </li>
        <li>
          <DashboardMetricCard
            asset="approval"
            label="Awaiting approval"
            value={approvals}
            tone={approvals > 0 ? 'warn' : undefined}
            hint="Changes the customer has not confirmed yet"
            to="/conversations"
          />
        </li>
        <li>
          <DashboardMetricCard
            asset="conversations"
            label="Conversations"
            value={m.conversations.total}
            hint={`${m.conversations.last24h} in the last 24 hours`}
            to="/conversations"
          />
        </li>
        <li>
          <DashboardMetricCard
            asset="tools"
            label="Actions taken by agents"
            value={m.tools.total}
            hint={`${m.tools.failed} failed or blocked`}
            to="/traces"
          />
        </li>
      </ul>
    </section>
  );
}

function Agents() {
  const { clients, tenant, select } = useTenant();
  const voice = useAsync(() => api.voiceStatus(), [], 15_000);
  const { profile } = useAuth();
  const can = (permission: string) => !!profile?.permissions.includes(permission);
  const id = tenant?.id;
  const actions: {
    asset: VisualKey;
    title: string;
    description: string;
    to: string;
    permission: string;
    preload?: boolean;
  }[] = [
    {
      asset: 'voice',
      title: 'Start a voice session',
      description: 'Talk to the agent out loud',
      to: '/voice',
      permission: 'support:operate',
      preload: true,
    },
    {
      asset: 'conversations',
      title: 'View conversations',
      description: 'Find what customers asked',
      to: '/conversations',
      permission: 'support:read',
    },
    {
      asset: 'handoffs',
      title: 'Review handoffs',
      description: 'Help customers who need a person',
      to: '/handoffs',
      permission: 'support:handoff',
    },
    {
      asset: 'knowledge',
      title: 'Manage knowledge',
      description: 'Policies the agent answers from',
      to: '/knowledge',
      permission: 'knowledge:read',
    },
    {
      asset: 'quality',
      title: 'Run quality tests',
      description: 'Check answers before customers do',
      to: '/evaluations',
      permission: 'evaluations:read',
    },
  ];
  const allowed = actions.filter((a) => can(a.permission));
  return (
    <>
      <section aria-labelledby="agents-title" className="lg:col-span-7">
        <h2 id="agents-title" className="mb-3 text-sm font-semibold">
          Your agents
        </h2>
        {clients.length === 0 ? (
          <EmptyState
            asset="magic"
            title="No agents yet"
            hint="Add a company in Company configuration and its agent will appear here."
          />
        ) : (
          <ul className="space-y-4">
            {clients.map((c) => (
              <li key={c.id}>
                <AgentIdentityCard
                  client={c}
                  selected={c.id === id}
                  voiceReady={voice.data ? voice.data.available : undefined}
                  onSelect={select}
                  onPreload={preloadAvatar}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
      {allowed.length > 0 && (
        <section aria-labelledby="actions-title" className="lg:col-span-5">
          <h2 id="actions-title" className="mb-3 text-sm font-semibold">
            What would you like to do?
          </h2>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-1">
            {allowed.map((a) => (
              <li key={a.to}>
                <QuickActionCard
                  asset={a.asset}
                  title={a.title}
                  description={a.description}
                  to={a.to}
                  onPreload={a.preload ? () => preloadAvatar(id) : undefined}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function Metrics({ m }: { m: OverviewMetrics }) {
  const latest = m.evals.latest;
  const passRate =
    latest && latest.total > 0 ? Math.round((latest.passed / latest.total) * 100) : null;
  const toolSuccess =
    m.tools.total > 0 ? Math.round(((m.tools.total - m.tools.failed) / m.tools.total) * 100) : null;
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
      <Attention m={m} />
      <Agents />

      <Card className="lg:order-2 lg:col-span-5">
        <CardHeader>
          <span className="flex items-center gap-2.5">
            <VisualAsset asset="quality" size={32} />
            <CardTitle>Quality checks</CardTitle>
          </span>
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
              asset="target"
              title="No evaluation run yet"
              hint="Run the scenario suite on the Evaluations page to see a pass rate here."
            />
          )}
        </CardContent>
      </Card>

      <Card className="lg:order-1 lg:col-span-7">
        <CardHeader>
          <span className="flex items-center gap-2.5">
            <VisualAsset asset="tools" size={32} />
            <CardTitle>What the agents did</CardTitle>
          </span>
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
          <span className="flex items-center gap-2.5">
            <VisualAsset asset="analytics" size={32} />
            <CardTitle>Speed &amp; usage</CardTitle>
          </span>
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
          <span className="flex items-center gap-2.5">
            <VisualAsset asset="conversations" size={32} />
            <CardTitle>Where conversations stand</CardTitle>
          </span>
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
          <span className="flex items-center gap-2.5">
            <VisualAsset asset="time" size={32} />
            <CardTitle>Recent activity</CardTitle>
          </span>
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

function WorkflowGuide({ tenantId, agentName }: { tenantId?: string; agentName: string }) {
  const steps = [
    {
      label: 'Configure',
      detail: 'Set up the company and agent',
      to: tenantId ? `/settings/${tenantId}` : '/settings',
    },
    {
      label: 'Add policies',
      detail: `Upload the knowledge ${agentName} should use`,
      to: '/knowledge',
    },
    {
      label: `Test ${agentName}`,
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
          Start with a company, test {agentName}, then improve only what passes review.
        </p>
      </CardHeader>
      <CardContent>
        <ol className="grid gap-2 md:grid-cols-5">
          {steps.map((step, index) => (
            <li key={step.label} className="flex min-w-0 items-stretch gap-2">
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
        description="What is happening now, which customers need a person, and what to do next."
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
          <Skeleton className="h-24 lg:col-span-3" />
          <Skeleton className="h-24 lg:col-span-3" />
          <Skeleton className="h-24 lg:col-span-3" />
          <Skeleton className="h-24 lg:col-span-3" />
          <Skeleton className="h-56 lg:col-span-7" />
          <Skeleton className="h-56 lg:col-span-5" />
        </div>
      ) : overview.error || !overview.data ? (
        <ErrorState message={overview.error ?? 'No data'} onRetry={overview.reload} />
      ) : (
        <Metrics m={overview.data} />
      )}
      <WorkflowGuide
        tenantId={tenant?.id}
        agentName={(tenant && avatarFor(tenant.id)?.name) || 'the agent'}
      />
    </div>
  );
}
