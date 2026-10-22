import path from 'node:path';

import { defineConfig } from 'vitest/config';

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
    ],
    environment: 'node',
  },
});
