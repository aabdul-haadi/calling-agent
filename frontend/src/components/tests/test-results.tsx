import { ArrowDownRight, ArrowUpRight, CheckCircle2, ChevronRight, X, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { EvalResultView, EvalRunView } from '@adk/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn, formatDateTime } from '@/lib/utils';
import { categorize, categoryScores, compareRuns, splitFailures } from './eval-model';

export function ScoreCard({ run }: { run: EvalRunView }) {
  const pct = run.total === 0 ? 0 : Math.round((run.passed / run.total) * 100);
  const finished = run.status !== 'running';
  const completed = run.results.length;
  const failed = run.results.filter((r) => !r.passed).length;
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
        <div>
          <p
            className="text-5xl font-semibold tabular-nums leading-none"
            aria-label={`${run.passed} of ${run.total} scenarios passed`}
          >
            {run.passed}
            <span className="text-muted-foreground">/{run.total}</span>
          </p>
          <p className="mt-2 text-sm text-muted-foreground" aria-live="polite">
            {run.status === 'running'
              ? `Running… ${completed} of ${run.total} done`
              : run.status === 'error'
                ? 'Run stopped early'
                : `${pct}% passed · ${formatDateTime(run.startedAt)}`}
          </p>
        </div>
        <dl className="flex gap-6 text-sm">
          <div>
            <dt className="eyebrow">Passed</dt>
            <dd className="text-xl font-semibold tabular-nums text-ok">{run.passed}</dd>
          </div>
          <div>
            <dt className="eyebrow">Failed</dt>
            <dd className={cn('text-xl font-semibold tabular-nums', failed > 0 && 'text-danger')}>
              {failed}
            </dd>
          </div>
        </dl>
        <div
          role="progressbar"
          aria-label="Scenarios passed"
          aria-valuemin={0}
          aria-valuemax={run.total}
          aria-valuenow={finished ? run.passed : completed}
          className="h-2.5 min-w-[10rem] flex-1 overflow-hidden rounded-full bg-muted"
        >
          <div
            className={cn(
              'h-full rounded-full transition-[width] duration-500',
              finished && pct < 100 ? 'bg-warn' : 'bg-ok',
            )}
            style={{ width: `${finished ? pct : (completed / Math.max(1, run.total)) * 100}%` }}
          />
        </div>
      </div>
    </Card>
  );
}

