import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gatewayAgentMode } from '@/voice/agent-mode';
import { Playback } from '@/voice/playback';
import {
  FrameError,
  INPUT_HEADER_BYTES,
  OUTPUT_HEADER_BYTES,
  TurnGate,
  packInput,
  parseOutput,
  parseServerEvent,
  type OutputFrame,
  type ServerEvent,
} from '@/voice/protocol';
import { INITIAL, STATUS_TEXT, reduce, type VoiceState, type VoiceStatus } from '@/voice/state';

/** Build a server frame exactly as voice-service/app/audio/framing.py does. */
function serverFrame(
  turn: number,
  chunk: number,
  pcm: number[],
  last = false,
  rate = 16000,
): ArrayBuffer {
  const buf = new ArrayBuffer(OUTPUT_HEADER_BYTES + pcm.length * 2);
  const v = new DataView(buf);
  v.setUint8(0, 0x02);
  v.setUint8(1, last ? 1 : 0);
  v.setUint32(4, turn, true);
  v.setUint32(8, chunk, true);
  v.setUint32(12, rate, true);
  new Int16Array(buf, OUTPUT_HEADER_BYTES).set(pcm);
  return buf;
}

describe('protocol framing', () => {
  it('wraps microphone audio with the 4-byte header the server expects', () => {
    const pcm = new Int16Array([1, -2, 3]);
    const out = packInput(pcm);
    expect(out.byteLength).toBe(INPUT_HEADER_BYTES + 6);
    const v = new DataView(out);
    expect([v.getUint8(0), v.getUint8(1), v.getUint16(2, true)]).toEqual([1, 0, 0]);
    expect([...new Int16Array(out, INPUT_HEADER_BYTES)]).toEqual([1, -2, 3]);
  });

  it('reads a server audio frame: turn, chunk, rate, last flag and samples', () => {
    const f = parseOutput(serverFrame(7, 3, [0, 16384, -16384], true, 22050));
    expect(f).toMatchObject({ turn: 7, chunk: 3, sampleRate: 22050, last: true });
    expect([...f.samples]).toEqual([0, 0.5, -0.5]);
  });

  it('accepts the empty end-of-reply marker', () => {
    const f = parseOutput(serverFrame(1, 9, [], true));
    expect(f.samples.length).toBe(0);
    expect(f.last).toBe(true);
  });

  it('rejects damaged frames instead of playing noise', () => {
    expect(() => parseOutput(new ArrayBuffer(8))).toThrow(FrameError);
    const wrongType = serverFrame(1, 0, [1]);
    new DataView(wrongType).setUint8(0, 0x09);
    expect(() => parseOutput(wrongType)).toThrow(FrameError);
    expect(() => parseOutput(new ArrayBuffer(OUTPUT_HEADER_BYTES + 3))).toThrow(FrameError);
  });

  it('ignores server text that is not an event', () => {
    expect(parseServerEvent('not json')).toBeUndefined();
    expect(parseServerEvent('{"no":"type"}')).toBeUndefined();
    expect(parseServerEvent('{"type":"agent.thinking","seq":2}')).toMatchObject({
      type: 'agent.thinking',
    });
  });
});

