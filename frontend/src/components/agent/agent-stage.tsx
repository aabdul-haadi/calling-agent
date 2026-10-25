import type { ConversationStateView } from '@adk/shared';
import { AgentOrb } from '@/agent3d/agent-orb';
import { describeAgent, MODE_META, type AgentMode } from '@/agent3d/agent-state';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

const PHASE_LABEL: Record<string, string> = {
  NEW: 'New',
  VERIFYING: 'Verifying',
  VERIFIED: 'Verified',
  PLANNING: 'Planning',
  AWAITING_APPROVAL: 'Awaiting approval',
  EXECUTING: 'Executing',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
  HANDOFF: 'With a human',
};

const phaseTone = (phase?: string) =>
  phase === 'COMPLETED'
    ? 'ok'
    : phase === 'FAILED'
      ? 'danger'
      : phase === 'AWAITING_APPROVAL' || phase === 'HANDOFF'
        ? 'warn'
        : 'neutral';

/** The agent's "home" in the console: the orb, what it is doing, and the conversation phase. */
export function AgentStage({
  name,
  tone,
  accent,
  mode,
  level,
  toolLabel,
  replaying,
  state,
  className,
}: {
  name: string;
  tone: string;
  accent: 'sky' | 'violet';
  mode: AgentMode;
  level: number;
  toolLabel?: string;
  replaying: boolean;
  state?: ConversationStateView;
  className?: string;
}) {
  return (
    <Card className={cn('px-4 py-3.5', className)}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <AgentOrb
          mode={mode}
          level={level}
          accent={accent}
          agentName={name}
          toolLabel={toolLabel}
          hideCaption
          className="w-14 shrink-0"
        />
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold leading-tight">{name}</h2>
          <p role="status" className="mt-0.5 flex items-center gap-2 text-sm text-muted-foreground">
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: `hsl(${MODE_META[mode].hsl})` }}
            />
            <span className="truncate">{describeAgent(mode, name, toolLabel)}</span>
          </p>
          <p className="sr-only">Tone: {tone}</p>
        </div>
        <dl className="flex flex-wrap gap-1.5">
          <div>
            <dt className="sr-only">Conversation phase</dt>
            <dd>
              <Badge tone={phaseTone(state?.phase)}>
                {PHASE_LABEL[state?.phase ?? 'NEW'] ?? state?.phase}
              </Badge>
            </dd>
          </div>
          <div>
            <dt className="sr-only">Identity</dt>
            <dd>
              <Badge tone={state?.verified ? 'ok' : 'neutral'}>
                {state?.verified ? 'Identity verified' : 'Not verified'}
              </Badge>
            </dd>
          </div>
        </dl>
      </div>
      {replaying && (
        <p className="mt-3 border-t border-border pt-2.5 text-xs leading-snug text-muted-foreground">
          Replaying the tools this turn used. The backend answers in one piece, so live tool
          activity is shown right after the reply.
        </p>
      )}
    </Card>
  );
}
