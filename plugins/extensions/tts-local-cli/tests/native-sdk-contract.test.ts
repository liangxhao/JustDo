import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const runtimeRoot =
  process.env.SPEECH_TEST_RUNTIME_ROOT ?? path.join(repoRoot, 'vendor/openclaw-runtime/current');
const prepared = existsSync(path.join(runtimeRoot, 'dist/plugin-sdk/tts-runtime.js'));
if (process.env.SPEECH_TEST_RUNTIME_ROOT && !prepared)
  throw new Error('Invalid supplied speech SDK runtime.');

describe.skipIf(!prepared)('locked native speech SDK contract', () => {
  it('registers the own provider and enforces strict persona and preferences through actual native synthesis', async () => {
    const buildRoot = path.join(repoRoot, 'build');
    await fs.mkdir(buildRoot, { recursive: true });
    const fixture = await fs.mkdtemp(path.join(buildRoot, 'speech-contract-'));
    try {
      const env = { ...process.env };
      for (const name of Object.keys(env)) {
        if (
          /^(?:OPENCLAW_DEBUG_PROXY_|OPENAI_|AZURE_OPENAI_)/i.test(name) ||
          /^(?:HTTP|HTTPS|ALL|NO)_PROXY$/i.test(name) ||
          /^(?:NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR)$/i.test(name)
        )
          delete env[name];
      }
      Object.assign(env, {
        OPENCLAW_DEBUG_PROXY_ENABLED: '0',
        OPENCLAW_DEBUG_PROXY_REQUIRE: '0',
        OPENAI_API_KEY: 'unrelated-environment-fixture',
      });
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [path.join(import.meta.dirname, 'native-sdk-contract.mjs'), repoRoot, runtimeRoot, fixture],
        { cwd: repoRoot, env, timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true },
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
        replyConfigurationAdmission: true,
        replyConfigurationIdSurvivesRedaction: true,
        loopbackHttpWire: {
          protocols: {
            'openai-transcription-http': true,
            'openai-speech-http': true,
          },
          realHttpRequests: 13,
          environmentCredentialNotUsed: true,
          strictMethodsPathsHeadersAndAudio: true,
          actualSpeechProviderAndToolDelegation: true,
          retiredFieldsHaveZeroDispatch: true,
          errorsAndOversizedStream: true,
          uploadedAsrAbortClosesSocket: true,
          ttsTimeoutClosesSocket: true,
          redirectOriginReceivesNothing: true,
        },
      });
    } finally {
      await fs.rm(fixture, { recursive: true, force: true });
    }
  }, 35_000);
});
