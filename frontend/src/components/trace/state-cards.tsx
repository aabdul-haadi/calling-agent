import { BookOpen, CheckCircle2, XCircle } from 'lucide-react';
import type { Citation, ClientDetail, ConversationStateView } from '@adk/shared';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

const LABELS: Record<string, string> = {
  passengerFirstName: 'First name',
  bookingRef: 'Booking',
  customerFirstName: 'First name',
  accountId: 'Account',
  rebooked: 'Rebooked',
};

/** Turns tool facts into short human-readable lines. Raw JSON is intentionally not shown here. */
function describe(key: string, value: unknown): string | undefined {
  if (key === 'booking' && value && typeof value === 'object') {
    const b = value as Record<string, string>;
    return `${b.flightNumber} ${b.origin} → ${b.destination}${b.status === 'FLIGHT_CANCELLED_BY_AIRLINE' ? ' (cancelled)' : ''}`;
  }
  if (key === 'alternatives' && Array.isArray(value))
    return `${value.length} alternative flights offered`;
  if (key === 'bill' && value && typeof value === 'object')
    return `Latest bill $${(value as { total: number }).total}`;
  if (key === 'outage' && value && typeof value === 'object')
    return `Area status: ${(value as { status: string }).status}`;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return undefined;
}

export function StateCard({
  state,
  client,
}: {
  state?: ConversationStateView;
  client: ClientDetail;
}) {
  const journey =
    client.journeys.find((j) => j.id === (state?.journeyId ?? client.journeys[0]?.id)) ??
    client.journeys[0]!;
  const current = state?.journeyStep ?? journey.steps[0]!.id;
  const index = Math.max(
    0,
    journey.steps.findIndex((s) => s.id === current),
  );
  const pct = Math.round(((index + 1) / journey.steps.length) * 100);
  const facts = Object.entries(state?.collected ?? {})
    .map(
      ([k, v]) =>
        [LABELS[k] ?? k.replace(/([A-Z])/g, ' $1').toLowerCase(), describe(k, v)] as const,
    )
    .filter((f): f is readonly [string, string] => f[1] !== undefined);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Conversation state</CardTitle>
        {state?.handedOff && <Badge tone="warn">With a human</Badge>}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2 text-sm">
          {state?.verified ? (
            <CheckCircle2 className="h-5 w-5 text-ok" aria-hidden="true" />
          ) : (
            <XCircle className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          )}
          <span className="font-medium">
            Identity {state?.verified ? 'verified' : 'not verified yet'}
          </span>
        </div>

        <div>
          <div className="mb-1 flex justify-between text-xs text-muted-foreground">
            <span>{journey.label}</span>
            <span>
              Step {index + 1} of {journey.steps.length}
            </span>
          </div>
          <div
            role="progressbar"
            aria-label="Journey progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            aria-valuetext={`${journey.steps[index]!.label}, step ${index + 1} of ${journey.steps.length}`}
            className="h-2 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="mt-1 text-sm font-medium">{journey.steps[index]!.label}</p>
        </div>

        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Collected info
          </p>
          {facts.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing yet.</p>
          ) : (
            <dl className="space-y-1 text-sm">
              {facts.map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3">
                  <dt className="capitalize text-muted-foreground">{k}</dt>
                  <dd className="text-right font-medium">{v}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function KnowledgeCard({ citations }: { citations: Citation[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BookOpen className="h-4 w-4" aria-hidden="true" /> Knowledge used
        </CardTitle>
      </CardHeader>
      <CardContent
        className={cn('space-y-3', citations.length === 0 && 'text-sm text-muted-foreground')}
      >
        {citations.length === 0 ? (
          'Policy snippets the agent relies on will be cited here.'
        ) : (
          <ul className="space-y-3">
            {citations.map((c, i) => (
              <li
                key={`${c.source}-${i}`}
                className="rounded-md border border-border bg-background/50 p-3 text-sm"
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Badge tone="accent">{c.source}</Badge>
                    {c.page && (
                      <Badge>
                        page {c.page}
                        {c.pageEnd ? `–${c.pageEnd}` : ''}
                      </Badge>
                    )}
                    {c.version && c.version > 1 && <Badge>version {c.version}</Badge>}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    match {Math.round(c.score * 100)}%
                  </span>
                </div>
                <p className="line-clamp-4">{c.snippet}</p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
