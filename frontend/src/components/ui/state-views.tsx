import { AlertTriangle, Inbox } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './button';
import { Card } from './card';

/** Every screen designs its empty and error states: say what happened and what to do next. */
export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <Card className="flex flex-col items-center gap-2 border-dashed bg-elevated px-6 py-10 text-center shadow-none">
      <span className="mb-1 flex h-10 w-10 items-center justify-center rounded-full bg-card ring-1 ring-border">
        <Inbox
          className="h-[1.1rem] w-[1.1rem] text-muted-foreground"
          strokeWidth={1.75}
          aria-hidden="true"
        />
      </span>
      <p className="font-medium">{title}</p>
      {hint && <p className="max-w-sm text-sm text-muted-foreground">{hint}</p>}
      {action}
    </Card>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Card
      role="alert"
      className="flex flex-col items-center gap-2 border-danger/40 px-6 py-8 text-center"
    >
      <span className="mb-1 flex h-10 w-10 items-center justify-center rounded-full bg-danger/10">
        <AlertTriangle
          className="h-[1.1rem] w-[1.1rem] text-danger"
          strokeWidth={1.75}
          aria-hidden="true"
        />
      </span>
      <p className="font-medium">Something went wrong</p>
      <p className="max-w-sm text-sm text-muted-foreground">{message}</p>
      {onRetry && (
        <Button variant="outline" onClick={onRetry}>
          Try again
        </Button>
      )}
    </Card>
  );
}
