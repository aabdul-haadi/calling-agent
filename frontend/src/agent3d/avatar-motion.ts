import type { AgentMode } from './agent-state';

export function clampAudioLevel(level: number): number {
  return Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
}

export function mouthOpenness(mode: AgentMode, level: number, elapsedSeconds: number): number {
  if (mode !== 'speaking') return 0;
  const audio = clampAudioLevel(level);
  // No audio level means no mouth movement: nothing is invented without a signal.
  void elapsedSeconds;
  return audio > 0.02 ? Math.min(0.8, audio * 1.4) : 0;
}

export function blinkAmount(elapsedSeconds: number): number {
  const cycle = ((elapsedSeconds + 1.7) % 4.8 + 4.8) % 4.8;
  const blink = (at: number) => {
    const distance = Math.abs(cycle - at);
    return distance < 0.11 ? Math.sin((1 - distance / 0.11) * (Math.PI / 2)) : 0;
  };
  return Math.max(blink(0), blink(0.16));
}
