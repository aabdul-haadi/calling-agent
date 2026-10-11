import { Mic, MicOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const BARS = 28;

/**
 * Bars follow the real microphone level while listening. While the agent speaks the browser does
 * not expose its audio, so the bars show a gentle local pattern instead of pretending to be a
 * measurement.
 */
export function Waveform({
  level,
  active,
  speaking,
  tall = false,
}: {
  level: number;
  active: boolean;
  speaking: boolean;
  tall?: boolean;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn('flex items-center justify-center gap-[3px]', tall ? 'h-16' : 'h-10')}
    >
      {Array.from({ length: BARS }, (_, i) => {
        const envelope = Math.sin((i / (BARS - 1)) * Math.PI);
        const wave = 0.35 + 0.65 * Math.abs(Math.sin(i * 0.9 + level * 8));
        const height = speaking
          ? 0.25 + 0.45 * Math.abs(Math.sin(i * 0.7)) * envelope + 0.1
          : active
            ? Math.max(0.1, level * wave * (0.5 + envelope * 0.5))
            : 0.08;
        return (
          <span
            key={i}
            className={cn(
              'w-[3px] rounded-full transition-[height] duration-100',
              speaking ? 'bg-accent-2' : 'bg-accent',
              speaking && 'motion-safe:animate-pulse',
            )}
            style={{
              height: `${Math.round(height * 100)}%`,
              opacity: active || speaking ? 1 : 0.4,
            }}
          />
        );
      })}
    </div>
  );
}

export type VoiceStatus =
  'unsupported' | 'off' | 'blocked' | 'listening' | 'muted' | 'speaking' | 'interrupted';

export function voiceStatus(p: {
  supported: boolean;
  active: boolean;
  speaking: boolean;
  muted: boolean;
  interrupted: boolean;
  error?: string;
}): VoiceStatus {
  if (!p.supported) return 'unsupported';
  if (p.error && !p.active) return 'blocked';
  if (!p.active) return 'off';
  if (p.interrupted) return 'interrupted';
  if (p.speaking) return 'speaking';
  if (p.muted) return 'muted';
  return 'listening';
}

export const VOICE_STATUS_TEXT: Record<VoiceStatus, string> = {
  unsupported: 'Voice is not available in this browser',
  off: 'Microphone off',
  blocked: 'Microphone blocked',
  listening: 'Listening',
  muted: 'Muted',
  speaking: 'Agent speaking · talk to interrupt',
  interrupted: 'Interrupted',
};

export interface VoiceControlsProps {
  supported: boolean;
  active: boolean;
  speaking: boolean;
  caption: string;
  agentCaption?: string;
  level: number;
  error?: string;
  muted?: boolean;
  interrupted?: boolean;
  agentName?: string;
  onToggle: () => void;
}

/** Compact voice bar for the console. The full experience lives in the Voice Lab. */
export function VoiceControls(p: VoiceControlsProps) {
  if (!p.supported) {
    return (
      <p
        role="status"
        className="rounded-md border border-border bg-elevated px-4 py-3 text-sm text-muted-foreground"
      >
        Voice isn't available in this browser. Try Chrome or Edge, or keep chatting by text.
      </p>
    );
  }
  const status = voiceStatus({
    supported: p.supported,
    active: p.active,
    speaking: p.speaking,
    muted: Boolean(p.muted),
    interrupted: Boolean(p.interrupted),
    error: p.error,
  });
  return (
    <section
      aria-label="Voice mode"
      className="flex items-center gap-3 rounded-lg border border-border bg-card p-3"
    >
      <Button
        size="icon"
        variant={p.active ? 'danger' : 'primary'}
        onClick={p.onToggle}
        aria-pressed={p.active}
        aria-label={p.active ? 'Stop voice mode' : 'Start voice mode'}
        className="h-11 w-11 shrink-0 rounded-full"
      >
        {p.active ? (
          <MicOff className="h-5 w-5" aria-hidden="true" />
        ) : (
          <Mic className="h-5 w-5" aria-hidden="true" />
        )}
      </Button>
      <div className="min-w-0 flex-1">
        <Waveform level={p.level} active={p.active} speaking={p.speaking} />
        <p className="truncate text-xs text-muted-foreground" aria-live="polite">
          {p.caption ? (
            <span className="italic text-foreground">“{p.caption}”</span>
          ) : p.speaking && p.agentCaption ? (
            p.agentCaption
          ) : (
            VOICE_STATUS_TEXT[status]
          )}
        </p>
      </div>
      {p.error && (
        <p role="alert" className="max-w-[12rem] text-xs text-danger">
          {p.error}
        </p>
      )}
    </section>
  );
}
