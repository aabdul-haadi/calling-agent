import { useState } from 'react';
import { HandoffCard } from '@/components/handoff/handoff-card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/state-views';
import { useAsync } from '@/hooks/use-async';
import { api } from '@/services/api';

export function HandoffInboxPage() {
  // Poll so a handoff triggered in another tab shows up without a refresh.
  const handoffs = useAsync(() => api.handoffs(), [], 4000);
  const [accepting, setAccepting] = useState<string>();
  const [actionError, setActionError] = useState<string>();

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

  const pending = handoffs.data?.filter((h) => h.status === 'pending').length ?? 0;
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Human handoff inbox</h1>
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {handoffs.data ? `${pending} waiting for a human` : 'Customers the AI passed to a person appear here.'}
        </p>
      </div>
      {actionError && <ErrorState message={actionError} />}
      {handoffs.loading ? (
        <div role="status" aria-label="Loading handoffs" className="space-y-3">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      ) : handoffs.error ? (
        <ErrorState message={handoffs.error} onRetry={handoffs.reload} />
      ) : handoffs.data?.length === 0 ? (
        <EmptyState title="Nobody is waiting" hint="When the agent hands a customer over, they will show up here with a summary." />
      ) : (
        <ul className="grid gap-4 lg:grid-cols-2">
          {handoffs.data?.map((h) => (
            <li key={h.id}>
              <HandoffCard handoff={h} onAccept={accept} accepting={accepting === h.id} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
