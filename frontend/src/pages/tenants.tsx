import { AlertTriangle, ArrowRight, CheckCircle2, Lock, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import type { ClientDetail } from '@adk/shared';
import { validateConfig, worstLevel, type Finding } from '@/components/config/config-model';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { JsonView } from '@/components/ui/json-view';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/state-views';
import { Stat } from '@/components/ui/stat';
import { Tabs } from '@/components/ui/tabs';
import { useTenant } from '@/context/tenant';
import { useAsync } from '@/hooks/use-async';
import { relativeTime } from '@/lib/utils';
import { api } from '@/services/api';

const LEVEL_ICON = { ok: CheckCircle2, warn: AlertTriangle, error: XCircle } as const;
const LEVEL_CLASS = { ok: 'text-ok', warn: 'text-warn', error: 'text-danger' } as const;

function Findings({ findings }: { findings: Finding[] }) {
  return (
    <ul aria-label="Validation results" className="space-y-1.5">
      {findings.map((f, i) => {
        const Icon = LEVEL_ICON[f.level];
        return (
          <li key={i} className="flex items-start gap-2 text-sm">
            <Icon
              className={`mt-0.5 h-4 w-4 shrink-0 ${LEVEL_CLASS[f.level]}`}
              aria-hidden="true"
            />
            <span>
              <span className="sr-only">{f.level}: </span>
              {f.message}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Identity({ c }: { c: ClientDetail }) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Agent identity</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="flex h-11 w-11 items-center justify-center rounded-md bg-accent font-bold text-accent-foreground"
            >
              {c.persona.name[0]}
            </span>
            <div>
              <p className="text-base font-semibold">{c.persona.name}</p>
              <p className="text-muted-foreground">{c.persona.tone}</p>
            </div>
          </div>
          <p>
            <span className="font-medium">Voice style:</span> {c.persona.voiceStyle}
          </p>
          <div>
            <p className="mb-1 font-medium">Can help with</p>
            <ul className="flex flex-wrap gap-1.5">
              {c.scope.map((s) => (
                <li key={s}>
                  <Badge tone="ok">{s}</Badge>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="mb-1 font-medium">Will not handle</p>
            <ul className="flex flex-wrap gap-1.5">
              {c.outOfScope.map((s) => (
                <li key={s}>
                  <Badge tone="danger">{s}</Badge>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="mb-1 font-medium">Supported intents</p>
            <ul className="flex flex-wrap gap-1.5">
              {c.intents.map((s) => (
                <li key={s}>
                  <Badge>{s.replace(/_/g, ' ')}</Badge>
                </li>
              ))}
            </ul>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Escalation</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="text-muted-foreground">The agent hands over to a human when:</p>
          <ul className="list-disc space-y-1 pl-5">
            {c.escalation.onUserRequest && <li>the customer asks for a person</li>}
            <li>{c.escalation.maxFailedTurns} turns in a row fail</li>
            <li>the customer's tone reaches “{c.escalation.sentimentThreshold}”</li>
            {c.escalation.alwaysEscalateIntents.length > 0 && (
              <li>
                the intent is{' '}
                {c.escalation.alwaysEscalateIntents.map((i) => i.replace(/_/g, ' ')).join(' or ')}
              </li>
            )}
            <li>a company system is unavailable twice, or the agent hits its step limit</li>
          </ul>
        </CardContent>
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Journeys</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {c.journeys.map((j) => (
            <div key={j.id}>
              <p className="mb-2 text-sm font-medium">{j.label}</p>
              <ol className="flex flex-wrap items-center gap-2">
                {j.steps.map((s, i) => (
                  <li key={s.id} className="flex items-center gap-2">
                    <span className="flex items-center gap-2 rounded-md border border-border bg-elevated px-3 py-1.5 text-sm">
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-foreground">
                        {i + 1}
                      </span>
                      {s.label}
                    </span>
                    {i < j.steps.length - 1 && (
                      <ArrowRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    )}
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function ToolsAndRules({ c }: { c: ClientDetail }) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Tool allow-list</CardTitle>
          <Badge tone="accent">{c.tools.length}</Badge>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            The only actions this agent may take. Anything else is refused by the engine before it
            reaches a company system.
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {c.tools.map((t) => (
              <li key={t}>
                <Badge tone="accent" className="font-mono">
                  {t}
                </Badge>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Business rules enforced in code</CardTitle>
          <Badge>{c.rules.length}</Badge>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2.5 text-sm">
            {c.rules.map((r) => (
              <li key={r.id} className="rounded-md border border-border bg-background/50 p-2.5">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs">{r.id}</span>
                  <Badge>{r.kind}</Badge>
                </div>
                {r.description}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

function Knowledge({ c }: { c: ClientDetail }) {
  const docs = useAsync(() => api.knowledge(c.id), [c.id]);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Knowledge sources</CardTitle>
        <Link to="/knowledge" className="text-xs text-accent underline-offset-2 hover:underline">
          Open Knowledge
        </Link>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p className="text-muted-foreground">
          Folder: <code>{c.knowledgeDir}</code> · Scenarios: <code>{c.scenariosDir}</code>
        </p>
        {docs.data ? (
          <ul className="flex flex-wrap gap-1.5">
            {docs.data.map((d) => (
              <li key={d.source}>
                <Badge className="font-mono">{d.source}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <Skeleton className="h-8" />
        )}
      </CardContent>
    </Card>
  );
}

function RuntimeStatus({ c }: { c: ClientDetail }) {
  const overview = useAsync(() => api.overview(c.id), [c.id], 10_000);
  const m = overview.data;
  return (
    <Card aria-label="Runtime status">
      <CardHeader>
        <CardTitle>Runtime status</CardTitle>
        <Badge tone="ok">Loaded</Badge>
      </CardHeader>
      <CardContent>
        <p className="mb-3 text-xs text-muted-foreground">
          Read-only facts about this tenant while the backend is running. Separate from the
          configuration, which lives in files.
        </p>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
          <Stat label="Conversations" value={m?.conversations.total ?? '…'} />
          <Stat label="Tool calls" value={m?.tools.total ?? '…'} />
          <Stat
            label="Latest eval"
            value={
              m
                ? m.evals.latest
                  ? `${m.evals.latest.passed}/${m.evals.latest.total}`
                  : 'none'
                : '…'
            }
            hint={m?.evals.latest ? relativeTime(m.evals.latest.startedAt) : undefined}
          />
          <Stat label="Waiting handoffs" value={m?.handoffs.pending ?? '…'} />
        </dl>
      </CardContent>
    </Card>
  );
}

function Workspace({ c }: { c: ClientDetail }) {
  const [tab, setTab] = useState('identity');
  const findings = validateConfig(c);
  const level = worstLevel(findings);
  return (
    <div data-accent={c.accent} className="space-y-4">
      <PageHeader
        eyebrow={`Tenants & configuration · ${c.id}`}
        title={`${c.displayName} configuration`}
        description={
          <>
            Loaded from <code>clients/{c.id}/client.config.ts</code> and validated against the
            schema when the backend started. A new tenant is a new folder like this one.
          </>
        }
        actions={
          <Link
            to={`/agent/${c.id}`}
            className="inline-flex h-10 items-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground shadow-glow hover:brightness-110"
          >
            Open agent <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        }
      />

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_21rem]">
        <Card className="min-w-0 p-3">
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'identity', label: 'Identity & journeys', content: <Identity c={c} /> },
              { id: 'tools', label: 'Tools & rules', content: <ToolsAndRules c={c} /> },
              { id: 'knowledge', label: 'Knowledge', content: <Knowledge c={c} /> },
              {
                id: 'raw',
                label: 'Raw config',
                content: (
                  <JsonView value={c} label="Configuration as JSON" maxHeight="max-h-[34rem]" />
                ),
              },
            ]}
          />
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Validation</CardTitle>
              <Badge tone={level === 'ok' ? 'ok' : level === 'warn' ? 'warn' : 'danger'}>
                {level === 'ok' ? 'No issues' : level === 'warn' ? 'Warnings' : 'Errors'}
              </Badge>
            </CardHeader>
            <CardContent>
              <Findings findings={findings} />
            </CardContent>
          </Card>
          <RuntimeStatus c={c} />
          <Card>
            <CardHeader>
              <CardTitle>Change management</CardTitle>
              <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {['Save', 'Publish', 'Roll back'].map((label) => (
                  <Button key={label} variant="outline" size="sm" disabled>
                    {label}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Not implemented. Configuration is read from files and is not editable here.
                Versioning and rollback would need a configuration store, which does not exist yet.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

export function TenantsPage() {
  const { clientId } = useParams();
  const { clients, tenant, select } = useTenant();
  const client = useAsync(
    () => (clientId ? api.client(clientId) : Promise.reject(new Error('none'))),
    [clientId],
  );

  useEffect(() => {
    if (clientId && tenant?.id !== clientId && clients.some((c) => c.id === clientId))
      select(clientId);
  }, [clientId, clients, tenant, select]);

  if (!clientId)
    return tenant ? (
      <Navigate to={`/tenants/${tenant.id}`} replace />
    ) : (
      <Skeleton className="h-64" />
    );
  if (client.loading)
    return (
      <div role="status" aria-label="Loading config">
        <Skeleton className="h-64" />
      </div>
    );
  if (client.error || !client.data)
    return <ErrorState message={client.error ?? 'Client not found'} onRetry={client.reload} />;
  return <Workspace c={client.data} />;
}
