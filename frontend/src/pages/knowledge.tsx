import {
  AlertTriangle,
  BookOpen,
  FileText,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import { useRef, useState, type DragEvent, type FormEvent } from 'react';
import type { Citation, KnowledgeDoc, KnowledgeSearchResult, KnowledgeStatus } from '@adk/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/state-views';
import { useTenant } from '@/context/tenant';
import { useAsync } from '@/hooks/use-async';
import { cn, formatBytes, relativeTime } from '@/lib/utils';
import { ApiError, api } from '@/services/api';

const BUSY: KnowledgeStatus[] = ['queued', 'extracting', 'indexing'];

const STATUS_LABEL: Record<KnowledgeStatus, string> = {
  queued: 'Waiting',
  extracting: 'Reading',
  indexing: 'Indexing',
  ready: 'Ready',
  failed: 'Failed',
  superseded: 'Replaced',
};

const statusTone = (s: KnowledgeStatus) =>
  s === 'ready' ? 'ok' : s === 'failed' ? 'danger' : s === 'superseded' ? 'neutral' : 'accent';

const ERROR_HELP: Record<string, string> = {
  PASSWORD_PROTECTED: 'Remove the password in a PDF viewer, then upload it again.',
  CORRUPTED: 'The file is damaged or not really a PDF. Export it again from the original.',
  EMPTY: 'The PDF has no pages.',
  NO_TEXT: 'No text could be read. If it is a scan, make sure OCR is on (KNOWLEDGE_OCR=auto).',
  EXTRACTOR_MISSING: 'The PDF reader is not installed. Run: pnpm docs:setup',
  TIMEOUT: 'Reading took too long. Try a smaller file, or split it.',
};

export const pagesLabel = (p?: number, end?: number) =>
  p ? `page ${p}${end && end !== p ? `–${end}` : ''}` : '';

function Progress({ value, label }: { value: number; label: string }) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value)}
      className="h-1.5 w-full overflow-hidden rounded-full bg-elevated"
    >
      <div
        className="h-full rounded-full bg-accent transition-[width] duration-500 motion-reduce:transition-none"
        style={{ width: `${Math.max(3, Math.min(100, value))}%` }}
      />
    </div>
  );
}

