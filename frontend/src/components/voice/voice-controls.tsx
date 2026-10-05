import { Mic, MicOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const BARS = 24;

/** Bars follow the real mic level when available; otherwise they gently pulse while listening. */
export function Waveform({ level, active, speaking }: { level: number; active: boolean; speaking: boolean }) {
  return (
    <div aria-hidden="true" className="flex h-10 items-center justify-center gap-0.5">
      {Array.from({ length: BARS }, (_, i) => {
        const wave = 0.35 + 0.65 * Math.abs(Math.sin(i * 0.9 + level * 8));
        const height = speaking ? 0.3 + 0.4 * Math.abs(Math.sin(i)) : active ? Math.max(0.12, level * wave) : 0.1;
        return (
          <span
            key={i}
            className={cn(
              'w-1 rounded-full transition-[height] duration-100',
              speaking ? 'bg-muted-foreground' : 'bg-accent',
              speaking && 'motion-safe:animate-pulse',
            )}
            style={{ height: `${Math.round(height * 100)}%` }}
          />
        );
      })}
    </div>
  );
}

export interface VoiceControlsProps {
  supported: boolean;
  active: boolean;
  speaking: boolean;
  caption: string;
  agentCaption?: string;
  level: number;
  error?: string;
  onToggle: () => void;
}

export function VoiceControls(p: VoiceControlsProps) {
  if (!p.supported) {
    return (
      <p role="status" className="rounded-xl bg-muted px-4 py-3 text-sm text-muted-foreground">
        Voice isn't available in this browser. Try Chrome or Edge, or keep chatting by text.
      </p>
    );
  }
  return (
    <section aria-label="Voice mode" className="flex flex-col items-center gap-3 rounded-2xl bg-accent-soft/60 p-4">
      <Button
        size="lg"
        variant={p.active ? 'danger' : 'primary'}
        onClick={p.onToggle}
        aria-pressed={p.active}
        aria-label={p.active ? 'Stop voice mode' : 'Start voice mode'}
        className="h-16 w-16 rounded-full p-0"
      >
        {p.active ? <MicOff className="h-7 w-7" aria-hidden="true" /> : <Mic className="h-7 w-7" aria-hidden="true" />}
      </Button>
      <Waveform level={p.level} active={p.active} speaking={p.speaking} />
      <p className="text-xs font-medium text-muted-foreground" aria-live="polite">
        {!p.active ? 'Tap the mic and start talking' : p.speaking ? 'Ava is speaking. Talk to interrupt.' : 'Listening…'}
      </p>
      <p aria-live="polite" className="min-h-[2.5rem] max-w-full text-center text-sm">
        {p.caption ? <span className="italic">“{p.caption}”</span> : p.speaking && p.agentCaption ? p.agentCaption : null}
      </p>
      {p.error && (
        <p role="alert" className="text-sm text-danger">
          {p.error}
        </p>
      )}
    </section>
  );
}
