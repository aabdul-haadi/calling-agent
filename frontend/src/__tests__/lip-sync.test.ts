import { describe, expect, it } from 'vitest';
import {
  analyseSpeech,
  GATE_CLOSE,
  GATE_OPEN,
  limitMouth,
  MouthSmoother,
  NO_VISEMES,
  rms,
  VISEMES,
} from '@/avatar/lip-sync';

const RATE = 48000;
const BINS = 512;

/** An analyser-style dB spectrum with a strong first formant and a weaker second one. */
function spectrum(f1: number, f2: number): Float32Array {
  const db = new Float32Array(BINS).fill(-110);
  const binHz = RATE / 2 / BINS;
  const peak = (hz: number, level: number) => {
    const centre = hz / binHz;
    for (let i = 0; i < BINS; i++) db[i] = Math.max(db[i]!, level - ((i - centre) / 1.6) ** 2);
  };
  peak(f1, -20);
  peak(f2, -30);
  return db;
}
const tone = (amp: number) => new Float32Array(1024).fill(amp);
const top = (w: Record<string, number>) => Object.entries(w).sort((a, b) => b[1] - a[1])[0]![0];

describe('lip-sync analysis', () => {
  it('computes root-mean-square loudness', () => {
    expect(rms([])).toBe(0);
    expect(rms([0.5, -0.5, 0.5, -0.5])).toBeCloseTo(0.5);
  });

  it('keeps the mouth closed below the noise gate, whatever the spectrum says', () => {
    const r = analyseSpeech(tone(GATE_OPEN / 2), spectrum(800, 1250), RATE);
    expect(r.level).toBe(0);
    expect(r.gateOpen).toBe(false);
    expect(VISEMES.every((v) => r.visemes[v] === 0)).toBe(true);
  });

  it('uses hysteresis: speech holds the gate open until the level falls below the lower threshold', () => {
    const between = (GATE_OPEN + GATE_CLOSE) / 2;
    expect(analyseSpeech(tone(between), spectrum(800, 1250), RATE, false).gateOpen).toBe(false);
    expect(analyseSpeech(tone(between), spectrum(800, 1250), RATE, true).gateOpen).toBe(true);
    expect(analyseSpeech(tone(GATE_CLOSE / 2), spectrum(800, 1250), RATE, true).gateOpen).toBe(false);
  });

  it.each([
    ['aa', 800, 1250],
    ['ee', 500, 1900],
    ['ih', 300, 2300],
    ['oh', 500, 900],
    ['ou', 320, 800],
  ])('picks %s for formants near %i/%i Hz', (shape, f1, f2) => {
    const r = analyseSpeech(tone(0.1), spectrum(f1, f2), RATE);
    expect(top(r.visemes)).toBe(shape);
    expect(r.level).toBeGreaterThan(0.3);
  });

  it('opens further for louder speech and never exceeds 1', () => {
    const quiet = analyseSpeech(tone(0.03), spectrum(800, 1250), RATE);
    const loud = analyseSpeech(tone(0.2), spectrum(800, 1250), RATE);
    expect(loud.visemes.aa).toBeGreaterThan(quiet.visemes.aa);
    expect(analyseSpeech(tone(1), spectrum(800, 1250), RATE).level).toBeLessThanOrEqual(1);
  });

  it('survives an all-silent or non-finite spectrum', () => {
    const r = analyseSpeech(tone(0.1), new Float32Array(BINS).fill(-Infinity), RATE);
    expect(Number.isFinite(r.level)).toBe(true);
    expect(VISEMES.every((v) => Number.isFinite(r.visemes[v]))).toBe(true);
  });
});

describe('mouth smoothing', () => {
  const open = { ...NO_VISEMES, aa: 1 };

  it('opens quickly and is frame-rate independent', () => {
    const a = new MouthSmoother();
    const b = new MouthSmoother();
    for (let i = 0; i < 60; i++) a.step(open, 1 / 60);
    for (let i = 0; i < 15; i++) b.step(open, 1 / 15);
    expect(a.step(open, 0).aa).toBeGreaterThan(0.95);
    expect(Math.abs(a.step(open, 0).aa - b.step(open, 0).aa)).toBeLessThan(0.02);
  });

  it('releases to exactly zero once the target is silent', () => {
    const s = new MouthSmoother();
    for (let i = 0; i < 30; i++) s.step(open, 1 / 60);
    for (let i = 0; i < 120; i++) s.step(NO_VISEMES, 1 / 60);
    expect(s.total).toBe(0);
  });

  it('reset() closes the mouth in the same call', () => {
    const s = new MouthSmoother();
    for (let i = 0; i < 30; i++) s.step(open, 1 / 60);
    expect(s.total).toBeGreaterThan(0.5);
    s.reset();
    expect(s.total).toBe(0);
  });

  it('limits the summed mouth weight so overlapping shapes cannot distort the face', () => {
    expect(limitMouth({ aa: 0.4, ih: 0.2, ou: 0, ee: 0, oh: 0 })).toBe(1);
    const f = limitMouth({ aa: 1, ih: 1, ou: 1, ee: 1, oh: 1 }, 0.9);
    expect(f * 5).toBeCloseTo(0.9);
  });
});
