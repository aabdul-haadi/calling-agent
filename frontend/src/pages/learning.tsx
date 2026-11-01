import { Check, Download, Play, RotateCcw, X } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/state-views';
import { Stat } from '@/components/ui/stat';
import { Tabs } from '@/components/ui/tabs';
import { useTenant } from '@/context/tenant';
import { useAuth } from '@/auth/context';
import { useAsync } from '@/hooks/use-async';
import { relativeTime } from '@/lib/utils';
import { Gates, KnowledgeChangesTab, ModelCard, TrainingTab } from '@/pages/learning-ml';
import {
  ApiError,
  api,
  learningCredentials,
  type LearningGap,
  type LearningRelease,
  type LearningTurn,
} from '@/services/api';

const FLAG_TEXT: Record<string, string> = {
  robotic_opener: 'Stock opening phrase',
  repeated_reply: 'Repeated its last reply',
  customer_repeated: 'Customer repeated themselves',
  too_long: 'Too long',
  unanswered: 'Policy question the documents could not answer',
  handoff_needs_review: 'Handoff that may have been avoidable',
  low_confidence_speech: 'Speech recognition unsure',
  tool_failed: 'A system call failed',
  formatting_in_voice: 'Formatting in a spoken reply',
  lost_context: 'Customer said they had already told us',
  customer_corrected: 'Customer corrected an earlier detail',
};

const RELEASE_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'neutral' | 'accent'> = {
  active: 'ok',
  shadow: 'accent',
  candidate: 'warn',
  superseded: 'neutral',
  rejected: 'danger',
  rolled_back: 'danger',
};

const KIND_TEXT: Record<string, string> = {
  llm_adapter: 'Fine-tuned local model',
  knowledge: 'Knowledge change',
  retrieval: 'Search settings',
  behavior: 'Style lessons',
  intent_model: 'Local intent model',
};

const message = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong.');

function Reviewer() {
  const { configured, profile } = useAuth();
  const [name, setName] = useState(learningCredentials().reviewer);
  const save = (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      // a browser that blocks storage simply asks again next time
    }
  };
  if (configured)
    return (
      <p className="text-sm text-muted-foreground">
        Review decisions are recorded as {profile?.name ?? profile?.email ?? profile?.subject}.
      </p>
    );
  return (
    <div className="flex flex-wrap items-end gap-3 text-sm">
      <label className="grid gap-1">
        <span className="eyebrow">Reviewer name</span>
        <input
          id="reviewer-name"
          className="h-9 rounded-md border border-border bg-card px-2"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            save('adk.reviewer', e.target.value);
          }}
          placeholder="Your name (kept with every decision)"
        />
      </label>
    </div>
  );
}

