import { describe, expect, it } from 'vitest';
import { AVATARS } from '@/avatar/avatar-config';
import { NO_VISEMES, SILENT_FRAME, type LipFrame } from '@/avatar/lip-sync';
import { VrmAnimator, type VrmLike } from '@/avatar/vrm-animator';

const config = AVATARS['skylink-air']!;

function fakeVrm() {
  const values = new Map<string, number>();
  const bones = new Map<string, { rotation: { x: number; y: number; z: number } }>();
  const bone = (name: string) => {
    if (!bones.has(name)) bones.set(name, { rotation: { x: 0, y: 0, z: 0 } });
    return bones.get(name)!;
  };
  const vrm: VrmLike = {
    expressionManager: { setValue: (n, w) => void values.set(n, w) },
    humanoid: { getNormalizedBoneNode: bone },
  };
  const mouth = () => ['aa', 'ih', 'ou', 'ee', 'oh'].reduce((a, n) => a + (values.get(n) ?? 0), 0);
  return { vrm, values, bone, mouth };
}

const speaking = (epoch = 1, aa = 0.8): LipFrame => ({
  active: true,
  epoch,
  level: aa,
  visemes: { ...NO_VISEMES, aa },
});
type Input = Parameters<VrmAnimator['update']>[1];
const run = (a: VrmAnimator, frames: number, input: Input, dt = 1 / 60) => {
  for (let i = 0; i < frames; i++) a.update(dt, input);
};
const base = { mode: 'speaking' as const, reducedMotion: false };
const half = () => 0.5;

describe('VrmAnimator mouth', () => {
  it('opens only for audio that is actually playing, and uses the configured expression names', () => {
    const f = fakeVrm();
    const a = new VrmAnimator(f.vrm, config, half);
    run(a, 30, { ...base, frame: speaking() });
    expect(f.values.get('aa')).toBeGreaterThan(0.4);
    expect(f.mouth()).toBeLessThanOrEqual(0.9);
  });

  it('stays closed with no audio signal at all, even in the speaking state (nothing is faked)', () => {
    const f = fakeVrm();
    const a = new VrmAnimator(f.vrm, config, half);
    run(a, 120, { ...base, frame: undefined });
    expect(f.mouth()).toBe(0);
    run(a, 120, { ...base, frame: SILENT_FRAME });
    expect(f.mouth()).toBe(0);
  });

  it('closes when the audio goes silent', () => {
    const f = fakeVrm();
    const a = new VrmAnimator(f.vrm, config, half);
    run(a, 30, { ...base, frame: speaking() });
    expect(f.mouth()).toBeGreaterThan(0.3);
    run(a, 60, { ...base, frame: { ...SILENT_FRAME, epoch: 1 } });
    expect(f.mouth()).toBe(0);
  });

  it('closes in the very next update when playback is cut off (new epoch), without easing out', () => {
    const f = fakeVrm();
    const a = new VrmAnimator(f.vrm, config, half);
    run(a, 30, { ...base, frame: speaking(1) });
    expect(f.mouth()).toBeGreaterThan(0.3);
    a.update(1 / 144, { ...base, frame: { ...SILENT_FRAME, epoch: 2 } });
    expect(f.mouth()).toBe(0);
  });

  it('does not let a stale frame reopen the mouth after the cut', () => {
    const f = fakeVrm();
    const a = new VrmAnimator(f.vrm, config, half);
    run(a, 30, { ...base, frame: speaking(1) });
    a.update(1 / 60, { ...base, frame: { ...SILENT_FRAME, epoch: 2 } });
    // playback reports nothing audible for the cut turn: even a stray non-zero viseme stays shut
    a.update(1 / 60, {
      ...base,
      frame: { active: false, epoch: 2, level: 0, visemes: { ...NO_VISEMES, aa: 1 } },
    });
    expect(f.mouth()).toBe(0);
  });

  it('keeps the mouth shut in the error state even if audio is reported', () => {
    const f = fakeVrm();
    const a = new VrmAnimator(f.vrm, config, half);
    run(a, 30, { mode: 'error', reducedMotion: false, frame: speaking() });
    expect(f.mouth()).toBe(0);
  });

  it('close() zeroes every mouth and blink value', () => {
    const f = fakeVrm();
    const a = new VrmAnimator(f.vrm, config, half);
    run(a, 30, { ...base, frame: speaking() });
    a.close();
    expect(f.mouth()).toBe(0);
    expect(f.values.get('blink')).toBe(0);
    expect(a.lastMouth).toBe(0);
  });
});

