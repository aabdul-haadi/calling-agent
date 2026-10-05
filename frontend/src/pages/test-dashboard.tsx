import { Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { EvalResultView, EvalRunView } from '@adk/shared';
import { FailurePanel, ScenarioList, ScoreCard } from '@/components/tests/test-results';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/state-views';
import { useAsync } from '@/hooks/use-async';
import { api } from '@/services/api';

/** One client's runs. The parent keys this by client id, so switching client resets all state. */
function Suite({ clientId }: { clientId: string }) {
  const [run, setRun] = useState<EvalRunView>();
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<EvalResultView>();
  const [error, setError] = useState<string>();
  const [starting, setStarting] = useState(false);

  // Show the most recent run first.
  useEffect(() => {
    api
      .runs(clientId)
      .then((r) => setRun(r[0]))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoaded(true));
  }, [clientId]);

  // While a run is in progress, poll for new results.
  const runId = run?.id;
  const running = run?.status === 'running';
  useEffect(() => {
    if (!runId || !running) return;
    const t = setInterval(() => api.run(runId).then(setRun).catch(() => undefined), 2000);
    return () => clearInterval(t);
  }, [runId, running]);

  const start = async () => {
    setError(undefined);
    setStarting(true);
    try {
      const { runId: id } = await api.startRun(clientId);
      setSelected(undefined);
      setRun(await api.run(id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the run');
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="space-y-4">
      <Button onClick={start} disabled={starting || running}>
        <Play className="h-4 w-4" aria-hidden="true" /> {running ? 'Running…' : 'Run tests'}
      </Button>
      {error && <ErrorState message={error} />}
      {!loaded ? (
        <div role="status" aria-label="Loading test results">
          <Skeleton className="h-28" />
        </div>
      ) : !run ? (
        <EmptyState title="No test runs yet" hint="Press “Run tests” to run the scenarios. It uses the real AI model, so it can take a minute." />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="space-y-4">
            <ScoreCard run={run} />
            <ScenarioList results={run.results} onOpen={setSelected} selectedId={selected?.id} />
          </div>
          <div>{selected && <FailurePanel result={selected} onClose={() => setSelected(undefined)} />}</div>
        </div>
      )}
    </div>
  );
}

export function TestDashboardPage() {
  const clients = useAsync(() => api.clients());
  const [clientId, setClientId] = useState<string>();
  const active = clients.data?.find((c) => c.id === (clientId ?? clients.data?.[0]?.id));

  return (
    <div className="space-y-4" data-accent={active?.accent}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Test dashboard</h1>
          <p className="text-sm text-muted-foreground">Run the scenario suite against the real agent and see what passes.</p>
        </div>
        <label className="text-sm">
          <span className="mb-1 block text-muted-foreground">Client</span>
          <select
            value={active?.id ?? ''}
            onChange={(e) => setClientId(e.target.value)}
            className="h-10 rounded-xl border border-border bg-card px-3 text-sm"
          >
            {clients.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName}
              </option>
            ))}
          </select>
        </label>
      </div>
      {clients.error ? (
        <ErrorState message={clients.error} onRetry={clients.reload} />
      ) : active ? (
        <Suite key={active.id} clientId={active.id} />
      ) : (
        <div role="status" aria-label="Loading clients">
          <Skeleton className="h-28" />
        </div>
      )}
    </div>
  );
}
