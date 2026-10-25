import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seconds, useResponseTimer } from '@/hooks/use-response-timer';

describe('response timer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('counts up while the agent works and freezes at the first sound', () => {
    const { result, rerender } = renderHook(({ s }) => useResponseTimer(s), { initialProps: { s: 'listening' } });
    expect(result.current.liveMs).toBeUndefined();
    rerender({ s: 'thinking' });
    act(() => void vi.advanceTimersByTime(1500));
    expect(result.current.running).toBe(true);
    expect(seconds(result.current.liveMs!)).toBe('1.5 s');
    rerender({ s: 'speaking' });
    expect(result.current.running).toBe(false);
    expect(seconds(result.current.liveMs!)).toBe('1.5 s');
    act(() => void vi.advanceTimersByTime(3000));
    expect(seconds(result.current.liveMs!)).toBe('1.5 s');
    expect(result.current.history).toHaveLength(1);
  });

  it('keeps searching and tool steps inside one timing, and drops an interrupted turn', () => {
    const { result, rerender } = renderHook(({ s }) => useResponseTimer(s), { initialProps: { s: 'thinking' } });
    act(() => void vi.advanceTimersByTime(500));
    rerender({ s: 'searching_policy' });
    act(() => void vi.advanceTimersByTime(500));
    rerender({ s: 'executing_tool' });
    act(() => void vi.advanceTimersByTime(500));
    rerender({ s: 'interrupted' });
    expect(result.current.liveMs).toBeUndefined();
    expect(result.current.history).toHaveLength(0);
  });
});
