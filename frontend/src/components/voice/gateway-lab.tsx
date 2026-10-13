import { FileText, Mic, MicOff, PhoneOff, RotateCcw, Square, Wrench } from 'lucide-react';
import type { ClientDetail } from '@adk/shared';
import { AgentOrb } from '@/agent3d/agent-orb';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Waveform } from '@/components/voice/voice-controls';
import { useVoiceGateway } from '@/hooks/use-voice-gateway';
import { cn } from '@/lib/utils';
import { gatewayAgentMode } from '@/voice/agent-mode';
import { STATUS_TEXT, stripSourceTags, toolPhrase } from '@/voice/state';

/** The server's own measurements, in the order a turn goes through them. */
const TIMING_ROWS: [string, string][] = [
  ['firstPartialMs', 'First words recognised'],
  ['speechEndToFinalMs', 'You stop talking → final transcript'],
  ['agentUnderstandMs', 'Understanding the message'],
  ['agentRetrieveMs', 'Searching the policies'],
  ['agentLlmMs', 'Model calls (total)'],
  ['agentToolMs', 'Business tools (total)'],
  ['agentFirstTokenMs', 'Turn start → first word written'],
  ['speechEndToFirstTextMs', 'You stop talking → first word written'],
  ['speechEndToFirstAudioMs', 'You stop talking → first sound'],
];

