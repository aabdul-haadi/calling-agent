export interface Chunk {
  source: string;
  heading: string;
  content: string;
  /** First and last page of the document the chunk comes from (PDFs only). */
  page?: number;
  pageEnd?: number;
}

const MAX_CHARS = 1200;

/**
 * Splits a markdown policy document by heading, so each chunk is one self-contained rule.
 * The document title is kept in the heading ("Checked baggage > Weight limits") for better citations.
 */
export function chunkMarkdown(source: string, markdown: string): Chunk[] {
  const chunks: Chunk[] = [];
  let title = source;
  let heading = '';
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join('\n').trim();
    buffer = [];
    if (text.length < 20) return;
    const label = heading ? `${title} > ${heading}` : title;
    // Very long sections are split on blank lines so no chunk drowns out the others.
    let current = '';
    for (const para of text.split(/\n{2,}/)) {
      if (current && current.length + para.length > MAX_CHARS) {
        chunks.push({ source, heading: label, content: current.trim() });
        current = '';
      }
      current += `${para}\n\n`;
    }
    if (current.trim()) chunks.push({ source, heading: label, content: current.trim() });
  };

  for (const line of markdown.split(/\r?\n/)) {
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      if (h[1] === '#') {
        title = h[2]!.trim();
        heading = '';
      } else heading = h[2]!.trim();
    } else buffer.push(line);
  }
  flush();
  return chunks;
}

// ---------------------------------------------------------------------------------------------
// PDF pages -> chunks
// ---------------------------------------------------------------------------------------------

export interface PageBlock {
  type: 'heading' | 'paragraph' | 'list' | 'table';
  text: string;
  level?: number;
}

export interface ExtractedPage {
  number: number;
  label?: string | null;
  blocks: PageBlock[];
}

export interface ChunkOptions {
  /** A chunk is closed once it reaches about this many characters. */
  targetChars: number;
  /** No chunk is longer than this (long paragraphs and tables are split). */
  maxChars: number;
  /** How much of the end of a chunk is repeated at the start of the next one. */
  overlapChars: number;
  /** Smaller leftovers are merged into the neighbour instead of standing alone. */
  minChars: number;
  /** A table is cut into groups of rows of about this size (the header row is repeated in each). */
  tableChars: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  targetChars: 1000,
  maxChars: 1500,
  overlapChars: 150,
  minChars: 120,
  tableChars: 600,
};

function sentences(text: string): string[] {
  return (
    text
      .match(/[^.!?]+(?:[.!?]+["')\]]*|$)\s*/g)
      ?.map((x) => x.trim())
      .filter(Boolean) ?? [text]
  );
}

/** The last sentences of `text` that fit in `limit` characters (so a fact is not cut off mid-way). */
function tail(text: string, limit: number): string {
  if (limit <= 0) return '';
  const parts = sentences(text);
  let out = '';
  for (let i = parts.length - 1; i >= 0; i--) {
    const next = out ? `${parts[i]} ${out}` : parts[i]!;
    if (next.length > limit) break;
    out = next;
  }
  return out;
}

/** Splits one over-long piece of text at sentence boundaries into parts of at most `max` characters. */
function splitLong(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let current = '';
  for (const sentence of sentences(text)) {
    if (current && current.length + sentence.length + 1 > max) {
      out.push(current);
      current = '';
    }
    if (sentence.length > max) {
      for (let i = 0; i < sentence.length; i += max) out.push(sentence.slice(i, i + max));
    } else current = current ? `${current} ${sentence}` : sentence;
  }
  if (current) out.push(current);
  return out;
}

/**
 * Turns the pages of a PDF into chunks that follow the document's own structure: a chunk never
 * crosses a heading, tables stay whole (a large table is split by rows with its header repeated),
 * and the page each chunk came from is kept so an answer can cite it.
 */
export function chunkPages(
  source: string,
  title: string,
  pages: ExtractedPage[],
  options: Partial<ChunkOptions> = {},
): Chunk[] {
  const o = { ...DEFAULT_CHUNK_OPTIONS, ...options };
  const chunks: Chunk[] = [];
  const stack: string[] = [];
  let heading = title;
  let buffer = '';
  let startPage = 0;
  let lastPage = 0;
  let carried = '';

  const label = () =>
    [title, ...stack.filter(Boolean)].filter((x, i, a) => a.indexOf(x) === i).join(' > ');
  const push = (content: string, page: number, pageEnd: number) => {
    const text = content.trim();
    if (text.length > 0) chunks.push({ source, heading, content: text, page, pageEnd });
  };
  const flush = (keepOverlap: boolean) => {
    const text = buffer.trim();
    if (text.length >= 20) {
      push(text, startPage, lastPage);
      carried = keepOverlap ? tail(text, o.overlapChars) : '';
    }
    buffer = '';
    startPage = 0;
  };

  for (const page of pages) {
    for (const block of page.blocks) {
      const text = block.text.trim();
      if (!text) continue;

      if (block.type === 'heading') {
        flush(false);
        const level = Math.min(Math.max(block.level ?? 1, 1), 3);
        stack.length = level - 1;
        stack[level - 1] = text;
        heading = label();
        carried = '';
        continue;
      }

      if (block.type === 'table') {
        flush(false);
        const rows = text.split('\n');
        const header = rows[0]!;
        let part: string[] = [];
        let size = 0;
        const emit = () => {
          if (part.length > 0) push(part.join('\n'), page.number, page.number);
          part = [];
          size = 0;
        };
        for (const [i, row] of rows.entries()) {
          if (size + row.length > o.tableChars && part.length > 1) {
            emit();
            if (i > 0) {
              part = [header];
              size = header.length;
            }
          }
          part.push(row);
          size += row.length + 1;
        }
        emit();
        continue;
      }

      for (const piece of splitLong(text, o.maxChars)) {
        if (buffer && buffer.length + piece.length > o.targetChars && buffer.length >= o.minChars) {
          flush(true);
        }
        if (!buffer && carried) buffer = carried;
        if (startPage === 0) startPage = page.number;
        buffer += (buffer ? '\n' : '') + piece;
        lastPage = page.number;
      }
    }
  }
  flush(false);

  // Merge crumbs (a lone line after a table, a stray caption) into the chunk before them.
  const merged: Chunk[] = [];
  for (const c of chunks) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      c.content.length < o.minChars &&
      prev.heading === c.heading &&
      prev.content.length + c.content.length < o.maxChars
    ) {
      prev.content += `\n${c.content}`;
      prev.pageEnd = c.pageEnd;
    } else merged.push({ ...c });
  }
  // Identical chunks (a repeated disclaimer) are kept once.
  const seen = new Set<string>();
  return merged.filter((c) => {
    const key = `${c.heading}|${c.content}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