describe('TurnGate (stale audio)', () => {
  it('lets a turn play until it is interrupted, then blocks it and every older turn', () => {
    const g = new TurnGate();
    expect([g.allows(1), g.allows(2)]).toEqual([true, true]);
    g.interrupt(2);
    expect([g.allows(1), g.allows(2), g.allows(3)]).toEqual([false, false, true]);
  });

  it('a late frame is refused however the network reordered it', () => {
    const g = new TurnGate();
    g.interrupt(4);
    // frames of turn 4 arriving after the interrupt event, in any order
    for (const turn of [4, 4, 3, 4]) expect(g.allows(turn)).toBe(false);
    expect(g.allows(5)).toBe(true);
  });

  it('never un-blocks: a smaller interrupt cannot re-open an older turn', () => {
    const g = new TurnGate();
    g.interrupt(5);
    g.interrupt(2);
    expect(g.allows(4)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Playback against a fake audio context
// ---------------------------------------------------------------------------------------------

class FakeSource {
  buffer?: { duration: number };
  startedAt?: number;
  stopped = false;
  onended: (() => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  start(at: number) {
    this.startedAt = at;
  }
  stop() {
    this.stopped = true;
  }
}

function fakeContext() {
  const sources: FakeSource[] = [];
  const gainSets: number[] = [];
  const ctx = {
    currentTime: 0,
    destination: {},
    createGain: () => ({
      gain: {
        value: 1,
        cancelScheduledValues: vi.fn(),
        setValueAtTime: (v: number) => {
          gainSets.push(v);
        },
      },
      connect: vi.fn(),
      disconnect: vi.fn(),
    }),
    createAnalyser: () => ({
      fftSize: 512,
      connect: vi.fn(),
      disconnect: vi.fn(),
      getFloatTimeDomainData: (a: Float32Array) => a.fill(0.1),
    }),
    createBuffer: (_c: number, length: number, rate: number) => ({
      duration: length / rate,
      copyToChannel: vi.fn(),
    }),
    createBufferSource: () => {
      const s = new FakeSource();
      sources.push(s);
      return s;
    },
  };
  return { ctx: ctx as unknown as AudioContext, raw: ctx, sources, gainSets };
}

const frame = (turn: number, ms = 200, last = false): OutputFrame => ({
  turn,
  chunk: 0,
  sampleRate: 16000,
  last,
  samples: new Float32Array((16000 * ms) / 1000).fill(0.1),
});

describe('Playback', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('schedules frames back to back on the audio clock', () => {
    const { ctx, sources } = fakeContext();
    const p = new Playback(ctx, { onStarted: vi.fn(), onEnded: vi.fn() });
    p.enqueue(frame(1));
    p.enqueue(frame(1));
    p.enqueue(frame(1));
    const starts = sources.map((s) => s.startedAt!);
    expect(starts[0]).toBeGreaterThan(0); // a small lead, so the first chunk is not late
    expect(starts[1]! - starts[0]!).toBeCloseTo(0.2, 3);
    expect(starts[2]! - starts[1]!).toBeCloseTo(0.2, 3);
  });

  it('reports the start and, after the last frame has played, the end', () => {
    const { ctx, raw } = fakeContext();
    const onStarted = vi.fn();
    const onEnded = vi.fn();
    const p = new Playback(ctx, { onStarted, onEnded });
    p.enqueue(frame(1));
    p.enqueue(frame(1));
    p.enqueue({ ...frame(1), samples: new Float32Array(0), last: true }); // end marker
    vi.advanceTimersByTime(100);
    expect(onStarted).toHaveBeenCalledWith(1);
    expect(onEnded).not.toHaveBeenCalled(); // still playing 0.4 s of audio
    raw.currentTime = 0.5;
    vi.advanceTimersByTime(600);
    expect(onEnded).toHaveBeenCalledWith(1);
  });

  it('interrupt silences the output at once, stops everything queued and says how long it took', () => {
    const { ctx, sources, gainSets } = fakeContext();
    const p = new Playback(ctx, { onStarted: vi.fn(), onEnded: vi.fn() });
    for (let i = 0; i < 5; i++) p.enqueue(frame(1));
    const ms = p.interrupt(1);
    expect(sources.every((s) => s.stopped)).toBe(true);
    expect(gainSets.at(-1)).toBe(0); // muted
    expect(p.playing).toBe(false);
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(ms).toBeLessThan(50);
  });

  it('refuses frames of an interrupted turn that arrive afterwards, and counts them', () => {
    const { ctx, sources } = fakeContext();
    const p = new Playback(ctx, { onStarted: vi.fn(), onEnded: vi.fn() });
    p.enqueue(frame(1));
    p.interrupt(1);
    const before = sources.length;
    p.enqueue(frame(1)); // late arrival of the old reply
    p.enqueue(frame(1));
    expect(sources.length).toBe(before); // nothing was scheduled
    expect(p.staleDropped).toBe(2);
    // the next reply plays normally, and the output is un-muted for it
    p.enqueue(frame(2));
    expect(sources.length).toBe(before + 1);
    expect(sources.at(-1)!.stopped).toBe(false);
  });

  it('an interrupted reply never reports that it ended', () => {
    const { ctx, raw } = fakeContext();
    const onEnded = vi.fn();
    const p = new Playback(ctx, { onStarted: vi.fn(), onEnded });
    p.enqueue(frame(1));
    p.enqueue({ ...frame(1), samples: new Float32Array(0), last: true });
    p.interrupt(1);
    raw.currentTime = 5;
    vi.advanceTimersByTime(5000);
    expect(onEnded).not.toHaveBeenCalled();
  });

  it('reads the real output level from the analyser', () => {
    const { ctx } = fakeContext();
    const p = new Playback(ctx, { onStarted: vi.fn(), onEnded: vi.fn() });
    expect(p.level()).toBeGreaterThan(0.3); // analyser reports 0.1 samples: rms 0.1 x 4
  });
});

// ---------------------------------------------------------------------------------------------
// UI state
// ---------------------------------------------------------------------------------------------

let n = 0;
const ev = (e: Record<string, unknown>): ServerEvent =>
  ({ session: 's', seq: ++n, t: 0, ...e }) as unknown as ServerEvent;
const run = (
  events: (ServerEvent | { type: `local.${string}`; [k: string]: unknown })[],
  from: VoiceState = INITIAL,
) => events.reduce((s, e) => reduce(s, e as Parameters<typeof reduce>[1]), from);

describe('voice UI state', () => {
  it('walks through a normal turn', () => {
    const states: VoiceStatus[] = [];
    let s: VoiceState = INITIAL;
    for (const e of [
      { type: 'local.connecting' },
      ev({
        type: 'session.started',
        protocol: 1,
        inputSampleRate: 16000,
        outputSampleRate: 16000,
        conversationId: null,
      }),
      ev({ type: 'speech.started', turn: 1 }),
      ev({ type: 'transcript.partial', turn: 1, text: 'hello' }),
      ev({
        type: 'transcript.final',
        turn: 1,
        text: 'Hello there',
        confidence: 0.9,
        lowConfidence: false,
      }),
      ev({ type: 'agent.thinking', turn: 1 }),
      ev({ type: 'agent.text.delta', turn: 1, text: 'Hi! ' }),
      ev({ type: 'agent.speaking', turn: 1, sampleRate: 16000 }),
      ev({ type: 'agent.speech.completed', turn: 1 }),
      { type: 'local.playback_ended' },
    ] as Parameters<typeof reduce>[1][]) {
      s = reduce(s, e);
      states.push(s.status);
    }
    expect(states).toEqual([
      'connecting',
      'listening',
      'transcribing',
      'transcribing',
      'thinking',
      'thinking',
      'thinking',
      'speaking',
      'speaking',
      'listening',
    ]);
    expect(s.lines.map((l) => `${l.who}: ${l.text.trim()}`)).toEqual([
      'you: Hello there',
      'agent: Hi!',
    ]);
    expect(s.partial).toBe('');
  });

  it('shows partial words only while the customer is speaking', () => {
    let s = run([
      ev({ type: 'speech.started', turn: 1 }),
      ev({ type: 'transcript.partial', turn: 1, text: 'my flight' }),
    ]);
    expect(s.partial).toBe('my flight');
    s = run(
      [
        ev({
          type: 'transcript.final',
          turn: 1,
          text: 'my flight',
          confidence: 1,
          lowConfidence: false,
        }),
      ],
      s,
    );
    expect(s.partial).toBe('');
    // a late partial after the final must not reappear
    s = run([ev({ type: 'transcript.partial', turn: 1, text: 'my flig' })], s);
    expect(s.partial).toBe('');
  });

  it('marks a doubtful transcript so the customer knows the agent will ask again', () => {
    const s = run([
      ev({ type: 'transcript.final', turn: 1, text: 'yes', confidence: 0.3, lowConfidence: true }),
    ]);
    expect(s.lines[0]).toMatchObject({ who: 'you', uncertain: true });
  });

  it('tool activity is live and clears when the tool finishes', () => {
    let s = run([ev({ type: 'tool.started', turn: 1, tool: 'change_flight' })]);
    expect(s).toMatchObject({ status: 'executing_tool', activeTool: 'change_flight' });
    s = run([ev({ type: 'tool.completed', turn: 1, tool: 'change_flight', status: 'ok' })], s);
    expect(s).toMatchObject({ status: 'thinking', activeTool: undefined });
  });

  it('waits for the customer after an approval is requested, and a new answer clears it', () => {
    let s = run([
      ev({ type: 'agent.speaking', turn: 1, sampleRate: 16000 }),
      ev({
        type: 'approval.required',
        turn: 1,
        summary: 'Move SK1001 to SK110',
        expiresAt: '2026-11-10T10:10:00Z',
      }),
      ev({ type: 'turn.completed', turn: 1, status: 'completed' }),
      { type: 'local.playback_ended' },
    ]);
    expect(s.status).toBe('awaiting_confirmation');
    expect(s.pendingApproval?.summary).toContain('SK1001');
    s = run(
      [
        ev({
          type: 'transcript.final',
          turn: 2,
          text: 'yes',
          confidence: 0.9,
          lowConfidence: false,
        }),
      ],
      s,
    );
    expect(s.pendingApproval).toBeUndefined();
  });

  it('an interruption is shown at once and speech stops counting as playing', () => {
    const s = run([
      ev({ type: 'agent.speaking', turn: 1, sampleRate: 16000 }),
      ev({ type: 'agent.interrupted', turn: 1, reason: 'barge_in', droppedChunks: 4 }),
    ]);
    expect(s).toMatchObject({ status: 'interrupted', playing: false });
    // the cut-off reply's late "playback ended" must not flip the screen back to listening
    expect(reduce(s, { type: 'local.playback_ended' }).status).toBe('interrupted');
    expect(run([ev({ type: 'speech.started', turn: 2 })], s).status).toBe('transcribing');
  });

  it('a handoff stays visible', () => {
    const s = run([
      ev({ type: 'handoff.started', turn: 1, reason: 'asked for a person' }),
      ev({ type: 'turn.completed', turn: 1, status: 'completed' }),
    ]);
    expect(s).toMatchObject({ handedOff: true, status: 'handing_off' });
  });

  it('fatal errors end the call; non-fatal ones only show a notice', () => {
    const soft = run(
      [
        ev({
          type: 'session.error',
          code: 'tts_failed',
          message: 'could not speak that part',
          fatal: false,
        }),
      ],
      { ...INITIAL, status: 'listening' },
    );
    expect(soft).toMatchObject({ status: 'listening', notice: 'could not speak that part' });
    const hard = run(
      [ev({ type: 'session.error', code: 'timeout', message: 'no audio received', fatal: true })],
      { ...INITIAL, status: 'listening' },
    );
    expect(hard).toMatchObject({ status: 'error', error: { code: 'timeout' } });
    // closing afterwards must not hide the reason
    expect(reduce(hard, { type: 'local.closed' }).status).toBe('error');
  });

  it('microphone problems are errors with a reason', () => {
    const s = run([{ type: 'local.mic_denied', message: 'Microphone access was blocked.' }]);
    expect(s).toMatchObject({ status: 'error', error: { code: 'microphone' } });
  });

  it('every status has words for it', () => {
    for (const status of Object.keys(STATUS_TEXT) as VoiceStatus[])
      expect(STATUS_TEXT[status].length).toBeGreaterThan(3);
  });

  it('the 3D agent mode follows the call state', () => {
    const at = (status: VoiceStatus, extra: Partial<VoiceState> = {}) =>
      gatewayAgentMode({ ...INITIAL, status, ...extra });
    expect(at('thinking').mode).toBe('thinking');
    expect(at('speaking').mode).toBe('speaking');
    expect(at('executing_tool', { activeTool: 'get_booking' })).toEqual({
      mode: 'executing',
      tool: 'get_booking',
    });
    expect(at('awaiting_confirmation').mode).toBe('awaiting');
    expect(at('handing_off').mode).toBe('handoff');
    expect(at('error').mode).toBe('error');
    expect(at('listening').mode).toBe('listening');
    expect(at('idle').mode).toBe('idle');
  });
});