/** Voice with the local engine: audio goes to the voice gateway, the same agent answers. */
export function GatewayLab({ client }: { client: ClientDetail }) {
  const v = useVoiceGateway(client.id);
  const { state } = v;
  const { mode, tool } = gatewayAgentMode(state);
  const speaking = state.status === 'speaking';
  // The orb and the bars follow what is really being heard: the microphone while listening, the
  // audio actually playing while the agent speaks.
  const level = speaking ? v.levels.out : v.levels.mic;
  const ended =
    state.status === 'idle' || state.status === 'disconnected' || state.status === 'error';

  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
      <Card className="overflow-hidden">
        <div className="flex flex-col items-center gap-4 p-4 sm:p-6">
          <AgentOrb
            mode={mode}
            level={level}
            accent={client.accent}
            agentName={client.persona.name}
            toolLabel={tool}
            className="max-w-[22rem]"
          />
          <div className="w-full max-w-md">
            <Waveform level={level} active={v.connected && !v.muted} speaking={false} tall />
          </div>

          <p
            role="status"
            aria-live="polite"
            className={cn(
              'min-h-[2.5rem] max-w-md text-center text-sm',
              state.partial ? 'italic' : 'text-muted-foreground',
            )}
          >
            {state.partial
              ? `“${state.partial}”`
              : state.status === 'executing_tool'
                ? toolPhrase(state.activeTool)
                : STATUS_TEXT[state.status]}
          </p>

          <div className="flex flex-wrap items-center justify-center gap-2">
            {ended ? (
              <Button
                size="lg"
                onClick={v.start}
                aria-label={
                  state.status === 'idle' ? 'Start voice session' : 'Reconnect voice session'
                }
              >
                {state.status === 'idle' ? (
                  <Mic className="h-5 w-5" aria-hidden="true" />
                ) : (
                  <RotateCcw className="h-5 w-5" aria-hidden="true" />
                )}
                {state.status === 'idle' ? 'Start talking' : 'Reconnect'}
              </Button>
            ) : (
              <>
                <Button variant="outline" onClick={v.toggleMute} aria-pressed={v.muted}>
                  {v.muted ? (
                    <MicOff className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <Mic className="h-4 w-4" aria-hidden="true" />
                  )}
                  {v.muted ? 'Unmute' : 'Mute'}
                </Button>
                <Button
                  variant="outline"
                  onClick={v.interrupt}
                  disabled={
                    !speaking && state.status !== 'thinking' && state.status !== 'executing_tool'
                  }
                >
                  <Square className="h-4 w-4" aria-hidden="true" /> Stop
                </Button>
                <Button variant="danger" onClick={v.stop} aria-label="Disconnect voice session">
                  <PhoneOff className="h-4 w-4" aria-hidden="true" /> Disconnect
                </Button>
              </>
            )}
          </div>

          {state.error && (
            <p
              role="alert"
              className="max-w-md rounded-md bg-danger/10 px-3 py-2 text-center text-sm text-danger"
            >
              {state.error.message}
            </p>
          )}
          {state.notice && (
            <p
              role="status"
              className="max-w-md rounded-md bg-warn/10 px-3 py-2 text-center text-sm"
            >
              {state.notice}
            </p>
          )}
          {state.pendingApproval && (
            <p className="max-w-md rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-center text-sm">
              Waiting for your approval: {state.pendingApproval.summary}. Say “yes” to confirm or
              “no” to decline.
            </p>
          )}
          {state.handedOff && (
            <p className="max-w-md rounded-md border border-accent-2/40 bg-accent-2/10 px-3 py-2 text-center text-sm">
              This conversation is being handed to a person. See Human Handoffs.
            </p>
          )}
        </div>
      </Card>

      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Tool activity</CardTitle>
            <Badge tone="ok">Live</Badge>
          </CardHeader>
          <CardContent>
            {state.activeTool ? (
              <p className="flex items-center gap-2 text-sm font-medium" role="status">
                <Wrench className="h-4 w-4 text-accent" aria-hidden="true" />
                <span className="font-mono">{state.activeTool}</span>
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                Nothing running. Tools show here the moment the agent starts them.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Where the time went</CardTitle>
            <Badge>last turn</Badge>
          </CardHeader>
          <CardContent>
            {!state.metrics ? (
              <p className="text-sm text-muted-foreground">
                After each answer, the measured time of every step shows here.
              </p>
            ) : (
              <dl
                aria-label="Time per step"
                className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm"
              >
                {TIMING_ROWS.filter(([key]) => state.metrics?.[key] !== undefined).map(
                  ([key, label]) => (
                    <div key={key} className="contents">
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="text-right font-mono tabular-nums">
                        {state.metrics![key]} ms
                      </dd>
                    </div>
                  ),
                )}
              </dl>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Sources for the last answer</CardTitle>
            <Badge>{state.sources.length}</Badge>
          </CardHeader>
          <CardContent>
            {state.sources.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                When an answer comes from the policy documents, the document and page show here.
                They are never read aloud.
              </p>
            ) : (
              <ul aria-label="Sources for the last answer" className="space-y-2 text-sm">
                {state.sources.map((p, i) => (
                  <li
                    key={`${p.source}-${p.page ?? 0}-${i}`}
                    className="rounded-md border border-border bg-elevated p-2.5"
                  >
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      <FileText className="h-4 w-4 text-accent" aria-hidden="true" />
                      <span className="font-mono text-xs">{p.source}</span>
                      {p.page && (
                        <Badge tone="accent">
                          page {p.page}
                          {p.pageEnd && p.pageEnd !== p.page ? `–${p.pageEnd}` : ''}
                        </Badge>
                      )}
                      {p.version && p.version > 1 && <Badge>version {p.version}</Badge>}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">{p.heading}</p>
                    <p className="mt-1 text-xs">“{p.excerpt}”</p>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Transcript</CardTitle>
            <Badge>{state.lines.length} lines</Badge>
          </CardHeader>
          <CardContent>
            {state.lines.length === 0 && !state.partial ? (
              <p className="text-sm text-muted-foreground">
                Your words and the agent's replies appear here as you talk.
              </p>
            ) : (
              <ol
                aria-label="Voice transcript"
                aria-live="polite"
                className="max-h-80 space-y-2 overflow-y-auto text-sm"
              >
                {state.lines.map((l) => (
                  <li
                    key={l.id}
                    className={cn(
                      'rounded-md px-3 py-2',
                      l.who === 'you' ? 'bg-accent/10' : 'border border-border bg-elevated',
                    )}
                  >
                    <span className="font-medium">
                      {l.who === 'you' ? 'You' : client.persona.name}:{' '}
                    </span>
                    {l.who === 'agent' ? stripSourceTags(l.text) : l.text}
                    {l.uncertain && (
                      <Badge tone="warn" className="ml-2">
                        not sure I heard that
                      </Badge>
                    )}
                  </li>
                ))}
                {state.partial && (
                  <li className="rounded-md border border-dashed border-border px-3 py-2 italic text-muted-foreground">
                    {state.partial}
                  </li>
                )}
              </ol>
            )}
          </CardContent>
        </Card>

        <p className="text-xs text-muted-foreground">
          Speech recognition and the agent's voice run on the voice gateway on this computer; only
          the recognised text goes on to the AI model. Use headphones if you can: the browser
          cancels echo, but a loud speaker can still make the agent hear itself. The waveform and
          the glow of the agent follow the real microphone level while you talk and the real audio
          level while the agent speaks.
        </p>
      </div>
    </div>
  );
}
