import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { expect, test } from 'vitest';

const runtimeRoot = path.resolve(process.env.OPENCLAW_TEST_NATIVE_RUNTIME_DIR ?? 'vendor/openclaw-runtime/current');
const prepared = existsSync(path.join(runtimeRoot, 'dist/plugin-sdk/realtime-transcription-session.js')) &&
  existsSync(path.join(runtimeRoot, 'dist/plugin-sdk/realtime-voice.js'));

// An explicit integration runtime must never turn a missing dependency into a passing skip.
if (process.env.OPENCLAW_TEST_NATIVE_RUNTIME_DIR && !prepared) throw new Error('The requested native speech test runtime is unavailable.');

test.skipIf(!prepared).each(['openai-transcription-realtime', 'openai-voice-realtime'])(
  '%s exchanges real WebSocket frames with an isolated fake model service', async protocol => {
    const buildRoot = path.join(process.cwd(), 'build');
    await fs.mkdir(buildRoot, { recursive: true });
    const fixture = await fs.mkdtemp(path.join(buildRoot, 'speech-realtime-wire-'));
    if (path.dirname(path.resolve(fixture)) !== path.resolve(buildRoot)) throw new Error('Unexpected speech fixture cleanup path.');
    try {
      const { stdout } = await promisify(execFile)(process.execPath, [
        path.join(import.meta.dirname, 'speech-realtime-wire.native-probe.mjs'),
        process.cwd(), runtimeRoot, fixture, protocol,
      ], { cwd: process.cwd(), timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true });
      expect(stdout).toContain(`speech-realtime-wire-ok:${protocol}`);
    } finally {
      await fs.rm(fixture, { recursive: true, force: true });
    }
  }, 35_000,
);
