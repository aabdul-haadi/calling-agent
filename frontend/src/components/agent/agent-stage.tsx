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
    <Card className={cn('overflow-hidden', className)}>
      <div className="flex items-center gap-4 p-3 lg:flex-col lg:items-stretch lg:gap-0 lg:p-0">
        <div className="w-28 shrink-0 lg:w-full lg:px-4 lg:pt-4">
          <AgentOrb
            mode={mode}
            level={level}
            accent={accent}
            agentName={name}
            toolLabel={toolLabel}
            hideCaption
            className="lg:mx-auto lg:max-w-[17rem]"
          />
        </div>
        <div className="min-w-0 flex-1 space-y-2 lg:p-4 lg:pt-1">
          <div>
            <p className="eyebrow">Agent</p>
            <h2 className="text-lg font-semibold leading-tight">{name}</h2>
            <p className="truncate text-xs text-muted-foreground">{tone}</p>
          </div>
          <p role="status" className="flex items-center gap-2 text-sm font-medium">
            <span
              aria-hidden="true"
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: `hsl(${MODE_META[mode].hsl})` }}
            />
            {describeAgent(mode, name, toolLabel)}
          </p>
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
          {replaying && (
            <p className="text-[0.7rem] leading-snug text-muted-foreground">
              Replaying the tools this turn used. The backend answers in one piece, so live tool
              activity is shown right after the reply.
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}
