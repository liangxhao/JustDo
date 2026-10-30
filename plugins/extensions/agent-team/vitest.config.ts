import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const sqliteModule = process.env.APP_PLUGIN_TEST_SQLITE_MODULE;
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: sqliteModule ? { alias: [{ find: /^better-sqlite3$/u, replacement: sqliteModule }] } : {},
  test: {
    include: ['{app,host,tests}/**/*.test.{ts,tsx}'],
    exclude: ['tests/host/**'],
    setupFiles: ['tests/setup.ts'],
    env: { APP_PLUGIN_HOST_ROOT: '' },
    environment: 'node',
    maxWorkers: 2,
  },
});
