import { describe, expect, it } from 'vitest';
import { blinkAmount, clampAudioLevel, mouthOpenness } from '@/agent3d/avatar-motion';

describe('procedural avatar motion', () => {
  it('uses the real playback level for speaking and stays closed when idle', () => {
    expect(mouthOpenness('speaking', 0.5, 1)).toBeCloseTo(0.7);
    expect(mouthOpenness('thinking', 1, 1)).toBe(0);
    expect(mouthOpenness('speaking', 0, 0)).toBe(0);
  });

  it('bounds invalid and out-of-range audio levels', () => {
    expect(clampAudioLevel(-1)).toBe(0);
    expect(clampAudioLevel(2)).toBe(1);
    expect(clampAudioLevel(Number.NaN)).toBe(0);
  });

  it('blinks briefly rather than holding the eyes closed', () => {
    expect(blinkAmount(0)).toBe(0);
    expect(blinkAmount(3.1)).toBeGreaterThan(0);
    expect(blinkAmount(3.1)).toBeLessThanOrEqual(1);
    expect(blinkAmount(3.5)).toBe(0);
  });
});
