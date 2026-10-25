import { Fragment, type ReactNode } from 'react';

const TOKEN =
  /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

/** Splits pretty-printed JSON into coloured spans. Pure, so it is easy to test. */
export function highlightJson(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const [whole, str, colon, word, num] = m;
    let cls = '';
    if (str && colon) cls = 'text-accent-2';
    else if (str) cls = 'text-ok';
    else if (word) cls = 'text-muted-foreground italic';
    else if (num) cls = 'text-warn';
    out.push(
      <Fragment key={n++}>
        <span className={cls}>{str && colon ? str : whole}</span>
        {str && colon ? <span className="text-muted-foreground">{colon}</span> : null}
      </Fragment>,
    );
    last = at + whole.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Syntax-highlighted, scrollable JSON. Values are expected to be redacted by the server already. */
export function JsonView({
  value,
  maxHeight = 'max-h-64',
  label,
}: {
  value: unknown;
  maxHeight?: string;
  label: string;
}) {
  const text = JSON.stringify(value, null, 2) ?? 'undefined';
  return (
    <pre
      tabIndex={0}
      aria-label={label}
      className={`${maxHeight} overflow-auto rounded-md border border-border bg-elevated p-3 font-mono text-xs leading-relaxed`}
    >
      <code>{highlightJson(text)}</code>
    </pre>
  );
}
