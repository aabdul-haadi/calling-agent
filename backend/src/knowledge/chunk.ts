export interface Chunk {
  source: string;
  heading: string;
  content: string;
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