describe('VrmAnimator face and posture', () => {
  it('blinks at irregular intervals and always reopens', () => {
    const f = fakeVrm();
    let n = 0;
    const a = new VrmAnimator(f.vrm, config, () => [0.1, 0.5, 0.9, 0.3, 0.7][n++ % 5]!);
    const seen: number[] = [];
    for (let i = 0; i < 60 * 20; i++) {
      a.update(1 / 60, { mode: 'idle', reducedMotion: false });
      seen.push(f.values.get('blink') ?? 0);
    }
    expect(Math.max(...seen)).toBeGreaterThan(0.9);
    const blinks = seen.filter((v, i) => v > 0.5 && (seen[i - 1] ?? 0) <= 0.5).length;
    expect(blinks).toBeGreaterThanOrEqual(3);
    expect(blinks).toBeLessThanOrEqual(10);
    // never held shut
    let streak = 0;
    let longest = 0;
    for (const v of seen) {
      streak = v > 0.5 ? streak + 1 : 0;
      longest = Math.max(longest, streak);
    }
    expect(longest).toBeLessThan(30);
  });

  it('eases expressions between modes instead of snapping', () => {
    const f = fakeVrm();
    const a = new VrmAnimator(f.vrm, config, half);
    run(a, 1, { mode: 'success', reducedMotion: false });
    const first = f.values.get('happy') ?? 0;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(0.45);
    run(a, 240, { mode: 'success', reducedMotion: false });
    expect(f.values.get('happy')).toBeGreaterThan(0.4);
    run(a, 400, { mode: 'idle', reducedMotion: false });
    expect(f.values.get('happy')).toBe(0);
  });

  it('lowers the arms from the T-pose and breathes', () => {
    const f = fakeVrm();
    const a = new VrmAnimator(f.vrm, config, half);
    const chest = f.bone('upperChest');
    const seen = new Set<number>();
    for (let i = 0; i < 240; i++) {
      a.update(1 / 60, { mode: 'idle', reducedMotion: false });
      seen.add(Math.round(chest.rotation.x * 1e5));
    }
    expect(f.bone('leftUpperArm').rotation.z).toBeLessThan(-1);
    expect(f.bone('rightUpperArm').rotation.z).toBeGreaterThan(1);
    expect(seen.size).toBeGreaterThan(10);
  });

  it('moves much less with reduced motion, but still lowers the arms', () => {
    const swing = (reducedMotion: boolean) => {
      const f = fakeVrm();
      const a = new VrmAnimator(f.vrm, config, half);
      let max = 0;
      for (let i = 0; i < 600; i++) {
        a.update(1 / 60, { mode: 'listening', reducedMotion });
        max = Math.max(max, Math.abs(f.bone('head').rotation.y), Math.abs(f.bone('upperChest').rotation.x));
      }
      return { max, arm: f.bone('leftUpperArm').rotation.z };
    };
    const normal = swing(false);
    const calm = swing(true);
    expect(calm.max).toBeLessThan(normal.max * 0.4);
    expect(calm.arm).toBeLessThan(-1);
  });

  it('tolerates a model with no expression manager or humanoid', () => {
    const a = new VrmAnimator({}, config, half);
    expect(() => run(a, 10, { ...base, frame: speaking() })).not.toThrow();
  });

  it('ignores huge frame gaps (a background tab) instead of jumping', () => {
    const f = fakeVrm();
    const a = new VrmAnimator(f.vrm, config, half);
    a.update(30, { ...base, frame: speaking() });
    expect(f.mouth()).toBeLessThan(0.95);
  });
});
