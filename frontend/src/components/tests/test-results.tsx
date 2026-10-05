import { CheckCircle2, X, XCircle } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { EvalResultView, EvalRunView } from '@adk/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export function ScoreCard({ run }: { run: EvalRunView }) {
  const pct = run.total === 0 ? 0 : Math.round((run.passed / run.total) * 100);
  const finished = run.status !== 'running';
  const completed = run.results.length;
  return (
    <Card className="flex flex-wrap items-center gap-6 p-6">
      <div>
        <p
          className="text-5xl font-semibold tabular-nums"
          aria-label={`${run.passed} of ${run.total} scenarios passed`}
        >
          {run.passed}
          <span className="text-muted-foreground">/{run.total}</span>
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {run.status === 'running'
            ? `Running… ${completed} of ${run.total} done`
            : run.status === 'error'
              ? 'Run stopped early'
              : `${pct}% passed`}
        </p>
      </div>
      <div
        role="progressbar"
        aria-label="Scenarios passed"
        aria-valuemin={0}
        aria-valuemax={run.total}
        aria-valuenow={finished ? run.passed : completed}
        className="h-3 min-w-[10rem] flex-1 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            'h-full rounded-full transition-[width]',
            finished && pct < 100 ? 'bg-warn' : 'bg-ok',
          )}
          style={{ width: `${finished ? pct : (completed / Math.max(1, run.total)) * 100}%` }}
        />
      </div>
    </Card>
  );
}

export function ScenarioList({
  results,
  onOpen,
  selectedId,
}: {
  results: EvalResultView[];
  onOpen: (r: EvalResultView) => void;
  selectedId?: string;
}) {
  return (
    <ul className="space-y-2" aria-label="Scenario results">
      {results.map((r) => (
        <li key={r.id}>
          <button
            type="button"
            onClick={() => onOpen(r)}
            aria-pressed={selectedId === r.id}
            className={cn(
              'flex w-full items-center justify-between gap-3 rounded-2xl border border-border bg-card px-4 py-3 text-left text-sm hover:bg-muted',
              selectedId === r.id && 'ring-2 ring-accent',
            )}
          >
            <span>
              <span className="block font-medium">{r.title}</span>
              <span className="text-xs text-muted-foreground">{r.scenarioId}</span>
            </span>
            {r.passed ? (
              <Badge tone="ok">
                <CheckCircle2 className="h-3 w-3" aria-hidden="true" /> Pass
              </Badge>
            ) : (
              <Badge tone="danger">
                <XCircle className="h-3 w-3" aria-hidden="true" /> Fail
              </Badge>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function FailurePanel({ result, onClose }: { result: EvalResultView; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => closeRef.current?.focus(), [result.id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <aside
      aria-label={`Details for ${result.title}`}
      className="rounded-2xl border border-border bg-card p-5 shadow-soft"
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold">{result.title}</h2>
          <Badge tone={result.passed ? 'ok' : 'danger'}>
            {result.passed ? 'Passed' : 'Failed'}
          </Badge>
        </div>
        <Button
          ref={closeRef}
          variant="ghost"
          size="icon"
          aria-label="Close details"
          onClick={onClose}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>

      <section className="mb-4">
        <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Expected behaviour
        </h3>
        <p className="text-sm">{result.expected}</p>
      </section>

      {result.failures.length > 0 && (
        <section className="mb-4">
          <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            What went wrong
          </h3>
          <ul className="list-disc space-y-1 pl-5 text-sm text-danger">
            {result.failures.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="mb-4">
        <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Judge's reason
        </h3>
        <p className="text-sm">{result.judgeReason}</p>
      </section>

      <section className="mb-4">
        <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Tools used
        </h3>
        <p className="text-sm">
          {result.toolsCalled.length ? result.toolsCalled.join(' → ') : 'None'}
        </p>
      </section>

      <section>
        <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Transcript
        </h3>
        <ol className="space-y-2 text-sm">
          {result.transcript.map((m, i) => (
            <li
              key={i}
              className={cn(
                'rounded-xl px-3 py-2',
                m.role === 'user' ? 'bg-accent-soft' : 'bg-muted',
              )}
            >
              <span className="font-medium">{m.role === 'user' ? 'Customer' : 'Agent'}: </span>
              {m.content}
            </li>
          ))}
        </ol>
      </section>
    </aside>
  );
}
