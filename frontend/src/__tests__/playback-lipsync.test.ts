import { describe, expect, it, vi } from 'vitest';
import type { OutputFrame } from '@/voice/protocol';
import { Playback } from '@/voice/playback';

class FakeSource {
  onended: (() => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

/** A fake audio graph with the two analysers Playback creates: one for the level, one for the mouth. */
function fakeContext() {
  const analysers: {
    getFloatTimeDomainData: ReturnType<typeof vi.fn>;
    getFloatFrequencyData: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }[] = [];
  const gain = {
    value: 1,
    cancelScheduledValues: vi.fn(),
    setValueAtTime: (v: number) => {
      gain.value = v;
    },
  };
  const ctx = {
    currentTime: 0,
    sampleRate: 48000,
    destination: {},
    createGain: () => ({ gain, connect: vi.fn(), disconnect: vi.fn() }),
    createAnalyser: () => {
      const a = {
        fftSize: 512,
        smoothingTimeConstant: 0,
        get frequencyBinCount() {
          return this.fftSize / 2;
        },
        connect: vi.fn(),
        disconnect: vi.fn(),
        // loud speech with energy around 800 and 1250 Hz
        getFloatTimeDomainData: vi.fn((arr: Float32Array) => arr.fill(0.1)),
        getFloatFrequencyData: vi.fn((arr: Float32Array) => {
          arr.fill(-110);
          const binHz = 48000 / 2 / arr.length;
          arr[Math.round(800 / binHz)] = -20;
          arr[Math.round(1250 / binHz)] = -28;
        }),
      };
      analysers.push(a);
      return a;
    },
    createBuffer: (_c: number, length: number, rate: number) => ({
      duration: length / rate,
      copyToChannel: vi.fn(),
    }),
    createBufferSource: () => new FakeSource(),
  };
  return { ctx: ctx as unknown as AudioContext, analysers, gain };
}

const frame = (turn: number, last = false): OutputFrame => ({
  turn,
  chunk: 0,
  sampleRate: 16000,
  last,
  samples: new Float32Array(3200).fill(0.1),
});

function playback() {
  const f = fakeContext();
  const p = new Playback(f.ctx, { onStarted: vi.fn(), onEnded: vi.fn() });
  const lipAnalyser = f.analysers[1]!;
  return { ...f, p, lipAnalyser };
}

describe('Playback lip-sync reading', () => {
  it('reports a closed mouth and does no analysis while nothing is playing', () => {
    const { p, lipAnalyser } = playback();
    const f = p.lipFrame();
    expect(f.active).toBe(false);
    expect(f.level).toBe(0);
    expect(Object.values(f.visemes).every((v) => v === 0)).toBe(true);
    expect(lipAnalyser.getFloatTimeDomainData).not.toHaveBeenCalled();
    expect(lipAnalyser.getFloatFrequencyData).not.toHaveBeenCalled();
  });

  it('follows the audio that has been queued for playback', () => {
    const { p, lipAnalyser } = playback();
    p.enqueue(frame(1));
    const f = p.lipFrame();
    expect(f.active).toBe(true);
    expect(f.level).toBeGreaterThan(0.3);
    expect(f.visemes.aa).toBeGreaterThan(0.1);
    expect(lipAnalyser.getFloatFrequencyData).toHaveBeenCalledTimes(1);
  });

  it('reads the analyser branch that is not connected to the speakers (no second player)', () => {
    const { lipAnalyser, p } = playback();
    p.enqueue(frame(1));
    // the speaker analyser connects onward to the destination; the lip-sync branch only listens
    expect(lipAnalyser.disconnect).not.toHaveBeenCalled();
    expect((lipAnalyser as unknown as { connect: ReturnType<typeof vi.fn> }).connect).not.toHaveBeenCalled();
  });

  it('closes the mouth and bumps the epoch the moment playback is interrupted', () => {
    const { p } = playback();
    p.enqueue(frame(1));
    const before = p.lipFrame();
    expect(before.active).toBe(true);
    p.interrupt(1);
    const after = p.lipFrame();
    expect(after.active).toBe(false);
    expect(after.level).toBe(0);
    expect(after.epoch).toBeGreaterThan(before.epoch);
  });

  it('rejects a late chunk of the interrupted turn: it neither plays nor moves the mouth', () => {
    const { p } = playback();
    p.enqueue(frame(1));
    p.interrupt(1);
    p.enqueue(frame(1));
    expect(p.staleDropped).toBe(1);
    expect(p.lipFrame().active).toBe(false);
  });

  it('speaks again for the next turn after an interruption', () => {
    const { p } = playback();
    p.enqueue(frame(1));
    p.interrupt(1);
    p.enqueue(frame(2));
    expect(p.lipFrame().active).toBe(true);
  });

  it('does not report speech while the output is muted', () => {
    const { p, gain } = playback();
    p.enqueue(frame(1));
    gain.value = 0;
    expect(p.lipFrame().active).toBe(false);
  });

  it('stops analysing and releases the analyser on dispose', () => {
    const { p, lipAnalyser } = playback();
    p.enqueue(frame(1));
    p.dispose();
    expect(lipAnalyser.disconnect).toHaveBeenCalled();
    expect(p.lipFrame().active).toBe(false);
  });

  it('repeated sessions do not leak: every session disposes its own analysers', () => {
    for (let i = 0; i < 5; i++) {
      const { p, analysers } = playback();
      p.enqueue(frame(1));
      p.dispose();
      expect(analysers.every((a) => a.disconnect.mock.calls.length > 0)).toBe(true);
    }
  });
});
