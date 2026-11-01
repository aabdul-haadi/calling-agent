/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const THREE_LIBS = /node_modules\/(three|@pixiv|@react-three)\//;

export default defineConfig({
  plugins: [react()],
  envDir: resolve(__dirname, '..'),
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
  server: { port: 5173, warmup: { clientFiles: ['./src/main.tsx', './src/App.tsx', './src/pages/overview.tsx'] } },
  optimizeDeps: { include: ['react', 'react-dom/client', 'react-router-dom', 'lucide-react', 'framer-motion', 'three', '@react-three/fiber', '@pixiv/three-vrm', 'three/examples/jsm/loaders/GLTFLoader.js'] },
  build: {
    target: 'es2022',
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\/](react|react-dom|react-router|react-router-dom|scheduler)[\/]/, priority: 20 },
            // The 3D libraries stay out of the shared chunk: only the lazy avatar scene needs them.
            { name: 'vendor', test: (id: string) => id.includes('node_modules') && !THREE_LIBS.test(id), priority: 10 },
          ],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    css: false,
  },
});
