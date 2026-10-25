import { Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { EvalResultView, EvalRunView } from '@adk/shared';
import {
  CategoryBreakdown,
  FailurePanel,
  RunCompare,
  ScenarioList,
  ScoreCard,
} from '@/components/tests/test-results';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/state-views';
import { useTenant } from '@/context/tenant';
import { api } from '@/services/api';

/** One tenant's runs. The parent keys this by tenant id, so switching tenant resets all state. */
function Suite({ clientId }: { clientId: string }) {
  const [runs, setRuns] = useState<EvalRunView[]>([]);
  const [run, setRun] = useState<EvalRunView>();
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<EvalResultView>();
  const [error, setError] = useState<string>();
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    api
      .runs(clientId)
      .then((r) => {
        setRuns(r);
        setRun(r[0]);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoaded(true));
  }, [clientId]);

  // While a run is in progress, poll for new results.
  const runId = run?.id;
  const running = run?.status === 'running';
  useEffect(() => {
    if (!runId || !running) return;
    const t = setInterval(
      () =>
        api
          .run(runId)
          .then((r) => {
            setRun(r);
            if (r.status !== 'running') setRuns((all) => [r, ...all.filter((x) => x.id !== r.id)]);
          })
          .catch(() => undefined),
      2000,
    );
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

  // The finished run before the one on screen, for the comparison.
  const index = run ? runs.findIndex((r) => r.id === run.id) : -1;
  const previous = index >= 0 ? runs.slice(index + 1).find((r) => r.status === 'done') : undefined;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={start} disabled={starting || running}>
          <Play className="h-4 w-4" aria-hidden="true" /> {running ? 'Running…' : 'Run tests'}
        </Button>
        {runs.length > 1 && (
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Run</span>
            <select
              value={run?.id ?? ''}
              onChange={(e) => {
                setRun(runs.find((r) => r.id === e.target.value));
                setSelected(undefined);
              }}
              className="h-10 rounded-md border border-border bg-card px-2 text-sm"
            >
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {new Date(r.startedAt).toLocaleString()} · {r.passed}/{r.total}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {error && <ErrorState message={error} />}
      {!loaded ? (
        <div role="status" aria-label="Loading test results">
          <Skeleton className="h-28" />
        </div>
      ) : !run ? (
        <EmptyState
          title="No test runs yet"
          hint="Press “Run tests” to run the scenarios. It uses the real AI model, so it can take a minute."
        />
      ) : (
        <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <div className="space-y-4">
            <ScoreCard run={run} />
            {run.status !== 'running' && previous && <RunCompare before={previous} after={run} />}
            <CategoryBreakdown results={run.results} />
            <ScenarioList results={run.results} onOpen={setSelected} selectedId={selected?.id} />
            <p className="text-xs text-muted-foreground">
              Latency and token usage per scenario are not recorded yet. Every scenario in the
              folder runs, so there are no skipped scenarios.
            </p>
          </div>
          <div className="xl:sticky xl:top-20">
            {selected ? (
              <FailurePanel result={selected} onClose={() => setSelected(undefined)} />
            ) : (
              <EmptyState
                title="Pick a scenario"
                hint="See what was expected, which hard checks passed, what the LLM judge thought, and the full transcript."
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function EvaluationsPage() {
  const { clients, tenant, select, error, reload } = useTenant();
  return (
    <div className="space-y-5" data-accent={tenant?.accent}>
      <PageHeader
        eyebrow="Evaluations"
        title="Test before publishing"
        description="Run realistic customer scenarios before a change reaches customers. Clear pass and fail results show what is safe to publish."
        actions={
          clients.length > 1 && (
            <Segmented
              ariaLabel="Test suite tenant"
              value={tenant?.id ?? ''}
              onChange={select}
              options={clients.map((c) => ({ value: c.id, label: c.displayName }))}
            />
          )
        }
      />
      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : tenant ? (
        <Suite key={tenant.id} clientId={tenant.id} />
      ) : (
        <div role="status" aria-label="Loading clients">
          <Skeleton className="h-28" />
        </div>
      )}
    </div>
  );
}
