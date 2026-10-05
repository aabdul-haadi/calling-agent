import { ArrowRight, CheckSquare, ShieldCheck } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/state-views';
import { useAsync } from '@/hooks/use-async';
import { api } from '@/services/api';

export function ClientConfigPage() {
  const { clientId = '' } = useParams();
  const client = useAsync(() => api.client(clientId), [clientId]);

  if (client.loading)
    return (
      <div role="status" aria-label="Loading config">
        <Skeleton className="h-64" />
      </div>
    );
  if (client.error || !client.data)
    return <ErrorState message={client.error ?? 'Client not found'} onRetry={client.reload} />;
  const c = client.data;

  return (
    <div data-accent={c.accent} className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{c.displayName} configuration</h1>
          <p className="text-sm text-muted-foreground">
            Read-only view of <code>clients/{c.id}/client.config.ts</code>. A new client is a new
            folder like this one.
          </p>
        </div>
        <Link
          to={`/agent/${c.id}`}
          className="inline-flex h-10 items-center gap-2 rounded-xl bg-accent px-4 text-sm font-medium text-accent-foreground"
        >
          Open agent <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Persona</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-center gap-3">
              <span
                aria-hidden="true"
                className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent font-bold text-accent-foreground"
              >
                {c.persona.name[0]}
              </span>
              <div>
                <p className="text-lg font-semibold">{c.persona.name}</p>
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
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Tools</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              The only actions this agent may take. Anything else is refused by the engine.
            </p>
            <ul className="flex flex-wrap gap-1.5">
              {c.tools.map((t) => (
                <li key={t}>
                  <Badge tone="accent">{t}</Badge>
                </li>
              ))}
            </ul>
            <p className="pt-2 font-medium">Escalates to a human when</p>
            <ul className="list-disc space-y-0.5 pl-5">
              {c.escalation.onUserRequest && <li>the customer asks for a person</li>}
              <li>{c.escalation.maxFailedTurns} turns in a row fail</li>
              <li>sentiment reaches “{c.escalation.sentimentThreshold}”</li>
              {c.escalation.alwaysEscalateIntents.length > 0 && (
                <li>
                  intent is{' '}
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
                <p className="mb-2 font-medium">{j.label}</p>
                <ol className="flex flex-wrap items-center gap-2">
                  {j.steps.map((s, i) => (
                    <li key={s.id} className="flex items-center gap-2">
                      <span className="flex items-center gap-2 rounded-xl border border-border bg-muted px-3 py-1.5 text-sm">
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

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4" aria-hidden="true" /> Rules enforced in code
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {c.rules.map((r) => (
                <li key={r.id} className="flex items-start gap-2">
                  <CheckSquare className="mt-0.5 h-4 w-4 shrink-0 text-ok" aria-hidden="true" />
                  <span>{r.description}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
