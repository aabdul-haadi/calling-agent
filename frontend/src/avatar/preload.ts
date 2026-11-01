import { avatarFor } from './avatar-config';

/**
 * Getting the agent on screen quickly. The 3D scene needs two things the first time: its code and
 * a ~10 MB model. Both are started early (while idle, or the moment someone points at a link that
 * leads to a voice or console page) so that opening the page only has to parse, not download.
 *
 * The model bytes are kept in memory rather than left to the HTTP cache, because a dev server or a
 * static host without cache headers would otherwise download them again.
 */

const models = new Map<string, Promise<ArrayBuffer>>();
const portraits = new Set<string>();
let sceneChunk: Promise<unknown> | undefined;

interface NetworkInformation {
  saveData?: boolean;
  effectiveType?: string;
}

/** Skip speculative downloads on data-saver and very slow connections. */
export function canPreload(): boolean {
  const c = (navigator as Navigator & { connection?: NetworkInformation }).connection;
  if (c?.saveData) return false;
  return !/(^|-)2g$/.test(c?.effectiveType ?? '');
}

/** The model's bytes, downloaded once and shared by every scene that asks. */
export function fetchAvatarBytes(url: string): Promise<ArrayBuffer> {
  let pending = models.get(url);
  if (!pending) {
    pending = fetch(url).then((res) => {
      if (!res.ok) throw new Error(`The avatar model could not be downloaded (${res.status}).`);
      return res.arrayBuffer();
    });
    models.set(url, pending);
    // A failed download must not be remembered, so the next attempt tries again.
    pending.catch(() => models.delete(url));
  }
  return pending;
}

/** Start loading the character for a tenant. Safe to call as often as you like. */
export function preloadAvatar(clientId: string | undefined): void {
  const config = clientId ? avatarFor(clientId) : undefined;
  if (!config || !canPreload() || typeof window === 'undefined') return;
  sceneChunk ??= import('./avatar-scene').catch(() => {
    sceneChunk = undefined;
  });
  fetchAvatarBytes(config.modelUrl).catch(() => undefined);
  if (!portraits.has(config.portraitUrl)) {
    portraits.add(config.portraitUrl);
    new Image().src = config.portraitUrl;
  }
}

/** Preload once the page has settled, so it never competes with what the user is looking at. */
export function preloadWhenIdle(clientId: string | undefined, timeoutMs = 2500): () => void {
  if (!clientId || typeof window === 'undefined') return () => undefined;
  const run = () => preloadAvatar(clientId);
  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(run, { timeout: timeoutMs });
    return () => window.cancelIdleCallback(handle);
  }
  const timer = window.setTimeout(run, 800);
  return () => window.clearTimeout(timer);
}

/** Forget everything (tests, or after the user signs out). */
export function clearAvatarPreloads(): void {
  models.clear();
  portraits.clear();
  sceneChunk = undefined;
}
