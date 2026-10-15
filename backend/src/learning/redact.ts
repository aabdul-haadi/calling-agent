// Redaction for the learning pipeline. Stronger than the log masker (tools/security/pii.ts): that one
// keeps a prefix and suffix so a human can correlate; here nothing identifying may survive, so every
// match becomes a fixed token. A turn that carries a secret is not learned from at all.

export interface Redacted {
  text: string;
  /** What was replaced, by kind. Counts only: never the replaced values. */
  found: Record<string, number>;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL = /\bhttps?:\/\/[^\s)]+/gi;
const CARD = /\b(?:\d[ -]?){13,19}\b/g;
const PHONE = /\+?\(?\d[\d\s().-]{7,}\d/g;
const REF = /\b[A-Z]{2}\s?\d{4,6}\b/g;
const DOB = /\b(?:\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2})\b(?=.*\b(?:born|birth|dob)\b)|(?:born|birth ?date|dob|date of birth)[^.?!]{0,20}?(?:\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2})/gi;
const SPOKEN_NAME =
  /\b(?:my (?:last |first |full |sur)?name is|(?:last|first|sur)name is|name'?s|this is|i am|i'm|it's|it is|call me|speaking with|speaking to)\s+(?:mr\.?|mrs\.?|ms\.?|dr\.?\s+)?([A-Z][a-z'-]{1,24}(?:\s+[A-Z][a-z'-]{1,24})?)/g;
const NAME_AND_NOTHING = /^\s*([A-Z][a-z'-]{2,24}),\s+(?=[A-Z]{2}\s?\d{4,6}\b)/;
// Words after "I am"/"it's" that are not names.
const NOT_A_NAME = new Set([
  'Sorry', 'Glad', 'Happy', 'Looking', 'Calling', 'Trying', 'Not', 'Still', 'Here', 'Fine', 'Good',
  'Ready', 'Sure', 'Just', 'Very', 'Really', 'Afraid', 'Waiting', 'Having', 'Planning', 'Hoping',
  'Okay', 'Ok', 'Yes', 'No', 'Thanks', 'Thank', 'Hello', 'Hi',
]);

/** A turn that mentions one of these is excluded from learning entirely, redacted or not. */
const SECRET =
  /\b(?:password|passcode|pass code|pin(?:\s+(?:code|number))?|cvv|cvc|security code|one[- ]time (?:code|password)|otp|verification code|sign[- ]?in code|secret answer|card number|account number|routing number|iban|swift)\b/i;

export const hasSecret = (text: string): boolean => SECRET.test(text);

const bump = (found: Record<string, number>, kind: string) => {
  found[kind] = (found[kind] ?? 0) + 1;
};

/**
 * Replaces identifying details with tokens. `names` are words known to be personal in this
 * conversation (the passenger's name from a tool result, for example), removed wherever they appear.
 */
export function redact(input: string, names: readonly string[] = []): Redacted {
  const found: Record<string, number> = {};
  let text = input;
  const sub = (re: RegExp, token: string, kind: string) => {
    text = text.replace(re, () => {
      bump(found, kind);
      return token;
    });
  };
  sub(EMAIL, '[EMAIL]', 'email');
  sub(URL, '[URL]', 'url');
  sub(DOB, '[DATE_OF_BIRTH]', 'date_of_birth');
  sub(CARD, '[CARD]', 'card');
  sub(PHONE, '[PHONE]', 'phone');
  sub(REF, '[REF]', 'reference');
  text = text.replace(SPOKEN_NAME, (m, name: string) => {
    if (NOT_A_NAME.has(name.split(/\s+/)[0] ?? '')) return m;
    bump(found, 'name');
    return m.slice(0, m.length - name.length) + '[NAME]';
  });
  text = text.replace(NAME_AND_NOTHING, () => {
    bump(found, 'name');
    return '[NAME], ';
  });
  for (const raw of names) {
    const n = raw.trim();
    if (n.length < 2) continue;
    const re = new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    text = text.replace(re, () => {
      bump(found, 'name');
      return '[NAME]';
    });
  }
  return { text: text.replace(/\s{2,}/g, ' ').trim(), found };
}

/** What identifying patterns are still in a text: used as a gate before anything is exported. */
export function leftovers(text: string): string[] {
  const left: string[] = [];
  if (new RegExp(EMAIL.source).test(text)) left.push('email');
  if (new RegExp(PHONE.source).test(text)) left.push('phone');
  if (new RegExp(CARD.source).test(text)) left.push('card');
  if (new RegExp(REF.source).test(text)) left.push('reference');
  if (SECRET.test(text)) left.push('secret');
  return left;
}

/** Names that appear in a conversation's tool results, so they can be removed from free text. */
export function namesFrom(collected: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, key = '', depth = 0) => {
    if (depth > 4) return;
    if (typeof v === 'string' && /name/i.test(key) && v.length > 1) {
      for (const part of v.split(/\s+/)) if (part.length > 1) out.add(part);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, key, depth + 1));
    else if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) walk(x, k, depth + 1);
  };
  walk(collected);
  return [...out];
}
