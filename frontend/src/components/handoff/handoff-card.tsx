import { Check, User } from 'lucide-react';
import type { HandoffView } from '@adk/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { formatTime } from '@/lib/utils';

const sentimentTone = {
  positive: 'ok',
  neutral: 'neutral',
  frustrated: 'warn',
  angry: 'danger',
} as const;

export function HandoffCard({
  handoff,
  onAccept,
  accepting,
}: {
  handoff: HandoffView;
  onAccept: (id: string) => void;
  accepting?: boolean;
}) {
  const accepted = handoff.status === 'accepted';
  return (
    <Card className="space-y-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <User className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          <span className="font-medium">{handoff.customerMasked}</span>
          <Badge tone={sentimentTone[handoff.sentiment]}>{handoff.sentiment}</Badge>
          <Badge tone="accent">{handoff.clientId}</Badge>
        </div>
        <time dateTime={handoff.createdAt} className="text-xs text-muted-foreground">
          {formatTime(handoff.createdAt)}
        </time>
      </div>

      <p className="text-sm font-medium">{handoff.reason}</p>

      <ul className="list-disc space-y-0.5 pl-5 text-sm">
        {handoff.summary.lines.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>

      <div>
        <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          What the AI already tried
        </p>
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
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          Intent: {handoff.summary.intent.replace(/_/g, ' ')} · Identity{' '}
          {handoff.summary.verified ? 'verified' : 'not verified'}
        </span>
        {accepted ? (
          <Badge tone="ok">
            <Check className="h-3 w-3" aria-hidden="true" /> Accepted
          </Badge>
        ) : (
          <Button
            size="sm"
            onClick={() => onAccept(handoff.id)}
            disabled={accepting}
            aria-label={`Accept handoff from ${handoff.customerMasked}`}
          >
            Accept
          </Button>
        )}
      </div>
    </Card>
  );
}
