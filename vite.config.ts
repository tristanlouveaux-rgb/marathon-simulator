/// <reference types="vitest" />
import { defineConfig } from 'vite';
import { resolve } from 'path';

// Strip console.* and debugger statements from the production bundle. Source
// files are untouched and dev (vite serve) keeps logs for debugging. Errors
// still surface via uncaught exceptions and Apple App Store Connect crash
// reporting; explicit boundary logging can be added via guarded checks.
export default defineConfig(({ command }) => ({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  esbuild: command === 'build' ? { drop: ['console', 'debugger'] } : {},
  build: {
    target: 'ES2020',
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/main.ts', 'src/ui/**'],
    },
  },
}));