function TurnCard({ t, clientId, onDone }: { t: LearningTurn; clientId: string; onDone: () => void }) {
  const [reply, setReply] = useState(t.humanReply ?? t.aiReply);
  const [uses, setUses] = useState<string[]>(['sft']);
  const [source, setSource] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const decide = async (decision: 'approve' | 'reject' | 'exclude') => {
    setBusy(true);
    setError(undefined);
    try {
      await api.learning.review(clientId, t.id, {
        decision,
        approvedReply: reply,
        uses,
        ...(uses.includes('retrieval_eval') ? { expectedSource: source.trim() || null } : {}),
      });
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
        <Badge tone="accent">{t.channel === 'voice' ? 'Call' : 'Chat'}</Badge>
        <Badge>{t.intent.replace(/_/g, ' ')}</Badge>
        <Badge tone={t.resolution === 'resolved' || t.resolution === 'human_resolved' ? 'ok' : 'neutral'}>
          {t.resolution.replace(/_/g, ' ')}
        </Badge>
        {t.split === 'eval' && <Badge tone="warn">held out for evaluation</Badge>}
        {t.flags.map((f) => (
          <Badge key={f} tone="warn">
            {FLAG_TEXT[f] ?? f}
          </Badge>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">{relativeTime(t.createdAt)}</span>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <p>
          <span className="eyebrow mr-2">Customer</span>
          {t.customerText}
        </p>
        <p>
          <span className="eyebrow mr-2">Agent said</span>
          {t.aiReply}
        </p>
        {t.humanReply && (
          <p className="rounded-md border border-border bg-elevated p-2">
            <span className="eyebrow mr-2">Human colleague said (unverified lead)</span>
            {t.humanReply}
          </p>
        )}
        {t.correction && (
          <p className="rounded-md border border-border bg-elevated p-2">
            <span className="eyebrow mr-2">Customer suggested</span>
            {t.correction}
          </p>
        )}
        {t.sources.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Sources:{' '}
            {t.sources.map((s) => `${s.source}${s.page ? `, page ${s.page}` : ''}${s.weak ? ' (weak)' : ''}`).join('; ')}
          </p>
        )}
        {t.reviewStatus === 'pending' ? (
          <div className="grid gap-2">
            <label className="grid gap-1">
              <span className="eyebrow">Approved reply (redacted again when saved)</span>
              <textarea
                id={`reply-${t.id}`}
                className="min-h-16 rounded-md border border-border bg-card p-2"
                value={reply}
                onChange={(e) => setReply(e.target.value)}
              />
            </label>
            <fieldset className="flex flex-wrap items-center gap-3">
              <legend className="eyebrow mb-1">Use it for</legend>
              {[
                ['sft', 'Fine-tuning'],
                ['intent', 'Intent model'],
                ['retrieval_eval', 'Search evaluation'],
                ['behavior', 'Style lessons'],
              ].map(([id, label]) => (
                <label key={id} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={uses.includes(id!)}
                    onChange={(e) => setUses(e.target.checked ? [...uses, id!] : uses.filter((u) => u !== id))}
                  />
                  {label}
                </label>
              ))}
              {uses.includes('retrieval_eval') && (
                <input
                  aria-label="Document that should answer this"
                  className="h-8 rounded-md border border-border bg-card px-2"
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  placeholder="document name, empty if none should"
                />
              )}
            </fieldset>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={busy} onClick={() => void decide('approve')}>
                <Check className="size-4" /> Approve
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void decide('reject')}>
                <X className="size-4" /> Reject
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void decide('exclude')}>
                Exclude from learning
              </Button>
            </div>
            {error && (
              <p role="alert" className="text-danger">
                {error}
              </p>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t.reviewStatus} by {t.reviewer ?? 'unknown'}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function ReviewQueue({ clientId }: { clientId: string }) {
  const [status, setStatus] = useState<'pending' | 'approved' | 'rejected'>('pending');
  const turns = useAsync(() => api.learning.turns(clientId, status), [clientId, status]);
  return (
    <div className="grid gap-3">
      <div className="flex gap-2" role="group" aria-label="Show">
        {(['pending', 'approved', 'rejected'] as const).map((s) => (
          <Button key={s} size="sm" variant={status === s ? 'primary' : 'outline'} onClick={() => setStatus(s)}>
            {s === 'pending' ? 'Waiting for review' : s === 'approved' ? 'Approved' : 'Rejected'}
          </Button>
        ))}
      </div>
      {turns.error ? (
        <ErrorState message={turns.error} onRetry={turns.reload} />
      ) : turns.loading ? (
        <Skeleton className="h-40" />
      ) : !turns.data?.length ? (
        <EmptyState asset="folder" title="Nothing here" hint="Turns from calls and chats appear here once they have been redacted and checked." />
      ) : (
        turns.data.map((t) => <TurnCard key={t.id} t={t} clientId={clientId} onDone={turns.reload} />)
      )}
    </div>
  );
}

function Gaps({ clientId }: { clientId: string }) {
  const gaps = useAsync(() => api.learning.gaps(clientId), [clientId]);
  const set = async (g: LearningGap, status: string) => {
    await api.learning.gapStatus(clientId, g.id, status).catch(() => undefined);
    gaps.reload();
  };
  if (gaps.error) return <ErrorState message={gaps.error} onRetry={gaps.reload} />;
  if (gaps.loading) return <Skeleton className="h-32" />;
  if (!gaps.data?.length)
    return <EmptyState asset="learning" title="No recurring gaps yet" hint="Run a learning cycle after customers have asked questions the documents do not answer." />;
  return (
    <div className="grid gap-3">
      {gaps.data.map((g) => (
        <Card key={g.id}>
          <CardHeader className="flex-row flex-wrap items-center gap-2">
            <CardTitle className="text-base">{g.label}</CardTitle>
            <Badge tone="warn">{g.occurrences} times</Badge>
            {g.channels.map((c) => (
              <Badge key={c}>{c === 'voice' ? 'Calls' : 'Chat'}</Badge>
            ))}
            <Badge tone={g.status === 'open' ? 'danger' : 'ok'}>{g.status.replace(/_/g, ' ')}</Badge>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            <ul className="list-disc pl-5">
              {g.examples.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
            <p>{g.suggestion.recommendation}</p>
            {!!g.suggestion.unverifiedHumanAnswers?.length && (
              <p className="rounded-md border border-border bg-elevated p-2 text-xs">
                A colleague answered this on a call or chat: “{g.suggestion.unverifiedHumanAnswers[0]}”. This is a lead only. It becomes policy when an approved document says so.
              </p>
            )}
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => void set(g, 'document_requested')}>
                Document requested
              </Button>
              <Button size="sm" variant="outline" onClick={() => void set(g, 'covered_by_document')}>
                Now covered by a document
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void set(g, 'dismissed')}>
                Dismiss
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function Datasets({ clientId }: { clientId: string }) {
  const list = useAsync(() => api.learning.datasets(clientId), [clientId]);
  const [note, setNote] = useState<string>();
  const build = async () => {
    try {
      const r = await api.learning.buildDataset(clientId);
      setNote(
        r.meetsThreshold
          ? `Version ${r.dataset.version} is ready for training.`
          : `Version ${r.dataset.version} was built for review, but is below the ${r.threshold} examples needed before training.`,
      );
      list.reload();
    } catch (e) {
      setNote(message(e));
    }
  };
  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={() => void build()}>
          Freeze approved examples as a new version
        </Button>
        {note && <span role="status" className="text-sm">{note}</span>}
      </div>
      {list.error ? (
        <ErrorState message={list.error} onRetry={list.reload} />
      ) : list.loading ? (
        <Skeleton className="h-24" />
      ) : !list.data?.length ? (
        <EmptyState asset="savedFolder" title="No datasets yet" hint="Approve examples for fine-tuning, then freeze them here." />
      ) : (
        list.data.map((d) => (
          <Card key={d.id}>
            <CardContent className="flex flex-wrap items-center gap-3 py-3 text-sm">
              <strong>
                {d.kind} v{d.version}
              </strong>
              <span>{d.stats.examples} examples</span>
              <span className="text-muted-foreground">
                {d.stats.byChannel.voice} voice, {d.stats.byChannel.chat} chat, {d.stats.rejectedByChecks} dropped by checks
              </span>
              <span className="font-mono text-xs text-muted-foreground">{d.sha256.slice(0, 12)}</span>
              <a className="ml-auto inline-flex items-center gap-1 underline" href={api.learning.datasetUrl(clientId, d.id)}>
                <Download className="size-4" /> Download JSONL
              </a>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}

function ReleaseCard({ r, clientId, onDone }: { r: LearningRelease; clientId: string; onDone: () => void }) {
  const [error, setError] = useState<string>();
  const act = async (action: 'evaluate' | 'shadow' | 'deploy' | 'reject') => {
    setError(undefined);
    try {
      await api.learning.release(clientId, r.id, action);
      onDone();
    } catch (e) {
      setError(message(e));
    }
  };
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center gap-2">
        <CardTitle className="text-base">
          {KIND_TEXT[r.kind] ?? r.kind} v{r.version}
        </CardTitle>
        <Badge tone={RELEASE_TONE[r.status] ?? 'neutral'}>{r.status.replace(/_/g, ' ')}</Badge>
        <Badge>{r.channel === 'both' ? 'Voice and chat' : r.channel === 'voice' ? 'Voice' : 'Chat'}</Badge>
        {r.params.rollout < 100 && <Badge tone="accent">{r.params.rollout}% of conversations</Badge>}
        <span className="ml-auto text-xs text-muted-foreground">{relativeTime(r.createdAt)}</span>
      </CardHeader>
      <CardContent className="grid gap-2 text-sm">
        {r.note && <p className="text-muted-foreground">{r.note}</p>}
        {r.kind === 'llm_adapter' ? (
          <ModelCard r={r} clientId={clientId} onDone={onDone} />
        ) : r.kind === 'knowledge' ? (
          <Gates gates={r.evaluation.gates} />
        ) : r.evaluation.gates?.length ? (
          <ul className="grid gap-1">
            {r.evaluation.gates.map((g) => (
              <li key={g.name} className="flex gap-2">
                <Badge tone={g.pass ? 'ok' : 'danger'}>{g.pass ? 'pass' : 'fail'}</Badge>
                <span>
                  {g.name} <span className="text-muted-foreground">({g.detail})</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">Not evaluated yet.</p>
        )}
        {['candidate', 'shadow'].includes(r.status) && r.kind !== 'llm_adapter' && r.kind !== 'knowledge' && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => void act('evaluate')}>
              <Play className="size-4" /> Evaluate again
            </Button>
            {r.kind !== 'intent_model' && (
              <Button size="sm" disabled={!r.evaluation.passed} onClick={() => void act('deploy')}>
                Deploy
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => void act('reject')}>
              Reject
            </Button>
          </div>
        )}
        {r.status === 'active' && r.kind !== 'llm_adapter' && r.kind !== 'knowledge' && (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void api.learning
                .rollback(clientId, r.kind, r.channel)
                .then(onDone)
                .catch((e: unknown) => setError(message(e)))
            }
          >
            <RotateCcw className="size-4" /> Roll back
          </Button>
        )}
        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export function Releases({ clientId }: { clientId: string }) {
  const list = useAsync(() => api.learning.releases(clientId), [clientId]);
  const [note, setNote] = useState<string>();
  const run = async (label: string, fn: () => Promise<unknown>) => {
    setNote(`${label}…`);
    try {
      await fn();
      setNote(`${label}: done.`);
    } catch (e) {
      setNote(message(e));
    }
    list.reload();
  };
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => void run('Tuning search settings', () => api.learning.tuneRetrieval(clientId))}>
          Tune search settings
        </Button>
        <Button size="sm" variant="outline" onClick={() => void run('Training the intent model', () => api.learning.trainIntent(clientId))}>
          Train local intent model
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void run('Proposing style lessons', () => api.learning.proposeBehavior(clientId, { channel: 'voice' }))}
        >
          Propose style lessons (voice)
        </Button>
        {note && <span role="status" className="text-sm">{note}</span>}
      </div>
      {list.error ? (
        <ErrorState message={list.error} onRetry={list.reload} />
      ) : list.loading ? (
        <Skeleton className="h-32" />
      ) : !list.data?.length ? (
        <EmptyState asset="models" title="No releases yet" hint="A release only goes live after it passes every evaluation gate and a person deploys it." />
      ) : (
        list.data.map((r) => <ReleaseCard key={r.id} r={r} clientId={clientId} onDone={list.reload} />)
      )}
    </div>
  );
}

function Jobs({ clientId }: { clientId: string }) {
  const jobs = useAsync(() => api.learning.jobs(clientId), [clientId], 10000);
  if (jobs.error) return <ErrorState message={jobs.error} onRetry={jobs.reload} />;
  if (jobs.loading) return <Skeleton className="h-24" />;
  if (!jobs.data?.length) return <EmptyState asset="time" title="No jobs yet" hint="Run a learning cycle to see its steps here." />;
  return (
    <div className="grid gap-2">
      {jobs.data.map((j) => (
        <Card key={j.id}>
          <CardContent className="flex flex-wrap items-center gap-3 py-3 text-sm">
            <strong>{j.kind}</strong>
            <Badge tone={j.status === 'done' ? 'ok' : j.status === 'failed' ? 'danger' : 'accent'}>{j.status}</Badge>
            <span className="text-muted-foreground">{j.trigger}</span>
            <span className="ml-auto text-xs text-muted-foreground">{relativeTime(j.startedAt)}</span>
            {j.error && <span className="w-full text-danger">{j.error}</span>}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function LearningPage() {
  const { tenant } = useTenant();
  const clientId = tenant?.id ?? '';
  const overview = useAsync(() => api.learning.overview(clientId), [clientId], 15000);
  const [tab, setTab] = useState('review');
  const [cycle, setCycle] = useState<string>();
  const o = overview.data;
  const authorized = o?.eligibility?.authorized;
  const runCycle = async () => {
    setCycle('Running…');
    try {
      await api.learning.runCycle(clientId);
      setCycle('Cycle finished.');
    } catch (e) {
      setCycle(message(e));
    }
    overview.reload();
  };
  return (
    <div className="grid min-w-0 grid-cols-1 gap-4">
      <PageHeader
        title="Learning"
        description="Review conversations, turn useful examples into improvements, and test every change before it can affect customers."
        eyebrow="Learning"
        actions={
          <Button size="sm" disabled={authorized !== true} onClick={() => void runCycle()}>
            Run a learning cycle
          </Button>
        }
      />
      {o && (
        <p
          role={authorized === true ? 'status' : 'alert'}
          className={`rounded-md border p-3 text-sm ${
            authorized === true
              ? 'border-border bg-card text-muted-foreground'
              : 'border-danger/40 bg-danger/10 text-danger'
          }`}
        >
          {authorized === true
            ? 'Tenant authorization is enabled for conversation-derived learning.'
            : authorized === false
              ? 'Conversation-derived learning is disabled for this company. Add it to LEARNING_AUTHORIZED_CLIENTS only after confirming the applicable customer notice, contractual basis, and data-handling approval.'
              : 'Unable to verify tenant authorization. Learning actions are disabled until authorization details are available.'}
        </p>
      )}
      {cycle && (
        <p role="status" className="text-sm">
          {cycle}
        </p>
      )}
      <Reviewer />
      {overview.error ? (
        <ErrorState message={overview.error} onRetry={overview.reload} />
      ) : (
        <dl className="grid grid-cols-2 gap-4 md:grid-cols-5">
          <Stat label="Waiting for review" value={o ? (o.review['pending'] ?? 0) : null} />
          <Stat label="Approved" value={o ? (o.review['approved'] ?? 0) : null} tone="ok" />
          <Stat label="From calls / chats" value={o ? `${o.byChannel['voice'] ?? 0} / ${o.byChannel['chat'] ?? 0}` : null} />
          <Stat label="Open knowledge gaps" value={o ? o.openGaps : null} tone={o && o.openGaps > 0 ? 'warn' : undefined} />
          <Stat label="Datasets frozen" value={o ? o.datasets : null} hint={o ? `needs ${o.thresholds.minSftExamples} to train` : undefined} />
        </dl>
      )}
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'review', label: 'Review queue', content: <ReviewQueue clientId={clientId} /> },
          { id: 'gaps', label: 'Knowledge gaps', content: <Gaps clientId={clientId} /> },
          { id: 'datasets', label: 'Datasets', content: <Datasets clientId={clientId} /> },
          { id: 'training', label: 'Training', content: <TrainingTab clientId={clientId} /> },
          { id: 'changes', label: 'Knowledge changes', content: <KnowledgeChangesTab clientId={clientId} /> },
          { id: 'releases', label: 'Evaluation and releases', content: <Releases clientId={clientId} /> },
          { id: 'jobs', label: 'Jobs', content: <Jobs clientId={clientId} /> },
        ]}
      />
    </div>
  );
}
