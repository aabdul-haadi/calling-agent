// Finds what went wrong (or right) in a turn from facts the system already has. Nothing here guesses
// that a conversation was resolved: that comes from the booking state, the verified tool result or a
// human marking it resolved, never from length, tone or a polite goodbye.

export type Flag =
  | 'robotic_opener'
  | 'repeated_reply'
  | 'customer_repeated'
  | 'too_long'
  | 'unanswered'
  | 'handoff_needs_review'
  | 'low_confidence_speech'
  | 'tool_failed'
  | 'formatting_in_voice'
  | 'lost_context'
  | 'customer_corrected';

export const FLAG_TEXT: Record<Flag, string> = {
  robotic_opener: 'Starts with a stock phrase',
  repeated_reply: 'Said almost the same thing as its previous reply',
  customer_repeated: 'The customer had to repeat themselves',
  too_long: 'Longer than a spoken or typed answer needs to be',
  unanswered: 'A policy question the documents could not answer',
  handoff_needs_review: 'Handed to a person for a reason that may have been avoidable',
  low_confidence_speech: 'Speech recognition was unsure of the words',
  tool_failed: 'A company system call failed',
  formatting_in_voice: 'List or formatting characters in a spoken reply',
  lost_context: 'The customer said they had already given this',
  customer_corrected: 'The customer corrected an earlier detail',
};

const ROBOTIC_OPENERS = [
  /^i understand,? and i want to make sure/i,
  /^certainly[,!. ]/i,
  /^of course[,!. ]/i,
  /^absolutely[,!. ]/i,
  /^great question/i,
  /^i(?:'|’)m happy to help/i,
  /^i apologi[sz]e for (?:any|the) (?:inconvenience|confusion)/i,
  /^thank you for (?:contacting|reaching out|calling)/i,
  /^as an ai/i,
  /^let me check (?:our|the) policy/i,
];
const ALREADY_SAID = /\b(?:i (?:already|just) (?:told|said|gave)|i said|as i said|like i said|third time|again\?)\b/i;
const CUSTOMER_CORRECTION =
  /\b(?:correction\b|i meant\b|i mean\b|actually,?\s+(?:the|i|it|that|my)\b|i gave you the wrong\b|the correct (?:date|time|name|number|flight|booking)\b)/i;

const words = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);

/** Word-overlap similarity, 0..1. */
export function similarity(a: string, b: string): number {
  const x = new Set(words(a));
  const y = new Set(words(b));
  if (x.size === 0 || y.size === 0) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

export const wordCount = (s: string): number => words(s).length;

export interface TurnFacts {
  channel: 'voice' | 'chat';
  customerText: string;
  aiReply: string;
  previousAiReply?: string;
  previousCustomerText?: string;
  asksPolicy: boolean;
  abstained: boolean;
  handoffReason?: string;
  lowConfidence: boolean;
  toolStatuses: string[];
}

const AVOIDABLE_HANDOFF = new Set(['frustration', 'failed_turns', 'always_escalate_intent']);

export function flagsFor(f: TurnFacts): Flag[] {
  const flags: Flag[] = [];
  if (ROBOTIC_OPENERS.some((re) => re.test(f.aiReply.trim()))) flags.push('robotic_opener');
  if (f.previousAiReply && f.aiReply && similarity(f.previousAiReply, f.aiReply) >= 0.8)
    flags.push('repeated_reply');
  if (f.previousCustomerText && similarity(f.previousCustomerText, f.customerText) >= 0.75)
    flags.push('customer_repeated');
  if (ALREADY_SAID.test(f.customerText)) flags.push('lost_context');
  if (CUSTOMER_CORRECTION.test(f.customerText)) flags.push('customer_corrected');
  const limit = f.channel === 'voice' ? 60 : 180;
  if (wordCount(f.aiReply) > limit) flags.push('too_long');
  if (f.asksPolicy && f.abstained) flags.push('unanswered');
  if (f.handoffReason && AVOIDABLE_HANDOFF.has(f.handoffReason)) flags.push('handoff_needs_review');
  if (f.lowConfidence) flags.push('low_confidence_speech');
  if (f.toolStatuses.includes('error')) flags.push('tool_failed');
  if (f.channel === 'voice' && /(^|\n)\s*(?:[-*•]|\d+[.)])\s|\*\*|\[Source:/.test(f.aiReply))
    flags.push('formatting_in_voice');
  return flags;
}

export type Resolution = 'unknown' | 'resolved' | 'handed_off' | 'human_resolved' | 'unresolved';

/**
 * What the conversation's recorded facts prove. "COMPLETED" is only reached after a change was made
 * and its result verified (engine rule), so it is the only state that counts as resolved by the agent.
 */
export function resolutionFor(phase: string, handoff?: 'pending' | 'accepted' | 'resolved'): Resolution {
  if (handoff === 'resolved') return 'human_resolved';
  if (handoff) return 'handed_off';
  if (phase === 'COMPLETED') return 'resolved';
  if (phase === 'FAILED') return 'unresolved';
  return 'unknown';
}
