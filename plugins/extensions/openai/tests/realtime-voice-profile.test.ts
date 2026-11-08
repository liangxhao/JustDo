import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { expect, test } from 'vitest';

const runtimeRoot = path.resolve(
  process.env.OPENCLAW_TEST_NATIVE_RUNTIME_DIR ?? 'vendor/openclaw-runtime/current',
);
if (
  process.env.OPENCLAW_TEST_NATIVE_RUNTIME_DIR &&
  !existsSync(path.join(runtimeRoot, 'dist/plugin-sdk/realtime-voice.js'))
)
  throw new Error('The explicitly requested native voice runtime is unavailable.');
test.skipIf(!existsSync(path.join(runtimeRoot, 'dist/plugin-sdk/realtime-voice.js')))(
  'managed realtime voice uses the locked SDK and explicit local WebSocket contract without fallback',
  async () => {
    const buildRoot = path.join(process.cwd(), 'build');
    await fs.mkdir(buildRoot, { recursive: true });
    const fixture = await fs.mkdtemp(path.join(buildRoot, 'realtime-voice-contract-'));
    try {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          path.join(import.meta.dirname, 'realtime-voice-profile.native-probe.mjs'),
          process.cwd(),
          runtimeRoot,
          fixture,
        ],
        { cwd: process.cwd(), timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true },
      );
      expect(stdout).toContain('managed-realtime-voice-native-contract-ok');
    } finally {
      await fs.rm(fixture, { recursive: true, force: true });
    }
  },
  35000,
);
