import { useId } from 'react';
import { cn } from '@/lib/utils';

/**
 * Line illustrations of each tenant's world, drawn in SVG so they stay sharp, follow the
 * theme and accent, and carry real vocabulary (airport codes, cells) rather than stock art.
 */

interface Point {
  code: string;
  x: number;
  y: number;
  /** Label placement relative to the dot. */
  side?: 'above' | 'below';
}

// A simplified northern-hemisphere projection: North America on the left, Europe and the Gulf on the right.
const AIRPORTS: Point[] = [
  { code: 'SEA', x: 62, y: 70 },
  { code: 'SFO', x: 48, y: 118, side: 'below' },
  { code: 'DEN', x: 128, y: 112, side: 'below' },
  { code: 'ORD', x: 196, y: 92 },
  { code: 'ATL', x: 212, y: 146, side: 'below' },
  { code: 'JFK', x: 262, y: 104, side: 'below' },
  { code: 'LHR', x: 404, y: 66 },
  { code: 'CDG', x: 418, y: 92, side: 'below' },
  { code: 'FRA', x: 446, y: 74 },
  { code: 'DXB', x: 528, y: 150, side: 'below' },
];
const HUB = 'ORD';
const ROUTES: [string, string][] = [
  ['ORD', 'SEA'],
  ['ORD', 'SFO'],
  ['ORD', 'DEN'],
  ['ORD', 'ATL'],
  ['ORD', 'JFK'],
  ['ORD', 'LHR'],
  ['ORD', 'FRA'],
  ['JFK', 'CDG'],
  ['JFK', 'LHR'],
  ['FRA', 'DXB'],
  ['SFO', 'DEN'],
];

const at = (code: string) => AIRPORTS.find((a) => a.code === code)!;

/** Great-circle-ish arc: a quadratic curve bowed towards the pole (up). */
function arc(a: Point, b: Point) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  return `M${a.x},${a.y} Q${mx},${my - d * 0.22} ${b.x},${b.y}`;
}

function Graticule() {
  return (
    <g stroke="hsl(var(--border))" strokeWidth="1" fill="none">
      {[40, 80, 120, 160, 200].map((y) => (
        <path key={y} d={`M-20,${y + 18} Q290,${y - 26} 600,${y + 18}`} />
      ))}
      {[40, 120, 200, 280, 360, 440, 520].map((x) => (
        <path key={x} d={`M${x},0 Q${x + (x - 280) * 0.08},110 ${x},230`} />
      ))}
    </g>
  );
}

function RouteMap() {
  return (
    <>
      <Graticule />
      <g fill="none" stroke="hsl(var(--accent))" strokeWidth="1.4" strokeLinecap="round">
        {ROUTES.map(([from, to], i) => {
          const long = (from === 'ORD' && to === 'LHR') || (from === 'JFK' && to === 'CDG');
          return (
            <path
              key={`${from}-${to}`}
              d={arc(at(from), at(to))}
              strokeOpacity={long ? 0.9 : 0.45}
              strokeDasharray={600}
              style={
                {
                  '--len': 600,
                  animation: `adk-draw 1000ms var(--ease-out) ${80 + i * 45}ms both`,
                } as React.CSSProperties
              }
            />
          );
        })}
      </g>
      {/* An aircraft mid-route on the transatlantic leg. */}
      <g transform="translate(300 56) rotate(-7)" fill="hsl(var(--accent))" aria-hidden="true">
        <circle r="11" fill="hsl(var(--card))" />
        <path d="M-9 -1.3H5.5Q9.5 -1.3 10.5 0Q9.5 1.3 5.5 1.3H-9Z" />
        <path d="M2 -1L-3.5 -8.5H-1L5.5 -1Z M2 1L-3.5 8.5H-1L5.5 1Z" />
        <path d="M-7 -1L-9.8 -4.6H-8.3L-5 -1Z M-7 1L-9.8 4.6H-8.3L-5 1Z" />
      </g>
      {AIRPORTS.map((a) => {
        const hub = a.code === HUB;
        return (
          <g key={a.code}>
            {hub && <circle cx={a.x} cy={a.y} r="9" fill="hsl(var(--accent) / 0.12)" />}
            <circle
              cx={a.x}
              cy={a.y}
              r={hub ? 4 : 2.75}
              fill="hsl(var(--card))"
              stroke="hsl(var(--accent))"
              strokeWidth={hub ? 2 : 1.5}
            />
            <text
              x={a.x}
              y={a.side === 'below' ? a.y + 16 : a.y - 9}
              textAnchor="middle"
              className="fill-muted-foreground font-mono"
              fontSize="9.5"
              fontWeight={hub ? 600 : 400}
            >
              {a.code}
            </text>
          </g>
        );
      })}
    </>
  );
}

