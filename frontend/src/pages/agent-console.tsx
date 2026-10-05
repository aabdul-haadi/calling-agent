import { ArrowLeft } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ChatPanel } from '@/components/chat/chat-panel';
import { DemoControls } from '@/components/demo/demo-controls';
import { LiveTrace } from '@/components/trace/live-trace';
import { KnowledgeCard, StateCard } from '@/components/trace/state-cards';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/state-views';
import { VoiceControls } from '@/components/voice/voice-controls';
import { useAsync } from '@/hooks/use-async';
import { useChat } from '@/hooks/use-chat';
import { useVoice } from '@/hooks/use-voice';
import { cn } from '@/lib/utils';
import { api } from '@/services/api';
import type { ClientDetail } from '@adk/shared';

const TABS = [
  { id: 'chat', label: 'Chat' },
  { id: 'trace', label: 'What the agent did' },
  { id: 'state', label: 'State' },
] as const;

function Console({ client }: { client: ClientDetail }) {
  const chat = useChat(client.id);
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('chat');
  const voiceRef = useRef<ReturnType<typeof useVoice> | undefined>(undefined);
  const hasVoice = client.channels.includes('voice');

  const voice = useVoice({
    onUtterance: async (text, endedAt) => {
      const reply = await chat.send(text, 'voice');
      if (reply) voiceRef.current?.speak(reply, (at) => void chat.addVoiceLatency(at - endedAt));
    },
  });
  useEffect(() => {
    voiceRef.current = voice;
  });
  const lastReply = [...chat.messages].reverse().find((m) => m.role === 'assistant')?.content;

  return (
    <div data-accent={client.accent} className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link to="/" aria-label="Back to all agents" className="rounded-xl p-2 hover:bg-muted">
            <ArrowLeft className="h-5 w-5" aria-hidden="true" />
          </Link>
          <span aria-hidden="true" className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent font-bold text-accent-foreground">
            {client.initials}
          </span>
          <div>
            <h1 className="text-xl font-semibold leading-tight">{client.displayName}</h1>
            <p className="text-xs text-muted-foreground">
              Agent: {client.persona.name} Â· {client.persona.tone}
            </p>
          </div>
          {chat.handoff && <Badge tone="warn">Handed to a human</Badge>}
        </div>
        <DemoControls value={chat.simulator} onChange={chat.updateSimulator} onReset={chat.reset} />
      </div>

      <div role="tablist" aria-label="Console sections" className="flex gap-1 rounded-xl bg-muted p-1 lg:hidden">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            id={`tab-${t.id}`}
            onClick={() => setTab(t.id)}
            className={cn('flex-1 rounded-lg px-2 py-1.5 text-sm font-medium', tab === t.id ? 'bg-card shadow-soft' : 'text-muted-foreground')}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,0.9fr)]">
        <div id="panel-chat" role="tabpanel" aria-labelledby="tab-chat" className={cn('space-y-3', tab !== 'chat' && 'hidden lg:block')}>
          {hasVoice && (
            <VoiceControls
              supported={voice.supported}
              active={voice.active}
              speaking={voice.speaking}
              caption={voice.caption}
              agentCaption={lastReply}
              level={voice.level}
              error={voice.error}
              onToggle={voice.active ? voice.stop : voice.start}
            />
          )}
          <ChatPanel
            agentName={client.persona.name}
            messages={chat.messages}
            sending={chat.sending}
            error={chat.error}
            starterPrompts={client.starterPrompts}
            onSend={(t) => void chat.send(t)}
          />
        </div>
        <div id="panel-trace" role="tabpanel" aria-labelledby="tab-trace" className={cn(tab !== 'trace' && 'hidden lg:block')}>
          <LiveTrace trace={chat.trace} />
        </div>
        <div id="panel-state" role="tabpanel" aria-labelledby="tab-state" className={cn('space-y-4', tab !== 'state' && 'hidden lg:block')}>
          <StateCard state={chat.state} client={client} />
          <KnowledgeCard citations={chat.citations} />
        </div>
      </div>
    </div>
  );
}

export function AgentConsolePage() {
  const { clientId = '' } = useParams();
  const client = useAsync(() => api.client(clientId), [clientId]);

  if (client.loading)
    return (
      <div role="status" aria-label="Loading agent" className="grid gap-4 lg:grid-cols-3">
        <Skeleton className="h-[32rem]" />
        <Skeleton className="h-[32rem]" />
        <Skeleton className="h-[32rem]" />
      </div>
    );
  if (client.error || !client.data) return <ErrorState message={client.error ?? 'Client not found'} onRetry={client.reload} />;
  return <Console key={clientId} client={client.data} />;
}

