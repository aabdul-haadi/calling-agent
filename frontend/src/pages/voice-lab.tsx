import { Mic, MicOff, PhoneOff, Square, Wrench } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { ClientDetail } from '@adk/shared';
import { AgentOrb } from '@/agent3d/agent-orb';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/state-views';
import { VOICE_STATUS_TEXT, Waveform, voiceStatus } from '@/components/voice/voice-controls';
import { useTenant } from '@/context/tenant';
import { useAgentSignals, lastTurnTools } from '@/hooks/use-agent-signals';
import { useAsync } from '@/hooks/use-async';
import { useChat } from '@/hooks/use-chat';
import { useVoice } from '@/hooks/use-voice';
import { cn } from '@/lib/utils';
import { api } from '@/services/api';

function Lab({ client }: { client: ClientDetail }) {
  const chat = useChat(client.id);
  const voiceRef = useRef<ReturnType<typeof useVoice> | undefined>(undefined);
  const voice = useVoice({
    onUtterance: async (text, endedAt) => {
      const reply = await chat.send(text, 'voice');
      if (reply) voiceRef.current?.speak(reply, (at) => void chat.addVoiceLatency(at - endedAt));
    },
  });
  useEffect(() => {
    voiceRef.current = voice;
  });

  const signals = useAgentSignals({
    sending: chat.sending,
    error: chat.error ?? voice.error,
    state: chat.state,
    handedOff: Boolean(chat.handoff) || Boolean(chat.state?.handedOff),
    trace: chat.trace,
    voiceActive: voice.active && !voice.muted,
    voiceSpeaking: voice.speaking,
  });
  const status = voiceStatus({
    supported: voice.supported,
    active: voice.active,
    speaking: voice.speaking,
    muted: voice.muted,
    interrupted: voice.interrupted,
    error: voice.error,
  });
  const lastTools = lastTurnTools(chat.trace);
  const awaiting = chat.state?.pendingApproval;

  return (
    <div data-accent={client.accent} className="space-y-5">
      <PageHeader
        eyebrow={`Voice Lab · ${client.displayName}`}
        title="Talk to the agent"
        description="Browser-based voice using your microphone and the browser's speech recognition and synthesis. You can interrupt the agent by speaking. This is not a phone line."
        actions={chat.handoff && <Badge tone="warn">Handed to a human</Badge>}
      />

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <Card className="overflow-hidden">
          <div className="flex flex-col items-center gap-4 p-4 sm:p-6">
            <AgentOrb
              mode={signals.mode}
              level={voice.muted ? 0 : voice.level}
              accent={client.accent}
              agentName={client.persona.name}
              toolLabel={signals.activeTool}
              className="max-w-[22rem]"
            />
            <div className="w-full max-w-md">
              <Waveform
                level={voice.muted ? 0 : voice.level}
                active={voice.active && !voice.muted}
                speaking={voice.speaking}
                tall
              />
            </div>
            <p
              role="status"
              aria-live="polite"
              className={cn(
                'min-h-[2.5rem] max-w-md text-center text-sm',
                voice.caption ? 'italic' : 'text-muted-foreground',
              )}
            >
              {voice.caption ? `“${voice.caption}”` : VOICE_STATUS_TEXT[status]}
            </p>

            {!voice.supported ? (
              <p className="rounded-md border border-border bg-elevated px-4 py-3 text-center text-sm text-muted-foreground">
                This browser has no speech recognition. Open the Voice Lab in Chrome or Edge, or use
                the Agent Console to chat by text.
              </p>
            ) : (
              <div className="flex flex-wrap items-center justify-center gap-2">
                {!voice.active ? (
                  <Button size="lg" onClick={voice.start} aria-label="Start voice session">
                    <Mic className="h-5 w-5" aria-hidden="true" /> Start talking
                  </Button>
                ) : (
                  <>
                    <Button
                      variant="outline"
                      onClick={() => voice.setMuted(!voice.muted)}
                      aria-pressed={voice.muted}
                    >
                      {voice.muted ? (
                        <MicOff className="h-4 w-4" aria-hidden="true" />
                      ) : (
                        <Mic className="h-4 w-4" aria-hidden="true" />
                      )}
                      {voice.muted ? 'Unmute' : 'Mute'}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={voice.cancelSpeech}
                      disabled={!voice.speaking}
                    >
                      <Square className="h-4 w-4" aria-hidden="true" /> Stop speaking
                    </Button>
                    <Button
                      variant="danger"
                      onClick={voice.stop}
                      aria-label="Disconnect voice session"
                    >
                      <PhoneOff className="h-4 w-4" aria-hidden="true" /> Disconnect
                    </Button>
                  </>
                )}
              </div>
            )}
            {voice.error && (
              <p
                role="alert"
                className="max-w-md rounded-md bg-danger/10 px-3 py-2 text-center text-sm text-danger"
              >
                {voice.error}
              </p>
            )}
            {awaiting && (
              <p className="max-w-md rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-center text-sm">
                Waiting for your approval: {awaiting.summary}. Say “yes” to confirm or “no” to
                decline.
              </p>
            )}
          </div>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Tool activity</CardTitle>
            </CardHeader>
            <CardContent>
              {signals.activeTool ? (
                <p className="flex items-center gap-2 text-sm font-medium" role="status">
                  <Wrench className="h-4 w-4 text-accent" aria-hidden="true" />
                  <span className="font-mono">{signals.activeTool}</span>
                </p>
              ) : lastTools.length > 0 ? (
                <ul className="flex flex-wrap gap-1.5" aria-label="Tools used in the last turn">
                  {lastTools.map((t, i) => (
                    <li key={`${t}-${i}`}>
                      <Badge className="font-mono">{t}</Badge>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No tools used yet.</p>
              )}
              <p className="mt-3 text-xs text-muted-foreground">
                The backend answers in one piece, so tool activity appears right after each reply.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Transcript</CardTitle>
              <Badge tone="neutral">{chat.messages.length} messages</Badge>
            </CardHeader>
            <CardContent>
              {chat.messages.length === 0 && !voice.caption ? (
                <p className="text-sm text-muted-foreground">
                  Your words and the agent's replies appear here as you talk.
                </p>
              ) : (
                <ol
                  aria-label="Voice transcript"
                  aria-live="polite"
                  className="max-h-80 space-y-2 overflow-y-auto text-sm"
                >
                  {chat.messages.map((m) => (
                    <li
                      key={m.id}
                      className={cn(
                        'rounded-md px-3 py-2',
                        m.role === 'user' ? 'bg-accent/10' : 'border border-border bg-elevated',
                      )}
                    >
                      <span className="font-medium">
                        {m.role === 'user' ? 'You' : client.persona.name}:{' '}
                      </span>
                      {m.content}
                    </li>
                  ))}
                  {voice.caption && (
                    <li className="rounded-md border border-dashed border-border px-3 py-2 italic text-muted-foreground">
                      {voice.caption}
                    </li>
                  )}
                </ol>
              )}
            </CardContent>
          </Card>

          <p className="text-xs text-muted-foreground">
            Speech recognition is done by your browser and, in Chrome, by Google's speech service.
            The agent's voice is your browser's built-in synthesis, so its audio cannot be analysed:
            the speaking animation is a pattern, while the listening waveform follows your real
            microphone level.
          </p>
        </div>
      </div>
    </div>
  );
}

export function VoiceLabPage() {
  const { tenant, loading, error, reload } = useTenant();
  const hasVoice = tenant?.channels.includes('voice');
  const client = useAsync(
    () => (tenant && hasVoice ? api.client(tenant.id) : Promise.resolve(undefined)),
    [tenant?.id, hasVoice],
  );

  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading || client.loading)
    return (
      <div role="status" aria-label="Loading voice lab">
        <Skeleton className="h-96" />
      </div>
    );
  if (tenant && !hasVoice)
    return (
      <div className="space-y-5">
        <PageHeader eyebrow="Voice Lab" title="Talk to the agent" />
        <EmptyState
          title={`${tenant.displayName} is chat only`}
          hint="Voice is configured per tenant. Switch to a tenant with the voice channel (for example SkyLink Air) in the top bar."
        />
      </div>
    );
  if (client.error || !client.data)
    return <ErrorState message={client.error ?? 'No tenant selected'} onRetry={client.reload} />;
  return <Lab key={client.data.id} client={client.data} />;
}
