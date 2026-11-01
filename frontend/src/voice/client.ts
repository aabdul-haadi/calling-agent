import { SILENT_FRAME, type LipFrame } from '@/avatar/lip-sync';
import { Playback } from './playback';
import {
  PROTOCOL_VERSION,
  FrameError,
  packInput,
  parseOutput,
  parseServerEvent,
  type ServerEvent,
} from './protocol';
import type { LocalEvent } from './state';

export interface VoiceClientOptions {
  url: string;
  token: string;
  conversationId?: string;
  onEvent: (event: ServerEvent | LocalEvent) => void;
}

/** A microphone problem described in words a person can act on. */
export class MicrophoneError extends Error {}

function describeMicError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return 'Microphone access was blocked. Allow it in the address bar, then press Start again.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError')
    return 'No microphone was found. Plug one in or choose one in your system settings.';
  if (name === 'NotReadableError' || name === 'AbortError')
    return 'The microphone is busy or unavailable. Close other apps that use it and try again.';
  return 'The microphone could not be started.';
}

/** Browser audio is only available on a secure page with the Web Audio and WebSocket APIs. */
export function voiceEngineSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof AudioContext !== 'undefined' &&
    typeof AudioWorkletNode !== 'undefined' &&
    typeof WebSocket !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

/**
 * One voice session in the browser: microphone in, speech out, a WebSocket to the gateway.
 * It decides nothing about the conversation; it moves audio and obeys the interrupt event.
 */
export class VoiceClient {
  private ws?: WebSocket;
  private ctx?: AudioContext;
  private stream?: MediaStream;
  private node?: AudioWorkletNode;
  private playback?: Playback;
  private mic = 0;
  private muted = false;
  private closed = false;
  /** Frames not sent because the connection was backed up (a sign of a slow network). */
  droppedFrames = 0;

  constructor(private readonly opts: VoiceClientOptions) {}

  /** Must be called from a click: browsers only start audio after a user gesture. */
  async start(): Promise<void> {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    await ctx.resume();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
    } catch (err) {
      this.dispose();
      throw new MicrophoneError(describeMicError(err));
    }
    await ctx.audioWorklet.addModule('/voice-capture.worklet.js');
    const source = ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(ctx, 'voice-capture', {
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    const silent = ctx.createGain();
    silent.gain.value = 0; // some browsers only run a node that reaches the destination
    source.connect(this.node);
    this.node.connect(silent).connect(ctx.destination);
    this.node.port.onmessage = (
      m: MessageEvent<{ type: string; pcm?: ArrayBuffer; rms?: number }>,
    ) => {
      if (m.data.type === 'level') this.mic = Math.min(1, (m.data.rms ?? 0) * 4);
      else if (m.data.type === 'frame' && m.data.pcm) this.sendFrame(m.data.pcm);
    };
    // Tell the page if the microphone is unplugged mid-call.
    this.stream.getAudioTracks()[0]?.addEventListener('ended', () => {
      this.opts.onEvent({ type: 'local.mic_denied', message: 'The microphone was disconnected.' });
      this.stop();
    });

    this.playback = new Playback(ctx, {
      onStarted: (turn) => this.send({ type: 'playback.started', turn }),
      onEnded: (turn) => {
        this.send({ type: 'playback.ended', turn });
        this.opts.onEvent({ type: 'local.playback_ended' });
      },
    });

    const ws = new WebSocket(this.opts.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () =>
      this.send({
        type: 'session.start',
        protocol: PROTOCOL_VERSION,
        token: this.opts.token,
        sampleRate: 16000,
        ...(this.opts.conversationId ? { conversationId: this.opts.conversationId } : {}),
      });
    ws.onmessage = (m) => this.onMessage(m.data as string | ArrayBuffer);
    ws.onclose = () => {
      if (!this.closed) this.opts.onEvent({ type: 'local.closed' });
      this.dispose();
    };
    ws.onerror = () => undefined; // onclose follows and carries the outcome
  }

  private onMessage(data: string | ArrayBuffer): void {
    if (typeof data === 'string') {
      const event = parseServerEvent(data);
      if (!event) return;
      // Silence the speaker first, then tell the page: nothing may delay the stop.
      if (event.type === 'agent.interrupted' && event.turn !== undefined) {
        const stopMs = this.playback?.interrupt(event.turn) ?? 0;
        this.send({
          type: 'playback.stopped',
          turn: event.turn,
          stopMs: Math.round(stopMs * 10) / 10,
        });
      }
      this.opts.onEvent(event);
      return;
    }
    try {
      this.playback?.enqueue(parseOutput(data));
    } catch (err) {
      if (!(err instanceof FrameError)) throw err; // a damaged frame is skipped, not fatal
    }
  }

  private sendFrame(pcm: ArrayBuffer): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 64 * 1024) {
      this.droppedFrames += 1; // never let a slow connection build an ever-growing backlog
      return;
    }
    ws.send(packInput(new Int16Array(pcm)));
  }

  private send(message: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  /** The stop button: same cancellation as speaking over the agent. */
  interrupt(): void {
    this.send({ type: 'control.interrupt' });
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.node?.port.postMessage({ muted });
    this.stream?.getAudioTracks().forEach((t) => (t.enabled = !muted));
  }

  get isMuted(): boolean {
    return this.muted;
  }

  micLevel(): number {
    return this.muted ? 0 : this.mic;
  }

  /** Real level of the audio currently coming out of the speakers. */
  /** The avatar's mouth, from the audio actually playing (closed when nothing is heard). */
  lipFrame(): LipFrame {
    return this.playback?.lipFrame() ?? SILENT_FRAME;
  }

  outputLevel(): number {
    return this.playback?.level() ?? 0;
  }

  get staleFramesDropped(): number {
    return this.playback?.staleDropped ?? 0;
  }

  stop(): void {
    this.closed = true;
    this.send({ type: 'session.end' });
    this.ws?.close();
    this.dispose();
    this.opts.onEvent({ type: 'local.closed' });
  }

  private dispose(): void {
    this.playback?.dispose();
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close().catch(() => undefined);
    this.playback = undefined;
    this.node = undefined;
    this.stream = undefined;
    this.ctx = undefined;
  }
}
