import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const runtimeRoot = path.join(repoRoot, 'vendor/openclaw-runtime/current');
const prepared = existsSync(path.join(runtimeRoot, 'dist/plugin-sdk/tts-runtime.js'));

describe.skipIf(!prepared)('locked native speech SDK contract', () => {
  it('registers the own provider and enforces strict persona and preferences through actual native synthesis', async () => {
    const buildRoot = path.join(repoRoot, 'build');
    await fs.mkdir(buildRoot, { recursive: true });
    const fixture = await fs.mkdtemp(path.join(buildRoot, 'speech-contract-'));
    try {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [path.join(import.meta.dirname, 'native-sdk-contract.mjs'), repoRoot, runtimeRoot, fixture],
        { cwd: repoRoot, timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true },
      );
      expect(JSON.parse(stdout)).toEqual({
        nativeVersion: '2026.10.7',
        fullConfigSchemaAndLegacyAdmission: true,
        rejectsRetiredPreferencesConfig: true,
        toolPreferencesFromEnvironment: true,
        registered: true,
        nativeAsrHttpAndAdmission: true,
        nativeAsrSnapshot: true,
        localCliPreserved: true,
        isolatedPreferences: true,
        onlineSuccess: true,
        failureHasNoFallback: true,
        disabledHasNoFallback: true,
        replyOwnModelAndVoice: true,
        replyIndependentOfCliEnable: true,
        replyMissingOpenAiHasNoFallback: true,
      });
    } finally {
      await fs.rm(fixture, { recursive: true, force: true });
    }
  }, 35_000);
});
