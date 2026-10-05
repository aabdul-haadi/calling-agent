import { RotateCcw, SlidersHorizontal, X } from 'lucide-react';
import { useState } from 'react';
import type { SimulatorControls } from '@adk/shared';
import { Button } from '@/components/ui/button';

export interface DemoControlsProps {
  value: SimulatorControls;
  onChange: (next: SimulatorControls) => void;
  onReset: () => void;
}

/** Small drawer: break the company system on purpose to show graceful handling. */
export function DemoControls({ value, onChange, onReset }: DemoControlsProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <Button
        variant="outline"
        size="sm"
        aria-expanded={open}
        aria-controls="demo-drawer"
        onClick={() => setOpen((o) => !o)}
      >
        <SlidersHorizontal className="h-4 w-4" aria-hidden="true" /> Demo controls
      </Button>
      {open && (
        <div
          id="demo-drawer"
          role="region"
          aria-label="Demo controls"
          className="absolute right-0 z-20 mt-2 w-72 space-y-4 rounded-2xl border border-border bg-card p-4 shadow-soft"
        >
          <div className="flex items-center justify-between">
            <p className="font-medium">Demo controls</p>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              aria-label="Close demo controls"
              onClick={() => setOpen(false)}
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>Booking API failing</span>
            <input
              type="checkbox"
              role="switch"
              checked={value.apiFailing}
              onChange={(e) => onChange({ ...value, apiFailing: e.target.checked })}
              className="h-5 w-5 accent-[hsl(var(--accent))]"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 flex justify-between">
              <span>API latency</span>
              <span className="text-muted-foreground">{value.latencyMs} ms</span>
            </span>
            <input
              type="range"
              min={0}
              max={3000}
              step={100}
              value={value.latencyMs}
              onChange={(e) => onChange({ ...value, latencyMs: Number(e.target.value) })}
              className="w-full accent-[hsl(var(--accent))]"
            />
          </label>
          <Button variant="outline" className="w-full" onClick={onReset}>
            <RotateCcw className="h-4 w-4" aria-hidden="true" /> Reset conversation
          </Button>
        </div>
      )}
    </div>
  );
}
