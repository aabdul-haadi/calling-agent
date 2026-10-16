import { Check, Play, RotateCcw, Square, Upload, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/state-views';
import { useAsync } from '@/hooks/use-async';
import { relativeTime } from '@/lib/utils';
import {
  ApiError,
  api,
  type KnowledgeProposal,
  type LearningGap,
  type LearningGate,
  type LearningRelease,
  type LearningRun,
  type ShadowReport,
} from '@/services/api';

const message = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong.');

const RUN_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'neutral' | 'accent'> = {
  done: 'ok',
  running: 'accent',
  queued: 'accent',
  cancelling: 'warn',
  cancelled: 'neutral',
  interrupted: 'warn',
  failed: 'danger',
  refused: 'danger',
};

const CAUSE_TEXT: Record<string, string> = {
  missing_information: 'The documents never covered this',
  threshold_too_strict: 'The answer may already be there, just below the relevance bar',
  ranking_problem: 'Covered, but ranked too low',
  extraction_problem: 'A document could not be read',
  possible_conflict: 'Two documents seem to disagree',
  should_stay_unanswered: 'Out of scope: the agent should offer a person',
};

export function Gates({ gates, inconclusive }: { gates?: LearningGate[]; inconclusive?: boolean }) {
  if (!gates?.length) return <p className="text-muted-foreground">Not evaluated yet.</p>;
  return (
    <div className="grid gap-1">
      {inconclusive && (
        <p role="status" className="text-warn">
          Inconclusive: there is not enough evidence to decide. More reviewed examples are needed.
        </p>
      )}
      <ul className="grid gap-1">
        {gates.map((g) => (
          <li key={g.name} className="flex gap-2">
            <Badge tone={g.pass ? 'ok' : g.verdict === 'inconclusive' ? 'warn' : 'danger'}>
              {g.pass ? 'pass' : g.verdict === 'inconclusive' ? 'unclear' : 'fail'}
            </Badge>
            <span>
              {g.name} <span className="text-muted-foreground">({g.detail})</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---- Training -------------------------------------------------------------------------------

function RunCard({ r, clientId, onDone }: { r: LearningRun; clientId: string; onDone: () => void }) {
  const [error, setError] = useState<string>();
  const act = async (a: 'cancel' | 'resume') => {
    setError(undefined);
    try {
      await api.learning.runAction(clientId, r.id, a);
      onDone();
    } catch (e) {
      setError(message(e));
    }
  };
  const step = r.progress.step ?? 0;
  const of = r.progress.of ?? 0;
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center gap-2">
        <CardTitle className="text-base">{r.kind === 'smoke' ? 'Toolchain test' : 'Fine-tuning'}</CardTitle>
        <Badge tone={RUN_TONE[r.status] ?? 'neutral'}>{r.status}</Badge>
        <Badge>{r.base}</Badge>
        <span className="ml-auto text-xs text-muted-foreground">{relativeTime(r.startedAt)}</span>
      </CardHeader>
      <CardContent className="grid gap-2 text-sm">
        {of > 0 && (
          <div
            role="progressbar"
            aria-label={`Training progress for run ${r.id.slice(0, 8)}`}
            aria-valuemin={0}
            aria-valuemax={of}
            aria-valuenow={step}
            className="h-1.5 w-full overflow-hidden rounded-full bg-elevated"
          >
            <div className="h-full bg-accent" style={{ width: `${Math.min(100, (step / of) * 100)}%` }} />
          </div>
        )}
        <p className="text-muted-foreground">
          {of > 0 ? `Step ${step} of ${of}` : 'Waiting'}
          {r.progress.loss !== undefined ? `, loss ${r.progress.loss}` : ''}
          {r.metrics.validationLoss !== undefined ? `, validation loss ${r.metrics.validationLoss}` : ''}
          {r.metrics.seconds !== undefined ? `, ${Math.round(r.metrics.seconds)} s` : ''}
          {r.metrics.peakMemoryMb ? `, peak ${r.metrics.peakMemoryMb} MB` : ''}
          {r.metrics.device ? `, ${r.metrics.device}` : ''}
        </p>
        {r.error && <p className="text-danger">{r.error}</p>}
        {r.kind === 'smoke' && r.status === 'done' && (
          <p>The toolchain works. A test run is never offered as a model.</p>
        )}
        {r.releaseId && <p>Registered as a candidate model. Compare it with production under Evaluation and releases.</p>}
        <details>
          <summary className="cursor-pointer text-muted-foreground">Log</summary>
          <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-elevated p-2 text-xs">{r.logTail || '(no output yet)'}</pre>
        </details>
        <div className="flex gap-2">
          {['running', 'queued'].includes(r.status) && (
            <Button size="sm" variant="outline" onClick={() => void act('cancel')}>
              <Square className="size-4" /> Cancel (saves a checkpoint)
            </Button>
          )}
          {r.kind === 'train' && ['cancelled', 'interrupted', 'failed'].includes(r.status) && (
            <Button size="sm" variant="outline" onClick={() => void act('resume')}>
              <Play className="size-4" /> Resume
            </Button>
          )}
        </div>
        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export function TrainingTab({ clientId }: { clientId: string }) {
  const hw = useAsync(() => api.learning.hardware(clientId), [clientId]);
  const datasets = useAsync(() => api.learning.datasets(clientId), [clientId]);
  const runs = useAsync(() => api.learning.runs(clientId), [clientId], 4000);
  const [datasetId, setDatasetId] = useState('');
  const [note, setNote] = useState<string>();
  const start = async (smoke: boolean) => {
    setNote(undefined);
    try {
      await api.learning.startRun(clientId, smoke ? { smoke: true } : { datasetId: datasetId || datasets.data?.[0]?.id });
      runs.reload();
    } catch (e) {
      setNote(message(e));
    }
  };
  return (
    <div className="grid gap-3">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">This machine</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-1 text-sm">
          {hw.error ? (
            <ErrorState message={hw.error} onRetry={hw.reload} />
          ) : hw.loading || !hw.data ? (
            <Skeleton className="h-16" />
          ) : (
            <>
              <p>
                <Badge tone={hw.data.verdict === 'not_ready' ? 'danger' : hw.data.verdict === 'gpu' ? 'ok' : 'warn'}>
                  {hw.data.verdict === 'gpu' ? 'GPU ready' : hw.data.verdict === 'cpu_slow' ? 'CPU only (slow)' : 'Not ready'}
                </Badge>{' '}
                {hw.data.reason}
              </p>
              <p className="text-muted-foreground">
                {hw.data.cpuThreads} CPU threads, {hw.data.ramGb?.toFixed(1)} GB memory ({hw.data.ramAvailableGb?.toFixed(1)} GB free), GPU:{' '}
                {hw.data.gpu ? `${hw.data.gpu.name}, ${hw.data.gpu.memoryGb.toFixed(1)} GB` : 'none usable'}. Base model {hw.data.base}
                {hw.data.estimatedTrainingMemoryGb ? ` needs about ${hw.data.estimatedTrainingMemoryGb} GB while training` : ''}.
              </p>
              <p className="text-muted-foreground">
                Libraries:{' '}
                {Object.entries(hw.data.libraries)
                  .map(([k, v]) => `${k} ${v ?? 'missing'}`)
                  .join(', ')}
              </p>
            </>
          )}
        </CardContent>
      </Card>
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label className="grid gap-1">
          <span className="eyebrow">Frozen dataset to train on</span>
          <select
            id="training-dataset"
            className="h-9 rounded-md border border-border bg-card px-2"
            value={datasetId}
            onChange={(e) => setDatasetId(e.target.value)}
          >
            {(datasets.data ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.kind} v{d.version}: {d.stats.examples} examples{d.stats.examples < d.stats.minExamples ? ' (too few)' : ''}
              </option>
            ))}
          </select>
        </label>
        <Button size="sm" disabled={!datasets.data?.length} onClick={() => void start(false)}>
          Start training
        </Button>
        <Button size="sm" variant="outline" onClick={() => void start(true)}>
          Run a toolchain test
        </Button>
        {note && (
          <span role="alert" className="text-danger">
            {note}
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Training refuses datasets that are too small, altered, contain personal data or overlap the held-out questions, and says why. It never
        starts by itself.
      </p>
      {runs.error ? (
        <ErrorState message={runs.error} onRetry={runs.reload} />
      ) : runs.loading ? (
        <Skeleton className="h-24" />
      ) : !runs.data?.length ? (
        <EmptyState title="No training runs yet" hint="Approve examples for fine-tuning, freeze a dataset, then start a run." />
      ) : (
        runs.data.map((r) => <RunCard key={r.id} r={r} clientId={clientId} onDone={runs.reload} />)
      )}
    </div>
  );
}

// ---- Candidate models -------------------------------------------------------------------------

export function ModelCard({ r, clientId, onDone }: { r: LearningRelease; clientId: string; onDone: () => void }) {
  const [error, setError] = useState<string>();
  const [shadow, setShadow] = useState<ShadowReport>();
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      onDone();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const cfg = (r.params.config ?? {}) as { base?: string };
  return (
    <div className="grid gap-2 text-sm">
      <p className="text-muted-foreground">
        Base {cfg.base}. It writes text only: it has no tools, so it cannot change a booking. It is compared with the production model on held-out reviewed examples.
      </p>
      <Gates gates={r.evaluation.gates} inconclusive={(r.evaluation as { inconclusive?: boolean }).inconclusive} />
      {shadow && (
        <p>
          Shadow: {shadow.stats.n} answers, {shadow.stats.failed} failed, median {Math.round(shadow.stats.p50)} ms, slowest typical {Math.round(shadow.stats.p95)} ms.
        </p>
      )}
      {['candidate', 'shadow'].includes(r.status) && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => api.learning.modelAction(clientId, r.id, 'evaluate'))}>
            <Play className="size-4" /> Compare with production
          </Button>
          {r.status === 'candidate' && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => api.learning.modelAction(clientId, r.id, 'shadow'))}>
              Start shadow mode
            </Button>
          )}
          {r.status === 'shadow' && (
            <>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void api.learning.shadowReport(clientId, r.id).then(setShadow).catch((e: unknown) => setError(message(e)))}>
                Show shadow results
              </Button>
              <Button size="sm" disabled={busy || !r.evaluation.passed} onClick={() => void run(() => api.learning.modelAction(clientId, r.id, 'promote'))}>
                Promote
              </Button>
            </>
          )}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => api.learning.release(clientId, r.id, 'reject'))}>
            Reject
          </Button>
        </div>
      )}
      {r.status === 'active' && (
        <Button size="sm" variant="outline" onClick={() => void run(() => api.learning.rollback(clientId, 'llm_adapter', r.channel))}>
          <RotateCcw className="size-4" /> Roll back
        </Button>
      )}
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

