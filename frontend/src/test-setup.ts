import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

// Pages are code-split, so the first render of a page waits for its chunk to load.
configure({ asyncUtilTimeout: 5000 });

// jsdom lacks matchMedia; the theme hook reads it.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
