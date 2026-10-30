import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    include: ['{app,host,tests}/**/*.test.{ts,tsx}'],
    exclude: ['tests/host/**'],
    setupFiles: ['tests/setup.ts'],
    env: { APP_PLUGIN_HOST_ROOT: '' },
    maxWorkers: 2,
    environment: 'node',
  },
});