function DocumentCard({
  doc,
  busy,
  onAction,
  onDelete,
}: {
  doc: KnowledgeDoc;
  busy: boolean;
  onAction: (fn: () => Promise<unknown>) => void;
  onDelete: (doc: KnowledgeDoc) => void;
}) {
  const { tenant } = useTenant();
  const status = doc.status ?? 'ready';
  const working = BUSY.includes(status) || Boolean(doc.stage && status === 'ready');
  const upload = doc.origin === 'upload';
  const [open, setOpen] = useState(false);
  return (
    <Card className="flex h-full flex-col gap-3 p-4">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent"
        >
          <FileText className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-mono text-sm font-medium" title={doc.source}>
            {doc.source}
          </h2>
          <p className="text-xs text-muted-foreground">
            {doc.pages ? `${doc.pages} pages · ` : ''}
            {doc.chunks} {doc.chunks === 1 ? 'section' : 'sections'}
            {doc.ocrPages ? ` · ${doc.ocrPages} read by OCR` : ''}
            {doc.sizeBytes ? ` · ${formatBytes(doc.sizeBytes)}` : ''} ·{' '}
            {relativeTime(doc.updatedAt)}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Badge tone={statusTone(status)}>{STATUS_LABEL[status]}</Badge>
          <span className="flex gap-1">
            <Badge>{upload ? 'Uploaded' : 'Built in'}</Badge>
            {doc.version && doc.version > 1 && <Badge>v{doc.version}</Badge>}
          </span>
        </div>
      </div>

      {working && (
        <div className="space-y-1" role="status" aria-live="polite">
          <Progress value={doc.progress ?? 0} label={`Progress for ${doc.source}`} />
          <p className="text-xs text-muted-foreground">{doc.stage ?? 'Working…'}</p>
        </div>
      )}

      {status === 'failed' && doc.error && (
        <div role="alert" className="rounded-md border border-danger/40 bg-danger/10 p-2.5 text-sm">
          <p className="font-medium text-danger">
            {doc.error.message}{' '}
            <span className="font-mono text-xs text-muted-foreground">({doc.error.code})</span>
          </p>
          {ERROR_HELP[doc.error.code] && (
            <p className="mt-1 text-xs text-muted-foreground">{ERROR_HELP[doc.error.code]}</p>
          )}
        </div>
      )}

      {doc.warnings && doc.warnings.length > 0 && (
        <details className="rounded-md border border-warn/30 bg-warn/10 p-2 text-xs">
          <summary className="flex cursor-pointer items-center gap-1.5 font-medium">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
            {doc.warnings.length} {doc.warnings.length === 1 ? 'note' : 'notes'} about this document
          </summary>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
            {doc.warnings.slice(0, 12).map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}

      {doc.headings.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={`Sections in ${doc.source}`}>
          {doc.headings.slice(0, 8).map((h) => (
            <li key={h}>
              <Badge>{h}</Badge>
            </li>
          ))}
        </ul>
      )}

      {doc.versions && doc.versions.length > 0 && (
        <div className="text-xs text-muted-foreground">
          <button
            type="button"
            className="underline"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? 'Hide' : 'Show'} {doc.versions.length} older{' '}
            {doc.versions.length === 1 ? 'version' : 'versions'}
          </button>
          {open && (
            <ul className="mt-1 space-y-0.5">
              {doc.versions.map((v) => (
                <li key={v.id}>
                  Version {v.version} · {STATUS_LABEL[v.status]} · {relativeTime(v.updatedAt)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {upload && tenant && (
        <div className="mt-auto flex flex-wrap gap-2 pt-1">
          {status === 'failed' && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => onAction(() => api.retryKnowledge(tenant.id, doc.id!))}
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> Try again
            </Button>
          )}
          {status === 'ready' && (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || working}
                onClick={() => onAction(() => api.reindexKnowledge(tenant.id, doc.id!))}
                title="Rebuild the searchable sections from the text already read"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Re-index
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || working}
                onClick={() => onAction(() => api.reindexKnowledge(tenant.id, doc.id!, true))}
                title="Read the PDF again from scratch, then rebuild"
              >
                Re-read PDF
              </Button>
            </>
          )}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDelete(doc)}>
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Delete
          </Button>
        </div>
      )}
    </Card>
  );
}

function Uploader({ clientId, onDone }: { clientId: string; onDone: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [messages, setMessages] = useState<{ text: string; tone: 'ok' | 'danger' }[]>([]);
  const [sending, setSending] = useState(false);

  async function send(files: File[]) {
    setSending(true);
    const out: { text: string; tone: 'ok' | 'danger' }[] = [];
    for (const file of files) {
      if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
        out.push({ text: `${file.name}: only PDF files are supported.`, tone: 'danger' });
        continue;
      }
      try {
        const res = await api.uploadKnowledge(clientId, file);
        out.push({
          text: res.unchanged
            ? `${file.name}: this exact file is already the current version.`
            : `${file.name}: uploaded. It is being read now; you can keep using the agent.`,
          tone: 'ok',
        });
      } catch (e) {
        out.push({
          text: `${file.name}: ${e instanceof ApiError ? e.message : 'upload failed'}`,
          tone: 'danger',
        });
      }
    }
    setMessages(out);
    setSending(false);
    onDone();
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void send([...e.dataTransfer.files]);
  };

  return (
    <Card
      className={cn('border-dashed p-5 transition-colors', over && 'border-accent bg-accent/5')}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <div className="flex flex-col items-center gap-2 text-center sm:flex-row sm:text-left">
        <span
          aria-hidden="true"
          className="flex h-10 w-10 items-center justify-center rounded-full bg-accent/10 text-accent"
        >
          <Upload className="h-5 w-5" />
        </span>
        <div className="flex-1">
          <p className="font-medium">Add policy PDFs</p>
          <p className="text-sm text-muted-foreground">
            Drop one or more PDFs here. Large files and scans are fine: they are read in the
            background. Uploading a file with the same name makes a new version that replaces the
            old one.
          </p>
        </div>
        <input
          ref={input}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          className="sr-only"
          aria-label="Choose PDF files to upload"
          onChange={(e) => {
            void send([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
        <Button disabled={sending} onClick={() => input.current?.click()}>
          <Upload className="h-4 w-4" aria-hidden="true" /> {sending ? 'Uploading…' : 'Choose PDFs'}
        </Button>
      </div>
      {messages.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm" role="status" aria-live="polite">
          {messages.map((m, i) => (
            <li key={i} className={m.tone === 'danger' ? 'text-danger' : 'text-muted-foreground'}>
              {m.text}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const WORD = /[a-z0-9$.%]+/gi;
/** The meaningful words of an expected answer: numbers, money and words of four letters or more. */
export function keyTerms(text: string): string[] {
  return [
    ...new Set(
      (text.match(WORD) ?? [])
        .map((w) => w.replace(/[.]+$/, '').toLowerCase())
        .filter((w) => /\d/.test(w) || w.length >= 4),
    ),
  ];
}

function Passage({ p, terms }: { p: Citation; terms: string[] }) {
  const [more, setMore] = useState(false);
  const lower = p.snippet.toLowerCase();
  return (
    <li className="rounded-md border border-border bg-background/50 p-3 text-sm">
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <Badge tone="accent">{p.source}</Badge>
        {p.page && <Badge>{pagesLabel(p.page, p.pageEnd)}</Badge>}
        {p.version && p.version > 1 && <Badge>version {p.version}</Badge>}
        {p.weak && <Badge tone="warn">weak match: the agent decides whether it answers</Badge>}
        <span className="ml-auto text-xs text-muted-foreground">
          {p.match?.rerank !== undefined && <>relevance {p.match.rerank} · </>}
          {p.match?.vector !== undefined && <>meaning {Math.round(p.match.vector * 100)}% · </>}
          {p.match?.keyword !== undefined && <>words {Math.round(p.match.keyword * 100)}%</>}
        </span>
      </div>
      <p className="mb-1 text-xs text-muted-foreground">{p.heading}</p>
      <p className={cn('whitespace-pre-line', !more && 'line-clamp-5')}>{p.snippet}</p>
      {p.snippet.length > 350 && (
        <button type="button" className="mt-1 text-xs underline" onClick={() => setMore((m) => !m)}>
          {more ? 'Show less' : 'Show all'}
        </button>
      )}
      {terms.length > 0 && (
        <p className="mt-1.5 flex flex-wrap gap-1 text-xs">
          {terms.map((t) => (
            <Badge key={t} tone={lower.includes(t) ? 'ok' : 'neutral'}>
              {lower.includes(t) ? '✓' : '·'} {t}
            </Badge>
          ))}
        </p>
      )}
    </li>
  );
}

function TestQuestion({ clientId }: { clientId: string }) {
  const [question, setQuestion] = useState('');
  const [previous, setPrevious] = useState('');
  const [expected, setExpected] = useState('');
  const [result, setResult] = useState<KnowledgeSearchResult>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function run(e: FormEvent) {
    e.preventDefault();
    if (!question.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      setResult(
        await api.searchKnowledge(
          clientId,
          question.trim(),
          previous.trim() ? [previous.trim()] : [],
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The search failed');
    } finally {
      setBusy(false);
    }
  }

  const terms = keyTerms(expected);
  const evidence = result?.passages.map((p) => p.snippet.toLowerCase()).join(' ') ?? '';
  const found = terms.filter((t) => evidence.includes(t));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Search className="h-4 w-4" aria-hidden="true" /> Test a question
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Ask what a customer might ask. You see the passages the agent would be given, with their
          pages, and why nothing was returned if the documents do not say.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={run} className="grid gap-3 md:grid-cols-2">
          <label className="block text-sm md:col-span-2">
            <span className="mb-1 block font-medium">Question</span>
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Can I get a refund if the airline cancels my flight?"
              className="h-10 w-full rounded-md border border-border bg-card px-3"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Earlier question (optional)</span>
            <input
              value={previous}
              onChange={(e) => setPrevious(e.target.value)}
              placeholder="To test a follow-up such as “and how long does it take?”"
              className="h-10 w-full rounded-md border border-border bg-card px-3"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Expected answer (optional)</span>
            <input
              value={expected}
              onChange={(e) => setExpected(e.target.value)}
              placeholder="7 business days"
              className="h-10 w-full rounded-md border border-border bg-card px-3"
            />
          </label>
          <div className="md:col-span-2">
            <Button type="submit" disabled={busy || !question.trim()}>
              <Search className="h-4 w-4" aria-hidden="true" /> {busy ? 'Searching…' : 'Search'}
            </Button>
          </div>
        </form>

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}

        {result && (
          <div className="space-y-3" aria-live="polite">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={result.relevant ? 'ok' : 'warn'}>
                {result.relevant
                  ? 'Evidence found'
                  : 'Not covered: the agent would say it is not sure'}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {result.timings.totalMs} ms (embed {result.timings.embedMs}, meaning{' '}
                {result.timings.vectorMs}, words {result.timings.keywordMs}
                {result.timings.rerankMs !== undefined
                  ? `, relevance check ${result.timings.rerankMs}`
                  : ''}
                ) · {result.considered} candidates · {result.embedding}
              </span>
            </div>
            <p className="text-sm text-muted-foreground">{result.reason}</p>
            {result.searched !== result.question && (
              <p className="text-xs text-muted-foreground">
                Searched for: <span className="italic">{result.searched}</span>
              </p>
            )}
            {terms.length > 0 && (
              <p
                className={cn(
                  'text-sm font-medium',
                  found.length === terms.length ? 'text-ok' : 'text-warn',
                )}
              >
                Expected answer: {found.length} of {terms.length} key terms appear in the evidence
                {found.length < terms.length &&
                  ` (missing: ${terms.filter((t) => !found.includes(t)).join(', ')})`}
              </p>
            )}
            {result.passages.length > 0 ? (
              <ul className="space-y-2" aria-label="Passages found">
                {result.passages.map((p, i) => (
                  <Passage key={`${p.source}-${p.page}-${i}`} p={p} terms={terms} />
                ))}
              </ul>
            ) : (
              result.closest && (
                <div>
                  <p className="mb-1 text-xs font-medium">Closest passage (rejected)</p>
                  <ul>
                    <Passage p={result.closest} terms={terms} />
                  </ul>
                </div>
              )
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function KnowledgePage() {
  const { tenant } = useTenant();
  const docs = useAsync(
    () => (tenant ? api.knowledge(tenant.id) : Promise.resolve([])),
    [tenant?.id],
    2000,
  );
  const [pending, setPending] = useState(false);
  const [toDelete, setToDelete] = useState<KnowledgeDoc>();
  const [actionError, setActionError] = useState<string>();
  const chunks = docs.data?.reduce((n, d) => n + d.chunks, 0) ?? 0;

  async function act(fn: () => Promise<unknown>) {
    setPending(true);
    setActionError(undefined);
    try {
      await fn();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'That did not work');
    } finally {
      setPending(false);
      docs.reload();
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={`Knowledge · ${tenant?.displayName ?? ''}`}
        title="Knowledge base"
        description="Upload the policies Ava should use. Every policy answer can point back to a document and page, and uncertain answers are handed to a person."
        actions={
          docs.data && (
            <Badge tone="accent">
              {docs.data.length} documents · {chunks} sections
            </Badge>
          )
        }
      />

      {tenant && <Uploader clientId={tenant.id} onDone={docs.reload} />}

      {actionError && (
        <p role="alert" className="text-sm text-danger">
          {actionError}
        </p>
      )}

      {docs.error ? (
        <ErrorState message={docs.error} onRetry={docs.reload} />
      ) : docs.loading ? (
        <div
          role="status"
          aria-label="Loading knowledge"
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3"
        >
          <Skeleton className="h-36" />
          <Skeleton className="h-36" />
          <Skeleton className="h-36" />
        </div>
      ) : !docs.data || docs.data.length === 0 ? (
        <EmptyState
          title="No documents indexed"
          hint="Upload a PDF above, or add policy files to the company's knowledge folder."
        />
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {docs.data.map((d) => (
            <li key={d.id ?? d.source}>
              <DocumentCard
                doc={d}
                busy={pending}
                onAction={(fn) => void act(fn)}
                onDelete={setToDelete}
              />
            </li>
          ))}
        </ul>
      )}

      {tenant && <TestQuestion clientId={tenant.id} />}

      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <BookOpen className="h-3.5 w-3.5" aria-hidden="true" />
        To see which passages a live answer used, check the Knowledge card in the Agent Console, or
        “Sources for the last answer” in the Voice Lab.
      </p>

      <Dialog
        open={Boolean(toDelete)}
        title="Delete this document?"
        description={
          toDelete
            ? `“${toDelete.source}” and all of its versions will be removed, and the agent will stop using them.`
            : undefined
        }
        onClose={() => setToDelete(undefined)}
      >
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setToDelete(undefined)}>
            Keep it
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              const d = toDelete;
              setToDelete(undefined);
              if (d && tenant) void act(() => api.deleteKnowledge(tenant.id, d.id!));
            }}
          >
            Delete
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