// ---- Knowledge changes ------------------------------------------------------------------------

function ProposalCard({ p, clientId, onDone }: { p: KnowledgeProposal; clientId: string; onDone: () => void }) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const act = async (a: 'evaluate' | 'approve' | 'reject' | 'deploy' | 'rollback') => {
    setBusy(true);
    setError(undefined);
    try {
      await api.learning.proposalAction(clientId, p.id, a);
      onDone();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center gap-2">
        <CardTitle className="text-base">{p.title}</CardTitle>
        <Badge tone={p.status === 'deployed' ? 'ok' : p.status === 'failed' || p.status === 'rejected' ? 'danger' : 'accent'}>{p.status.replace(/_/g, ' ')}</Badge>
        <Badge>{p.docName}</Badge>
        <span className="ml-auto text-xs text-muted-foreground">{relativeTime(p.createdAt)}</span>
      </CardHeader>
      <CardContent className="grid gap-2 text-sm">
        <p className="text-muted-foreground">
          Source: {p.attestation.sourceType?.replace(/_/g, ' ')}, owned by {p.attestation.owner}, {p.attestation.reference}
        </p>
        <Gates gates={p.evaluation.gates} inconclusive={p.evaluation.inconclusive} />
        {p.note && <p className="text-muted-foreground">{p.note}</p>}
        <div className="flex flex-wrap gap-2">
          {['draft', 'evaluated', 'failed'].includes(p.status) && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void act('evaluate')}>
              <Play className="size-4" /> Build and evaluate a candidate index
            </Button>
          )}
          {p.status === 'evaluated' && (
            <Button size="sm" disabled={busy || !p.evaluation.passed} onClick={() => void act('approve')}>
              <Check className="size-4" /> Approve
            </Button>
          )}
          {p.status === 'approved' && (
            <Button size="sm" disabled={busy} onClick={() => void act('deploy')}>
              Publish to voice and chat
            </Button>
          )}
          {p.status === 'deployed' && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void act('rollback')}>
              <RotateCcw className="size-4" /> Roll back
            </Button>
          )}
          {!['deployed', 'rejected', 'rolled_back'].includes(p.status) && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act('reject')}>
              <X className="size-4" /> Reject
            </Button>
          )}
        </div>
        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function GapProposer({ gap, clientId, onDone }: { gap: LearningGap; clientId: string; onDone: () => void }) {
  const diagnosis = useAsync(() => api.learning.diagnosis(clientId, gap.id), [clientId, gap.id]);
  const file = useRef<HTMLInputElement>(null);
  const [owner, setOwner] = useState('');
  const [reference, setReference] = useState('');
  const [sourceType, setSourceType] = useState('official_document');
  const [error, setError] = useState<string>();
  const send = async () => {
    const f = file.current?.files?.[0];
    if (!f) return setError('Choose the PDF first.');
    setError(undefined);
    try {
      await api.learning.uploadProposal(clientId, f, { title: `${gap.label}: ${f.name}`, gapId: gap.id, sourceType, owner, reference });
      onDone();
    } catch (e) {
      setError(message(e));
    }
  };
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center gap-2">
        <CardTitle className="text-base">{gap.label}</CardTitle>
        <Badge tone="warn">{gap.occurrences} times</Badge>
      </CardHeader>
      <CardContent className="grid gap-2 text-sm">
        {diagnosis.data && (
          <p>
            <Badge tone={diagnosis.data.change === 'document' ? 'danger' : 'accent'}>{CAUSE_TEXT[diagnosis.data.cause] ?? diagnosis.data.cause}</Badge>{' '}
            {diagnosis.data.recommendation}
          </p>
        )}
        {diagnosis.data?.evidence.map((e) => (
          <p key={e} className="text-xs text-muted-foreground">
            {e}
          </p>
        ))}
        {(!diagnosis.data || diagnosis.data.change === 'document') && (
          <div className="grid gap-2 rounded-md border border-border p-2">
            <span className="eyebrow">Attach the approved source document</span>
            <input ref={file} id={`pdf-${gap.id}`} aria-label="Policy PDF" type="file" accept="application/pdf" />
            <div className="flex flex-wrap gap-2">
              <select aria-label="Kind of source" className="h-9 rounded-md border border-border bg-card px-2" value={sourceType} onChange={(e) => setSourceType(e.target.value)}>
                <option value="official_document">Official published document</option>
                <option value="policy_owner_confirmation">Written by the policy owner</option>
              </select>
              <input aria-label="Policy owner" className="h-9 rounded-md border border-border bg-card px-2" placeholder="Policy owner" value={owner} onChange={(e) => setOwner(e.target.value)} />
              <input aria-label="Where it is published" className="h-9 rounded-md border border-border bg-card px-2" placeholder="Where it is published" value={reference} onChange={(e) => setReference(e.target.value)} />
              <Button size="sm" onClick={() => void send()}>
                <Upload className="size-4" /> Propose this document
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">A chat or a call is never a source. The agents keep using the live documents until the change is evaluated, approved and published.</p>
            {error && (
              <p role="alert" className="text-danger">
                {error}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function KnowledgeChangesTab({ clientId }: { clientId: string }) {
  const gaps = useAsync(() => api.learning.gaps(clientId), [clientId]);
  const proposals = useAsync(() => api.learning.proposals(clientId), [clientId], 5000);
  const open = (gaps.data ?? []).filter((g) => g.status === 'open');
  return (
    <div className="grid gap-4">
      <section className="grid gap-3" aria-label="Gaps to fix">
        <h3 className="text-base font-semibold">Gaps to fix</h3>
        {gaps.error ? (
          <ErrorState message={gaps.error} onRetry={gaps.reload} />
        ) : gaps.loading ? (
          <Skeleton className="h-24" />
        ) : !open.length ? (
          <EmptyState title="No open gaps" hint="Run a learning cycle after customers have asked questions the documents do not answer." />
        ) : (
          open.map((g) => <GapProposer key={g.id} gap={g} clientId={clientId} onDone={proposals.reload} />)
        )}
      </section>
      <section className="grid gap-3" aria-label="Proposed changes">
        <h3 className="text-base font-semibold">Proposed changes</h3>
        {proposals.error ? (
          <ErrorState message={proposals.error} onRetry={proposals.reload} />
        ) : proposals.loading ? (
          <Skeleton className="h-24" />
        ) : !proposals.data?.length ? (
          <EmptyState title="Nothing proposed" hint="A proposal is a document plus who owns it. It is measured on a copy of the index before anything changes." />
        ) : (
          proposals.data.map((p) => <ProposalCard key={p.id} p={p} clientId={clientId} onDone={proposals.reload} />)
        )}
      </section>
    </div>
  );
}
