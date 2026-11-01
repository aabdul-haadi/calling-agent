import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canPreload,
  clearAvatarPreloads,
  fetchAvatarBytes,
  preloadAvatar,
  preloadWhenIdle,
} from '@/avatar/preload';

const bytes = new ArrayBuffer(8);
const ok = () => Promise.resolve(new Response(bytes, { status: 200 }));

function setConnection(value: { saveData?: boolean; effectiveType?: string } | undefined) {
  Object.defineProperty(navigator, 'connection', { configurable: true, value });
}

describe('avatar preloading', () => {
  beforeEach(() => {
    clearAvatarPreloads();
    setConnection(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('downloads a model once however many scenes or links ask for it', async () => {
    const fetchSpy = vi.fn(ok);
    vi.stubGlobal('fetch', fetchSpy);
    const [a, b] = await Promise.all([
      fetchAvatarBytes('/avatars/ava.vrm'),
      fetchAvatarBytes('/avatars/ava.vrm'),
    ]);
    expect(a).toBe(b);
    await fetchAvatarBytes('/avatars/ava.vrm');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not remember a failed download, so the next attempt tries again', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(new Response('nope', { status: 500 }))
      .mockImplementation(ok);
    vi.stubGlobal('fetch', fetchSpy);
    await expect(fetchAvatarBytes('/avatars/ava.vrm')).rejects.toThrow(/could not be downloaded/);
    await expect(fetchAvatarBytes('/avatars/ava.vrm')).resolves.toBeInstanceOf(ArrayBuffer);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("starts the right company's model and portrait, and ignores a company with no character", async () => {
    const fetchSpy = vi.fn(ok);
    vi.stubGlobal('fetch', fetchSpy);
    preloadAvatar('novatel');
    preloadAvatar('novatel');
    preloadAvatar('unknown-company');
    preloadAvatar(undefined);
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith('/avatars/nia.vrm');
  });

  it('never downloads on data-saver or a 2G connection', () => {
    const fetchSpy = vi.fn(ok);
    vi.stubGlobal('fetch', fetchSpy);
    setConnection({ saveData: true });
    expect(canPreload()).toBe(false);
    preloadAvatar('skylink-air');
    setConnection({ effectiveType: 'slow-2g' });
    expect(canPreload()).toBe(false);
    setConnection({ effectiveType: '2g' });
    preloadAvatar('skylink-air');
    expect(fetchSpy).not.toHaveBeenCalled();
    setConnection({ effectiveType: '4g' });
    expect(canPreload()).toBe(true);
  });

  it('waits until the browser is idle, and cancelling stops it', () => {
    const fetchSpy = vi.fn(ok);
    vi.stubGlobal('fetch', fetchSpy);
    let idle: (() => void) | undefined;
    const cancel = vi.fn();
    vi.stubGlobal('requestIdleCallback', (cb: () => void) => {
      idle = cb;
      return 7;
    });
    vi.stubGlobal('cancelIdleCallback', cancel);
    const stop = preloadWhenIdle('skylink-air');
    expect(fetchSpy).not.toHaveBeenCalled();
    idle?.();
    expect(fetchSpy).toHaveBeenCalledWith('/avatars/ava.vrm');
    stop();
    expect(cancel).toHaveBeenCalledWith(7);
  });

  it('falls back to a short timer where idle callbacks do not exist, and can be cancelled', () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn(ok);
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('requestIdleCallback', undefined);
    const stop = preloadWhenIdle('skylink-air');
    stop();
    vi.advanceTimersByTime(2000);
    expect(fetchSpy).not.toHaveBeenCalled();
    preloadWhenIdle('skylink-air');
    vi.advanceTimersByTime(1000);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});
