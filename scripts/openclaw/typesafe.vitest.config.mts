import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Offline native adapter contract tests against the prepared, version-locked host SDK.
const root = path.resolve(import.meta.dirname, '../..');
const runtime = process.env.OPENCLAW_RUNTIME
  ? path.resolve(process.env.OPENCLAW_RUNTIME)
  : path.join(root, 'vendor/openclaw-runtime/current');
if (!fs.existsSync(path.join(runtime, 'dist/plugin-sdk/ssrf-runtime.js'))) {
  throw new Error(
    'Prepare the OpenClaw runtime or set OPENCLAW_RUNTIME before running TypeSafe tests.',
  );
}
export default defineConfig({
  root,
  resolve: {
    alias: [
      {
        find: /^openclaw\/plugin-sdk\/(.+)$/,
        replacement: `${runtime.replaceAll('\\', '/')}/dist/plugin-sdk/$1.js`,
      },
    ],
  },
  test: {
    include: ['openclaw-extensions/typesafe/**/*.test.ts'],
    environment: 'node',
    maxWorkers: 1,
  },
});
