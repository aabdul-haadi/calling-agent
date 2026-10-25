import { cn } from '@/lib/utils';

/**
 * Hand-drawn brand marks. Pure SVG on a 32-unit grid so they stay crisp at any size,
 * inherit the tenant accent, and need no image files.
 */

/** The product mark: a speech bubble whose tail becomes a forward path. */
export function ProductMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={cn('h-8 w-8 shrink-0', className)}>
      <rect width="32" height="32" rx="8" fill="hsl(216 55% 16%)" />
      <path
        d="M9 11.5A3.5 3.5 0 0 1 12.5 8h7A3.5 3.5 0 0 1 23 11.5v4a3.5 3.5 0 0 1-3.5 3.5H15l-4 3.5V19h0a2 2 0 0 1-2-2z"
        fill="none"
        stroke="#fff"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M13 13.5h6" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="23.5" cy="23.5" r="2.25" fill="hsl(36 92% 58%)" />
    </svg>
  );
}

/** SkyLink Air: a swept tail fin over a horizon line. */
function SkyLinkGlyph() {
  return (
    <>
      <path
        d="M8.5 22.5 20.8 8.6c.9-1 2.6-.4 2.5 1L22.4 22.5z"
        fill="hsl(var(--accent-foreground))"
      />
      <path
        d="M6.5 25.5h19"
        stroke="hsl(var(--accent-foreground))"
        strokeOpacity="0.55"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path d="M14.2 17.4h6.9" stroke="hsl(var(--accent))" strokeWidth="1.6" />
    </>
  );
}

/** NovaTel: a point with two broadcast arcs. */
function NovaTelGlyph() {
  return (
    <>
      <circle cx="11" cy="21" r="2.6" fill="hsl(var(--accent-foreground))" />
      <path
        d="M11 14.5a6.5 6.5 0 0 1 6.5 6.5M11 9a12 12 0 0 1 12 12"
        fill="none"
        stroke="hsl(var(--accent-foreground))"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </>
  );
}

/** A tenant's logo tile. Unknown tenants get their initials in the same tile. */
export function TenantMark({
  id,
  initials,
  className,
}: {
  id?: string;
  initials?: string;
  className?: string;
}) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={cn('h-8 w-8 shrink-0', className)}>
      <rect width="32" height="32" rx="8" fill="hsl(var(--accent))" />
      {id === 'skylink-air' ? (
        <SkyLinkGlyph />
      ) : id === 'novatel' ? (
        <NovaTelGlyph />
      ) : (
        <text
          x="16"
          y="20.5"
          textAnchor="middle"
          fontSize="12"
          fontWeight="600"
          fill="hsl(var(--accent-foreground))"
          fontFamily="IBM Plex Sans, sans-serif"
        >
          {(initials ?? '?').slice(0, 2)}
        </text>
      )}
    </svg>
  );
}
