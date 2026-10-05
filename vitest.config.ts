import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@adk\/shared$/, replacement: r('./shared/src/index.ts') },
      { find: /^@adk\/shared\/hmac$/, replacement: r('./shared/src/hmac.ts') },
      { find: /^@adk\/mock-services\/(.*)$/, replacement: r('./mock-services/src/') + '$1' },
      { find: /^@backend\/(.*)$/, replacement: r('./backend/src/') + '$1' },
      { find: /^@clients\/(.*)$/, replacement: r('./clients/') + '$1' },
    ],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
