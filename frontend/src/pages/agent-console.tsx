import { ArrowRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import type { ClientDetail } from '@adk/shared';
import { AgentStage } from '@/components/agent/agent-stage';
import { ChatPanel } from '@/components/chat/chat-panel';
import { DemoControls } from '@/components/demo/demo-controls';
import { KnowledgeCard, StateCard } from '@/components/trace/state-cards';
import { groupTurns } from '@/components/trace/trace-model';
import { TraceTimeline } from '@/components/trace/trace-timeline';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { JsonView } from '@/components/ui/json-view';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/state-views';
import { Tabs } from '@/components/ui/tabs';
import { VoiceControls } from '@/components/voice/voice-controls';
import { useTenant } from '@/context/tenant';
import { useAgentSignals } from '@/hooks/use-agent-signals';
import { useAsync } from '@/hooks/use-async';
import { useChat } from '@/hooks/use-chat';
import { useVoice } from '@/hooks/use-voice';
import { api } from '@/services/api';
import { formatTime } from '@/lib/utils';

function AuditTab({ conversationId, refreshKey }: { conversationId?: string; refreshKey: number }) {
  const audit = useAsync(
    () => (conversationId ? api.audit(conversationId) : Promise.resolve([])),
    [conversationId, refreshKey],
  );
  if (!conversationId)
    return (
      <p className="text-sm text-muted-foreground">Start a conversation to see its audit log.</p>
    );
  if (audit.error) return <ErrorState message={audit.error} onRetry={audit.reload} />;
  if (audit.loading) return <Skeleton className="h-24" />;
  if (!audit.data || audit.data.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        Nothing audited yet. Proposals, approvals and changes are recorded here.
      </p>
    );
  return (
    <ol aria-label="Audit log" className="space-y-2">
      {audit.data.map((a) => (
        <li key={a.id} className="rounded-md border border-border bg-background/50 p-2.5">
          <div className="mb-1 flex items-center justify-between gap-2 text-xs">
            <Badge
              tone={
                a.type.includes('failed') ? 'danger' : a.type.includes('executed') ? 'ok' : 'accent'
              }
            >
              {a.type.replace(/_/g, ' ')}
            </Badge>
            <time dateTime={a.at} className="tabular-nums text-muted-foreground">
              {formatTime(a.at)}
            </time>
          </div>
          <JsonView value={a.data} maxHeight="max-h-32" label={`Audit details: ${a.type}`} />
        </li>
      ))}
    </ol>
  );
}

function Console({ client }: { client: ClientDetail }) {
  const chat = useChat(client.id);
  const [tab, setTab] = useState('trace');
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

  const signals = useAgentSignals({
    sending: chat.sending,
    error: chat.error,
    state: chat.state,
    handedOff: Boolean(chat.handoff) || Boolean(chat.state?.handedOff),
    trace: chat.trace,
    voiceActive: voice.active,
    voiceSpeaking: voice.speaking,
  });

  const turns = groupTurns(chat.trace);

  return (
    <div data-accent={client.accent} className="space-y-4">
      <PageHeader
        eyebrow={`Agent Console · ${client.displayName}`}
        title="Talk to the agent, watch it work"
        actions={
          <>
            {chat.handoff && <Badge tone="warn">Handed to a human</Badge>}
            <DemoControls
              value={chat.simulator}
              onChange={chat.updateSimulator}
              onReset={chat.reset}
            />
            <Link
              to={`/tenants/${client.id}`}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium hover:bg-elevated"
            >
              Configuration <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          </>
        }
      />

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[17.5rem_minmax(0,1fr)] xl:grid-cols-[17.5rem_minmax(0,1fr)_26rem]">
        <AgentStage
          name={client.persona.name}
          tone={client.persona.tone}
          accent={client.accent}
          mode={signals.mode}
          level={voice.level}
          toolLabel={signals.activeTool}
          replaying={signals.replaying}
          state={chat.state}
          className="lg:sticky lg:top-20"
        />

        <div className="min-w-0 space-y-3 lg:col-start-2">
          {hasVoice && (
            <VoiceControls
              supported={voice.supported}
              active={voice.active}
              speaking={voice.speaking}
              caption={voice.caption}
              agentCaption={lastReply}
              level={voice.level}
              error={voice.error}
              muted={voice.muted}
              interrupted={voice.interrupted}
              onToggle={voice.active ? voice.stop : voice.start}
            />
          )}
          <ChatPanel
            agentName={client.persona.name}
            messages={chat.messages}
            sending={chat.sending}
            error={chat.error}
            starterPrompts={client.starterPrompts}
            citations={chat.citations}
            pendingApproval={chat.state?.pendingApproval}
            handedOff={Boolean(chat.handoff) || Boolean(chat.state?.handedOff)}
            onSend={(t) => void chat.send(t)}
            className="lg:h-[calc(100vh-17rem)] lg:min-h-[28rem]"
          />
        </div>

        <Card className="min-w-0 p-3 lg:col-span-2 lg:col-start-1 xl:col-span-1 xl:col-start-3 xl:row-start-1 xl:max-h-[calc(100vh-9rem)] xl:overflow-y-auto">
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              {
                id: 'trace',
                label: 'Live trace',
                content:
                  turns.length === 0 ? (
                    <EmptyState
                      title="No steps yet"
                      hint="What the agent does will appear here: understanding, policy lookups, tool calls, approvals."
                    />
                  ) : (
                    <TraceTimeline turns={turns} />
                  ),
              },
              {
                id: 'state',
                label: 'State',
                content: (
                  <div className="space-y-3">
                    <StateCard state={chat.state} client={client} />
                    <KnowledgeCard citations={chat.citations} />
                  </div>
                ),
              },
              {
                id: 'audit',
                label: 'Audit',
                content: (
                  <AuditTab conversationId={chat.conversationId} refreshKey={chat.trace.length} />
                ),
              },
            ]}
          />
        </Card>
      </div>
    </div>
  );
}

export function AgentConsolePage() {
  const { clientId = '' } = useParams();
  const { clients, tenant, select } = useTenant();
  const client = useAsync(() => api.client(clientId), [clientId]);

  // Keep the global tenant selector in step with the URL.
  useEffect(() => {
    if (clientId && tenant?.id !== clientId && clients.some((c) => c.id === clientId))
      select(clientId);
  }, [clientId, clients, tenant, select]);

  if (!clientId && tenant) return <Navigate to={`/agent/${tenant.id}`} replace />;
  if (client.loading)
    return (
      <div
        role="status"
        aria-label="Loading agent"
        className="grid grid-cols-1 gap-4 lg:grid-cols-3"
      >
        <Skeleton className="h-[32rem]" />
        <Skeleton className="h-[32rem] lg:col-span-2" />
      </div>
    );
  if (client.error || !client.data)
    return <ErrorState message={client.error ?? 'Client not found'} onRetry={client.reload} />;
  return <Console key={clientId} client={client.data} />;
}
