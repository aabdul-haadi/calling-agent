// Masks personal data before it reaches logs, traces or the handoff inbox (rule 7: no PII in logs).

/** "SK1092" -> "SK***92": keep a 2-char prefix and 2-char suffix so humans can still correlate. */
export function maskRef(ref: string): string {
  if (ref.length <= 4) return '*'.repeat(ref.length);
  return `${ref.slice(0, 2)}***${ref.slice(-2)}`;
}

/** "Maria Lopez" -> "M. L." */
export function maskName(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => `${p[0]?.toUpperCase() ?? ''}.`)
    .join(' ');
}

export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length <= 2 ? '***' : `***${digits.slice(-2)}`;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/g;

/** Free-text scrub for strings we cannot classify by key (user messages, error text). */
export function maskText(text: string): string {
  return text
    .replace(EMAIL_RE, (m) => maskEmail(m))
    .replace(PHONE_RE, (m) => maskPhone(m));
}

const REF_KEYS = /^(bookingref|ref|accountid|accountnumber|customerid|passengerid)$/i;
const NAME_KEYS = /^(name|firstname|lastname|fullname|customername)$/i;
const EMAIL_KEYS = /^email$/i;
const PHONE_KEYS = /^(phone|mobile|phonenumber)$/i;

/** Deep-masks an arbitrary value by key name. Safe to call on anything JSON-like. */
export function maskPII(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated]';
  if (typeof value === 'string') return maskText(value);
  if (Array.isArray(value)) return value.map((v) => maskPII(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'string' && REF_KEYS.test(k)) out[k] = maskRef(v);
      else if (typeof v === 'string' && NAME_KEYS.test(k)) out[k] = maskName(v);
      else if (typeof v === 'string' && EMAIL_KEYS.test(k)) out[k] = maskEmail(v);
      else if (typeof v === 'string' && PHONE_KEYS.test(k)) out[k] = maskPhone(v);
      else out[k] = maskPII(v, depth + 1);
    }
    return out;
  }
  return value;
}
