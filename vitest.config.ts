import path from 'node:path';

import { defineConfig } from 'vitest/config';

if (process.versions.electron) {
  throw new Error('Vitest requires standalone Node.js 24. Electron drivers are disabled; run `npm test` with Node.js.');
}

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, './src/shared'),
      '@': path.resolve(__dirname, './src/renderer'),
    },
  },
  test: {
    // Native runtime cold starts and Windows process snapshots compete for resources.
    maxWorkers: 2,
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'tests/**/*.test.ts',
      'plugins/extensions/*/tests/**/*.test.ts',
      'plugins/browser-extensions/*/tests/**/*.test.ts',
    ],
    environment: 'node',
  },
});
