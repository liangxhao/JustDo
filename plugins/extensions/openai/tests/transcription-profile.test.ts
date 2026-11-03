import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { expect, test } from 'vitest';

const repoRoot = process.cwd();
const runtimeRoot = path.resolve(
  process.env.OPENCLAW_TEST_NATIVE_RUNTIME_DIR ?? 'vendor/openclaw-runtime/current',
);
const prepared = existsSync(path.join(runtimeRoot, 'dist/plugin-sdk/realtime-transcription.js'));

test.skipIf(!prepared)('native transcription resolves its own declared credential profile without voice-call', async () => {
  const buildRoot = path.join(repoRoot, 'build');
  await fs.mkdir(buildRoot, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(buildRoot, 'transcription-contract-'));
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [
      path.join(import.meta.dirname, 'transcription-profile.native-probe.mjs'),
      repoRoot, runtimeRoot, fixture,
    ], { cwd: repoRoot, timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true });
    expect(stdout).toContain('managed-transcription-native-contract-ok');
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
}, 35_000);
