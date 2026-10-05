import { Activity } from 'lucide-react';
import { useState } from 'react';
import type { TraceEvent } from '@adk/shared';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, formatTime } from '@/lib/utils';

const dot = { ok: 'bg-ok', warn: 'bg-warn', error: 'bg-danger' } as const;
const statusText = { ok: 'Succeeded', warn: 'Needs attention', error: 'Failed' } as const;

function TraceItem({ event }: { event: TraceEvent }) {
  const [open, setOpen] = useState(false);
  const hasDetail = event.detail !== undefined && event.detail !== null;
  return (
    <li className="relative pl-6">
      <span
        className={cn(
          'absolute left-0 top-1.5 h-3 w-3 rounded-full ring-4 ring-card',
          dot[event.status],
        )}
        aria-hidden="true"
      />
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm">
          <span className="sr-only">{statusText[event.status]}: </span>
          {event.label}
        </span>
        {event.latencyMs !== undefined && <Badge>{event.latencyMs} ms</Badge>}
      </div>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <time dateTime={event.at}>{formatTime(event.at)}</time>
        {hasDetail && (
          <button
            type="button"
            className="underline underline-offset-2"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? 'Hide details' : 'Show details'}
          </button>
        )}
      </div>
      {open && (
        <pre className="mt-1 max-h-48 overflow-auto rounded-xl bg-muted p-2 text-xs">
          {JSON.stringify(event.detail, null, 2)}
        </pre>
      )}
    </li>
  );
}

export function LiveTrace({ trace }: { trace: TraceEvent[] }) {
  return (
    <Card className="flex h-[24rem] flex-col lg:h-[calc(100vh-11rem)]">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="h-4 w-4" aria-hidden="true" /> Live trace
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 overflow-y-auto">
        {trace.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            What the agent does will appear here as it happens: understanding the request, checking
            systems, finding policies.
          </p>
        ) : (
          <ol
            aria-label="What the agent did"
            className="relative space-y-4 border-l border-border pl-3"
          >
            {trace.map((e) => (
              <TraceItem key={e.id} event={e} />
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