/** Telecom: coverage cells on a hex grid, towers linked to a core. */
function CoverageMap() {
  const hex = (cx: number, cy: number, r: number) =>
    Array.from({ length: 6 }, (_, i) => {
      const t = (Math.PI / 3) * i + Math.PI / 6;
      return `${(cx + r * Math.cos(t)).toFixed(1)},${(cy + r * Math.sin(t)).toFixed(1)}`;
    }).join(' ');
  const cells: [number, number][] = [];
  for (let row = 0; row < 5; row++)
    for (let col = 0; col < 12; col++) cells.push([col * 48 + (row % 2) * 24 + 10, row * 42 + 20]);
  const towers: [number, number][] = [
    [82, 104],
    [178, 62],
    [226, 146],
    [322, 104],
    [418, 62],
    [466, 146],
  ];
  const core: [number, number] = [322, 104];
  return (
    <>
      <g fill="none" stroke="hsl(var(--border))" strokeWidth="1">
        {cells.map(([x, y]) => (
          <polygon key={`${x}-${y}`} points={hex(x, y, 27)} />
        ))}
      </g>
      <g fill="none" stroke="hsl(var(--accent))" strokeWidth="1.4" strokeLinecap="round">
        {towers
          .filter((t) => t !== core)
          .map(([x, y], i) => (
            <path
              key={`${x}-${y}`}
              d={`M${core[0]},${core[1]} L${x},${y}`}
              strokeOpacity="0.5"
              strokeDasharray={600}
              style={
                {
                  '--len': 600,
                  animation: `adk-draw 1000ms var(--ease-out) ${80 + i * 60}ms both`,
                } as React.CSSProperties
              }
            />
          ))}
      </g>
      {towers.map(([x, y]) => {
        const isCore = x === core[0] && y === core[1];
        return (
          <g key={`t-${x}-${y}`}>
            <circle cx={x} cy={y} r="22" fill="hsl(var(--accent) / 0.07)" />
            <circle
              cx={x}
              cy={y}
              r={isCore ? 5 : 3.5}
              fill="hsl(var(--card))"
              stroke="hsl(var(--accent))"
              strokeWidth="2"
            />
          </g>
        );
      })}
    </>
  );
}

export function NetworkIllustration({
  tenantId,
  className,
}: {
  tenantId?: string;
  className?: string;
}) {
  const fade = useId();
  return (
    <svg
      viewBox="0 0 560 210"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      className={cn('block h-full w-full', className)}
    >
      <defs>
        {/* Fades the left edge into the panel so the text side stays calm. */}
        <linearGradient id={fade} x1="0" x2="1">
          <stop offset="0" stopColor="hsl(var(--card))" stopOpacity="1" />
          <stop offset="0.14" stopColor="hsl(var(--card))" stopOpacity="0" />
        </linearGradient>
      </defs>
      {tenantId === 'skylink-air' ? <RouteMap /> : <CoverageMap />}
      <rect width="560" height="210" fill={`url(#${fade})`} />
    </svg>
  );
}
