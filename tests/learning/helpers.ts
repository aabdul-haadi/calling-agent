import { splitFor, type TurnInput } from '@backend/learning';
import type { Harness } from '../helpers/harness';

let counter = 0;
const uuid = () => {
  counter += 1;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
};

export interface Example {
  id: string;
  conversationId: string;
  text: string;
  reply: string;
  split: 'train' | 'eval';
}

/**
 * Stores and approves `n` reviewed examples that fall on the requested side of the fixed split.
 * They are real rows in the database written through the same capture path as live turns; only the
 * wording is generated, and the reviewer approval goes through the same review function as the console.
 */
export async function approvedExamples(
  h: Harness,
  clientId: string,
  n: number,
  side: 'train' | 'eval',
  opts: { channel?: 'voice' | 'chat'; uses?: ('sft' | 'intent' | 'retrieval_eval' | 'behavior')[]; replyOf?: (i: number) => string } = {},
): Promise<Example[]> {
  const L = h.learning!;
  const out: Example[] = [];
  for (let i = 0; out.length < n; i++) {
    counter += 1;
    const text = `How many bags can I check on ticket variant ${counter * 31 + i} please`;
    if (splitFor(text) !== side) continue;
    const conversationId = uuid();
    const reply = opts.replyOf ? opts.replyOf(out.length) : `Variant ${counter}: one bag is included.`;
    const input: TurnInput = {
      clientId,
      conversationId,
      turnIndex: 0,
      channel: opts.channel ?? 'chat',
      customerText: text,
      aiReply: reply,
      intent: 'baggage_policy',
      sentiment: 'neutral',
      citations: [],
      asksPolicy: true,
      abstained: false,
      toolCalls: [],
      lowConfidence: false,
      phase: 'NEW',
      knownNames: [],
    };
    await L.capture.process(input);
    const row = (await L.store.turnsOfConversation(clientId, conversationId))[0]!;
    await L.review(clientId, row.id, { decision: 'approve', reviewer: 'maria', approvedReply: reply, uses: opts.uses ?? ['sft'] });
    out.push({ id: row.id, conversationId, text, reply, split: side });
  }
  return out;
}

/** A small valid one-page PDF with the given lines of text (enough for the real PDF reader to extract). */
export function makePdf(lines: string[]): Buffer {
  const bs = String.fromCharCode(92);
  const esc = (t: string) => t.split(bs).join(bs + bs).split('(').join(bs + '(').split(')').join(bs + ')');
  const content = ['BT', '/F1 12 Tf', '14 TL', '72 720 Td', ...lines.map((l) => `(${esc(l)}) Tj T*`), 'ET'].join(String.fromCharCode(10));
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>${String.fromCharCode(10)}stream${String.fromCharCode(10)}${content}${String.fromCharCode(10)}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const nl = String.fromCharCode(10);
  let out = `%PDF-1.4${nl}`;
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj${nl}${o}${nl}endobj${nl}`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref${nl}0 ${objects.length + 1}${nl}0000000000 65535 f ${nl}`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n ${nl}`;
  out += `trailer${nl}<< /Size ${objects.length + 1} /Root 1 0 R >>${nl}startxref${nl}${xref}${nl}%%EOF${nl}`;
  return Buffer.from(out, 'latin1');
}
