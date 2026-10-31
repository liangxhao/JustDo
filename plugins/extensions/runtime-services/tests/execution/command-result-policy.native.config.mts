import path from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: path.resolve(import.meta.dirname, '../../../../..'),
  test: {
    include: ['plugins/extensions/runtime-services/tests/execution/command-result-policy.native.test.ts'],
    environment: 'node',
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
