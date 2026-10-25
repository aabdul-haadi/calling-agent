/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  envDir: resolve(__dirname, '..'),
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
  server: { port: 5173, warmup: { clientFiles: ['./src/main.tsx', './src/App.tsx', './src/pages/overview.tsx'] } },
  optimizeDeps: { include: ['react', 'react-dom/client', 'react-router-dom', 'lucide-react', 'framer-motion'] },
  build: {
    target: 'es2022',
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\/](react|react-dom|react-router|react-router-dom|scheduler)[\/]/, priority: 20 },
            { name: 'vendor', test: /node_modules/, priority: 10 },
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
