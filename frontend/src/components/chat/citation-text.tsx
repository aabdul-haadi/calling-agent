import { BookOpen } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { Citation } from '@adk/shared';
import { cn } from '@/lib/utils';

const CITATION = /[[【]\s*Source:\s*([^\]】]+?)\s*[\]】]/g;

export interface Piece {
  text?: string;
  source?: string;
}

/** Splits a reply into plain text and `[Source: file]` markers. Pure, so it is easy to test. */
export function splitCitations(text: string): Piece[] {
  const out: Piece[] = [];
  let last = 0;
  for (const m of text.matchAll(CITATION)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: text.slice(last, at) });
    out.push({ source: m[1]!.trim() });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** `[Source: handbook.pdf, page 3]` names the document and page; find the matching excerpt. */
export function findCitation(citations: Citation[], label: string): Citation | undefined {
  const [name, rest] = label.split(/\s*,\s*/, 2) as [string, string | undefined];
  const page = rest ? Number(/page\s+(\d+)/i.exec(rest)?.[1]) : NaN;
  const same = citations.filter((c) => c.source === name || c.source === label);
  return (
    same.find(
      (c) =>
        Number.isFinite(page) &&
        c.page !== undefined &&
        c.page <= page &&
        page <= (c.pageEnd ?? c.page),
    ) ?? same[0]
  );
}

function CitationChip({ source, citation }: { source: string; citation?: Citation }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="inline">
      <button
        type="button"
        aria-expanded={citation ? open : undefined}
        disabled={!citation}
        onClick={() => setOpen((o) => !o)}
        title={citation ? `${citation.heading}` : 'Source not in this turn’s excerpts'}
        className={cn(
          'mx-0.5 inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 align-baseline font-mono text-[0.68rem] text-accent',
          citation && 'hover:bg-accent/20',
        )}
      >
        <BookOpen className="h-3 w-3" aria-hidden="true" />
        {source}
      </button>
      {open && citation && (
        <span className="my-1.5 block rounded-md border border-border bg-background/60 p-2.5 text-xs text-muted-foreground">
          <span className="mb-1 block font-medium text-foreground">
            {citation.heading}
            {citation.page
              ? ` · page ${citation.page}${citation.pageEnd ? `–${citation.pageEnd}` : ''}`
              : ''}
          </span>
          {citation.snippet}
        </span>
      )}
    </span>
  );
}

export interface Run {
  text: string;
  bold: boolean;
}

/** Turns **bold** into bold runs. Anything else, including a lone "**", stays literal text. */
export function splitBold(text: string): Run[] {
  const out: Run[] = [];
  let last = 0;
  for (const m of text.matchAll(/\*\*([^*\s][^*\n]*?)\*\*/g)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: text.slice(last, at), bold: false });
    out.push({ text: m[1]!, bold: true });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), bold: false });
  return out;
}

const Inline = ({ text }: { text: string }) =>
  splitBold(text).map((r, i) =>
    r.bold ? <strong key={i}>{r.text}</strong> : <span key={i}>{r.text}</span>,
  );

/** Reply text with `[Source: x]` turned into chips that open the cited excerpt. */
export function CitationText({
  text,
  citations,
}: {
  text: string;
  citations: Citation[];
}): ReactNode {
  return splitCitations(text).map((p, i) =>
    p.source ? (
      <CitationChip key={i} source={p.source} citation={findCitation(citations, p.source)} />
    ) : (
      <Inline key={i} text={p.text ?? ''} />
    ),
  );
}
