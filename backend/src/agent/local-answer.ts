import type { Citation } from '@adk/shared';

// A fine-tuned local model may phrase the final answer to a policy question, but only inside limits
// the engine checks itself. Anything outside them and the hosted model answers as it always did.

const NUMBER = /\b\d+(?:[.,]\d+)?\b/g;
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** Returns the text to speak/show, or undefined when the answer must not be used. */
export function acceptLocalAnswer(
  text: string,
  channel: 'voice' | 'chat',
  citations: readonly Citation[],
): string | undefined {
  const t = text.trim();
  if (!t) return undefined;
  if (words(t) > (channel === 'voice' ? 60 : 180)) return undefined;
  // No markup in a spoken answer, no source tags (the screen shows them), no links, no contact details.
  if (channel === 'voice' && /(^|\n)\s*(?:[-*•]|\d+[.)])\s|\*\*|\[Source|https?:\/\//i.test(t)) return undefined;
  if (/https?:\/\/|@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\b[A-Z]{2}\d{4,6}\b/.test(t)) return undefined;
  // It may not promise or perform anything: no booking, refund or change is claimed by a text-only model.
  if (/\b(?:i(?:'|’)ve|i have|i will|i(?:'|’)ll)\s+(?:booked|rebooked|changed|cancell?ed|refunded|processed|confirmed|moved)\b/i.test(t)) return undefined;
  if (/\b(?:skip|bypass|without)\b[^.]{0,30}\b(?:verif\w+|confirm\w*|approval)\b/i.test(t)) return undefined;
  // Every number it states must come from the excerpts it was given: nothing invented.
  const evidence = citations.map((c) => `${c.heading} ${c.snippet}`).join(' ');
  const allowed = new Set(evidence.match(NUMBER) ?? []);
  for (const n of t.match(NUMBER) ?? []) if (!allowed.has(n)) return undefined;
  return t;
}
