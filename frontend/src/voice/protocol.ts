/**
 * The voice gateway wire protocol (version 1). Mirrors voice-service/app/audio/framing.py and
 * app/protocols/events.py: see docs/VOICE.md.
 *
 * Audio is binary. Client to server: a 4-byte header then PCM16 mono at the declared rate.
 * Server to client: a 16-byte header then PCM16 mono at the sample rate in the header.
 */
export const PROTOCOL_VERSION = 1;
export const TYPE_AUDIO_INPUT = 0x01;
export const TYPE_AGENT_AUDIO = 0x02;
export const FLAG_LAST = 0x01;
export const INPUT_HEADER_BYTES = 4;
export const OUTPUT_HEADER_BYTES = 16;

/** Wrap a PCM16 frame for the server. */
export function packInput(pcm: Int16Array): ArrayBuffer {
  const out = new ArrayBuffer(INPUT_HEADER_BYTES + pcm.byteLength);
  const view = new DataView(out);
  view.setUint8(0, TYPE_AUDIO_INPUT);
  new Int16Array(out, INPUT_HEADER_BYTES, pcm.length).set(pcm);
  return out;
}

export interface OutputFrame {
  turn: number;
  chunk: number;
  sampleRate: number;
  last: boolean;
  /** Mono samples in [-1, 1]. Empty for the end-of-reply marker. */
  samples: Float32Array;
}

export class FrameError extends Error {}

export function parseOutput(data: ArrayBuffer): OutputFrame {
  if (data.byteLength < OUTPUT_HEADER_BYTES) throw new FrameError('frame shorter than its header');
  const view = new DataView(data);
  if (view.getUint8(0) !== TYPE_AGENT_AUDIO) throw new FrameError('unknown frame type');
  const payload = data.byteLength - OUTPUT_HEADER_BYTES;
  if (payload % 2) throw new FrameError('payload must be whole 16-bit samples');
  const pcm = new Int16Array(data.slice(OUTPUT_HEADER_BYTES));
  const samples = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i]! / 32768;
  return {
    last: (view.getUint8(1) & FLAG_LAST) !== 0,
    turn: view.getUint32(4, true),
    chunk: view.getUint32(8, true),
    sampleRate: view.getUint32(12, true),
    samples,
  };
}

/** Everything the server may send as JSON. `seq` is strictly increasing within a session. */
export interface ServerEventBase {
  session: string;
  seq: number;
  t: number;
  turn?: number;
}
export type ServerEvent = ServerEventBase &
  (
    | {
        type: 'session.started';
        protocol: number;
        inputSampleRate: number;
        outputSampleRate: number;
        conversationId: string | null;
      }
    | { type: 'session.conversation'; conversationId: string }
    | { type: 'speech.started' }
    | { type: 'transcript.partial'; text: string }
    | { type: 'transcript.final'; text: string; confidence: number; lowConfidence: boolean }
    | { type: 'turn.discarded'; reason: string }
    | { type: 'agent.thinking' }
    | { type: 'agent.text.delta'; text: string }
    | { type: 'agent.speaking'; sampleRate: number }
    | { type: 'agent.speech.completed' }
    | {
        type: 'agent.interrupted';
        reason: 'barge_in' | 'client_request' | 'new_turn';
        droppedChunks: number;
      }
    | { type: 'knowledge.used'; sources: string[] }
    | { type: 'tool.started'; tool: string }
    | { type: 'tool.completed'; tool: string; status: 'ok' | 'blocked' | 'error' }
    | { type: 'approval.required'; summary: string; expiresAt: string }
    | { type: 'handoff.started'; reason: string }
    | { type: 'turn.metrics'; [metric: string]: unknown }
    | { type: 'turn.completed'; status: string }
    | { type: 'session.error'; code: string; message: string; fatal: boolean }
    | { type: 'session.closed'; reason: string }
  );

export function parseServerEvent(text: string): ServerEvent | undefined {
  try {
    const v = JSON.parse(text) as Partial<ServerEvent>;
    return typeof v === 'object' && v !== null && typeof v.type === 'string'
      ? (v as ServerEvent)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Decides which agent audio may still be played. After the agent is interrupted, everything that
 * belongs to that turn (or an older one) is stale: it may still be arriving over the network, or
 * be queued in the browser, and must never be heard. Turn ids only ever increase, so one number
 * is enough, and a late frame is rejected however the network reordered it.
 */
export class TurnGate {
  private blockedUpTo = 0;

  /** The server announced an interruption of `turn`. */
  interrupt(turn: number): void {
    this.blockedUpTo = Math.max(this.blockedUpTo, turn);
  }

  allows(turn: number): boolean {
    return turn > this.blockedUpTo;
  }

  reset(): void {
    this.blockedUpTo = 0;
  }
}
