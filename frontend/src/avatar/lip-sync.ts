/**
 * Audio-reactive lip-sync, computed from the audio that is actually being played.
 *
 * This is an approximation, not phoneme alignment: the voice engine sends PCM only (no viseme or
 * word timings), so the mouth shape is estimated from the loudness and the rough spectral balance
 * of the output signal. Loudness sets how far the mouth opens; where the energy sits in the
 * spectrum (a crude stand-in for the vowel formants) picks which of the five VRM mouth shapes
 * leads. Silence closes it.
 */

export type Viseme = 'aa' | 'ih' | 'ou' | 'ee' | 'oh';
export const VISEMES: readonly Viseme[] = ['aa', 'ih', 'ou', 'ee', 'oh'];

/** What the animator reads each frame. `epoch` changes whenever playback is cut off. */
export interface LipFrame {
  /** Audio the listener can hear is being played right now. */
  active: boolean;
  /** Bumped on every interruption, so a consumer can drop what it was holding at once. */
  epoch: number;
  /** 0-1 loudness after the noise gate. */
  level: number;
  /** 0-1 target weight for each mouth shape. */
  visemes: Record<Viseme, number>;
}

export const NO_VISEMES: Record<Viseme, number> = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
export const SILENT_FRAME: LipFrame = { active: false, epoch: 0, level: 0, visemes: NO_VISEMES };

/** Below this RMS the signal is treated as silence (the mouth closes). */
export const GATE_OPEN = 0.018;
export const GATE_CLOSE = 0.01;

/** Root-mean-square of a block of samples. */
export function rms(samples: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

/** Typical first/second formants (Hz) of the vowels each VRM mouth shape stands for. */
const PROTOTYPES: { viseme: Viseme; f1: number; f2: number; opening: number }[] = [
  { viseme: 'aa', f1: 800, f2: 1250, opening: 1 },
  { viseme: 'ee', f1: 500, f2: 1900, opening: 0.7 },
  { viseme: 'ih', f1: 300, f2: 2300, opening: 0.55 },
  { viseme: 'oh', f1: 500, f2: 900, opening: 0.8 },
  { viseme: 'ou', f1: 320, f2: 800, opening: 0.55 },
];

/** Frequency (Hz) of the strongest bin of an analyser's dB spectrum between lo and hi. */
function peakFrequency(db: ArrayLike<number>, sampleRate: number, lo: number, hi: number, tilt = 0): number {
  const binHz = sampleRate / 2 / db.length;
  const from = Math.max(1, Math.floor(lo / binHz));
  const to = Math.min(db.length - 1, Math.ceil(hi / binHz));
  let best = from;
  let bestScore = -Infinity;
  for (let i = from; i <= to; i++) {
    // three-bin average so a single noisy bin cannot win
    const v = (finite(db[i - 1]) + finite(db[i]) + finite(db[i + 1] ?? db[i])) / 3;
    // `tilt` dB per octave above `lo` makes up for the weaker upper formant
    const score = v + tilt * Math.log2((i * binHz) / lo);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best * binHz;
}
const finite = (v: number | undefined) => (v !== undefined && Number.isFinite(v) ? v : -140);

/**
 * Turn one analyser reading into a loudness and a mouth shape.
 *
 * The first two spectral peaks stand in for the vowel's first two formants; the shape is the soft
 * nearest vowel in formant space. `gateOpen` is the hysteresis state: once speech has opened the
 * gate it stays open until the level falls below the lower threshold, so the mouth does not
 * flutter on a quiet word ending.
 */
export function analyseSpeech(
  time: ArrayLike<number>,
  freqDb: ArrayLike<number>,
  sampleRate: number,
  gateOpen = false,
): { level: number; visemes: Record<Viseme, number>; gateOpen: boolean } {
  const energy = rms(time);
  const open = energy >= (gateOpen ? GATE_CLOSE : GATE_OPEN);
  if (!open) return { level: 0, visemes: { ...NO_VISEMES }, gateOpen: false };

  // Loudness -> how far the mouth can open. Speech RMS sits around 0.03-0.25, so scale to ~0.9.
  const level = Math.min(1, energy * 4.2);

  const f1 = peakFrequency(freqDb, sampleRate, 200, 1000);
  const f2 = peakFrequency(freqDb, sampleRate, Math.max(900, f1 * 1.35), 3200, 4);

  let sum = 0;
  const share = PROTOTYPES.map((p) => {
    const d1 = Math.log(f1 / p.f1) / 0.28;
    const d2 = Math.log(f2 / p.f2) / 0.3;
    const w = Math.exp(-(d1 * d1 + d2 * d2));
    sum += w;
    return w;
  });
  const visemes = { ...NO_VISEMES };
  if (sum <= 1e-9) return { level, visemes: { ...visemes, aa: level * 0.5 }, gateOpen: true };
  PROTOTYPES.forEach((p, i) => {
    // louder and more open vowels move the jaw more; rounded and spread vowels less
    visemes[p.viseme] = Math.min(1, (share[i]! / sum) * level * (0.45 + 0.75 * p.opening));
  });
  return { level, visemes, gateOpen: true };
}

/**
 * Frame-rate independent smoothing with a fast attack and a faster release, per channel. The mouth
 * opens within a couple of frames and closes decisively; `reset()` closes it this instant.
 */
export class MouthSmoother {
  private value: Record<Viseme, number> = { ...NO_VISEMES };

  constructor(
    private readonly attack = 0.035,
    private readonly release = 0.06,
  ) {}

  step(target: Record<Viseme, number>, dt: number): Record<Viseme, number> {
    for (const v of VISEMES) {
      const tau = target[v] > this.value[v] ? this.attack : this.release;
      this.value[v] += (target[v] - this.value[v]) * (1 - Math.exp(-dt / tau));
      if (this.value[v] < 0.002) this.value[v] = 0;
    }
    return this.value;
  }

  reset(): void {
    this.value = { ...NO_VISEMES };
  }

  get total(): number {
    return VISEMES.reduce((a, v) => a + this.value[v], 0);
  }
}

/**
 * The summed mouth weight is capped so overlapping shapes cannot distort the face.
 * Returns the factor to multiply every shape by.
 */
export function limitMouth(weights: Record<Viseme, number>, cap = 0.9): number {
  const sum = VISEMES.reduce((a, v) => a + weights[v], 0);
  return sum > cap ? cap / sum : 1;
}