export function CategoryBreakdown({ results }: { results: EvalResultView[] }) {
  const scores = categoryScores(results);
  if (scores.length === 0) return null;
  return (
    <Card className="p-4">
      <h2 className="eyebrow">By category</h2>
      <p className="mb-3 mt-1 text-xs text-muted-foreground">
        Categories are inferred from scenario names; the backend does not tag them.
      </p>
      <ul aria-label="Pass rate by category" className="space-y-2.5">
        {scores.map((s) => {
          const pct = Math.round((s.passed / s.total) * 100);
          return (
            <li key={s.category}>
              <div className="mb-1 flex justify-between text-xs">
                <span>{s.category}</span>
                <span className="tabular-nums text-muted-foreground">
                  {s.passed}/{s.total}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    'h-full rounded-full',
                    pct === 100 ? 'bg-ok' : pct >= 50 ? 'bg-warn' : 'bg-danger',
                  )}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
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
    <ul className="space-y-1.5" aria-label="Scenario results">
      {results.map((r) => (
        <li key={r.id}>
          <button
            type="button"
            onClick={() => onOpen(r)}
            aria-pressed={selectedId === r.id}
            className={cn(
              'flex w-full items-center justify-between gap-3 rounded-md border border-border bg-card px-3 py-2.5 text-left text-sm transition-colors hover:border-accent/40 hover:bg-elevated',
              selectedId === r.id && 'border-accent/60 bg-accent/5',
            )}
          >
            <span className="min-w-0">
              <span className="block truncate font-medium">{r.title}</span>
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="truncate font-mono">{r.scenarioId}</span>
                <span aria-hidden="true">·</span>
                <span>{categorize(r.scenarioId)}</span>
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              {r.passed ? (
                <Badge tone="ok">
                  <CheckCircle2 className="h-3 w-3" aria-hidden="true" /> Pass
                </Badge>
              ) : (
                <Badge tone="danger">
                  <XCircle className="h-3 w-3" aria-hidden="true" /> Fail
                </Badge>
              )}
              <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Expected versus actual, with deterministic assertions kept apart from the LLM judge. */
export function FailurePanel({ result, onClose }: { result: EvalResultView; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [showTranscript, setShowTranscript] = useState(!result.passed);
  useEffect(() => closeRef.current?.focus(), [result.id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const { deterministic, judge } = splitFailures(result);

  return (
    <aside
      aria-label={`Details for ${result.title}`}
      className="rounded-lg border border-border bg-card p-4 shadow-soft"
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="font-semibold">{result.title}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge tone={result.passed ? 'ok' : 'danger'}>
              {result.passed ? 'Passed' : 'Failed'}
            </Badge>
            <Badge>{categorize(result.scenarioId)}</Badge>
            <span className="font-mono text-xs text-muted-foreground">{result.scenarioId}</span>
          </div>
        </div>
        <Button
          ref={closeRef}
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          aria-label="Close details"
          onClick={onClose}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <section className="rounded-md border border-border bg-background/50 p-3">
          <h3 className="eyebrow mb-1">Expected behaviour</h3>
          <p className="text-sm">{result.expected}</p>
        </section>
        <section className="rounded-md border border-border bg-background/50 p-3">
          <h3 className="eyebrow mb-1">Actual: tools used</h3>
          <p className="break-words font-mono text-xs">
            {result.toolsCalled.length ? result.toolsCalled.join(' → ') : 'None'}
          </p>
        </section>
      </div>

      <section className="mt-3">
        <h3 className="eyebrow mb-1">Deterministic assertions</h3>
        {deterministic.length === 0 ? (
          <p className="flex items-center gap-1.5 text-sm text-ok">
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> All hard checks passed (tool
            order, forbidden tools and phrases, handoff).
          </p>
        ) : (
          <>
            <p className="mb-1 text-xs text-muted-foreground">What went wrong</p>
            <ul className="list-disc space-y-1 pl-5 text-sm text-danger">
              {deterministic.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="mt-3 rounded-md border border-dashed border-border p-3">
        <h3 className="eyebrow mb-1">LLM judge (qualitative, can be wrong)</h3>
        <p className="mb-1">
          <Badge tone={judge ? 'danger' : 'ok'}>{judge ? 'Judge disagreed' : 'Judge agreed'}</Badge>
        </p>
        <p className="text-sm text-muted-foreground">{judge ?? result.judgeReason}</p>
      </section>

      <section className="mt-3">
        <button
          type="button"
          onClick={() => setShowTranscript((s) => !s)}
          aria-expanded={showTranscript}
          className="eyebrow flex items-center gap-1 hover:text-foreground"
        >
          <ChevronRight
            className={cn('h-3.5 w-3.5 transition-transform', showTranscript && 'rotate-90')}
            aria-hidden="true"
          />
          Transcript ({result.transcript.length})
        </button>
        {showTranscript && (
          <ol className="mt-2 space-y-1.5 text-sm">
            {result.transcript.map((m, i) => (
              <li
                key={i}
                className={cn(
                  'rounded-md px-3 py-2',
                  m.role === 'user' ? 'bg-accent/10' : 'border border-border bg-elevated',
                )}
              >
                <span className="font-medium">{m.role === 'user' ? 'Customer' : 'Agent'}: </span>
                {m.content}
              </li>
            ))}
          </ol>
        )}
      </section>
    </aside>
  );
}

function DiffGroup({
  title,
  items,
  tone,
}: {
  title: string;
  items: EvalResultView[];
  tone: 'ok' | 'danger' | 'warn';
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="mb-1 flex items-center gap-1.5 text-xs font-medium">
        <Badge tone={tone}>{items.length}</Badge> {title}
      </p>
      <ul className="space-y-0.5 pl-1 text-sm">
        {items.map((r) => (
          <li key={r.scenarioId} className="truncate">
            {r.title}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Scenario-by-scenario comparison of two runs. There is no config versioning, so runs are compared. */
export function RunCompare({ before, after }: { before: EvalRunView; after: EvalRunView }) {
  const diff = compareRuns(before, after);
  const delta = after.passed - before.passed;
  const changed =
    diff.regressed.length + diff.fixed.length + diff.stillFailing.length + diff.added.length;
  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="eyebrow">Compared with previous run</h2>
        <Badge tone={delta > 0 ? 'ok' : delta < 0 ? 'danger' : 'neutral'}>
          {delta > 0 ? (
            <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
          ) : delta < 0 ? (
            <ArrowDownRight className="h-3 w-3" aria-hidden="true" />
          ) : null}
          {before.passed}/{before.total} → {after.passed}/{after.total}
        </Badge>
      </div>
      {changed === 0 ? (
        <p className="text-sm text-muted-foreground">
          No scenario changed result ({diff.unchanged} unchanged).
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <DiffGroup
            title="Regressed (passed before, fails now)"
            items={diff.regressed}
            tone="danger"
          />
          <DiffGroup title="Fixed (failed before, passes now)" items={diff.fixed} tone="ok" />
          <DiffGroup title="Still failing" items={diff.stillFailing} tone="warn" />
          <DiffGroup title="New scenarios" items={diff.added} tone="warn" />
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {diff.unchanged} unchanged. Configuration versions are not tracked yet, so this compares two
        runs rather than two config versions.
      </p>
    </Card>
  );
}
