import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { LOCAL_ASR_DEFAULT_MODEL_ID } from '../../../../shared/speech/localAsr';
import { defaultLocalSpeechSettings } from '../../../../shared/speech/localSpeechSettings';
import { LOCAL_TTS_MODEL_ID, LOCAL_TTS_PROVIDER_ID } from '../../../../shared/speech/localTts';
import {
  buildManagedLocalTtsConfig,
  getLocalTtsStatus,
  type LocalTtsAssetPaths,
} from './localTtsConfig';

const temporaryRoots: string[] = [];

function createAssetPaths(): LocalTtsAssetPaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-local-tts-'));
  temporaryRoots.push(root);
  return {
    executablePath: path.join(root, 'runtime', 'bin', 'sherpa-onnx-offline-tts.exe'),
    modelDir: path.join(root, LOCAL_TTS_MODEL_ID),
  };
}

function prepareAssets(paths: LocalTtsAssetPaths): void {
  fs.mkdirSync(path.dirname(paths.executablePath), { recursive: true });
  fs.mkdirSync(path.join(paths.modelDir, 'espeak-ng-data'), { recursive: true });
  fs.writeFileSync(paths.executablePath, 'runtime');
  for (const file of [
    'model.int8.onnx',
    'voices.bin',
    'tokens.txt',
    'lexicon-us-en.txt',
    'lexicon-zh.txt',
    'phone-zh.fst',
    'date-zh.fst',
    'number-zh.fst',
  ]) {
    fs.writeFileSync(path.join(paths.modelDir, file), file);
  }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('local TTS OpenClaw configuration', () => {
  it('does not expose an incomplete local runtime', () => {
    const paths = createAssetPaths();

    expect(getLocalTtsStatus(paths).available).toBe(false);
    expect(buildManagedLocalTtsConfig(paths)).toBeNull();
  });

  it('builds a pinned offline Kokoro CLI provider for complete assets', () => {
    const paths = createAssetPaths();
    prepareAssets(paths);

    expect(getLocalTtsStatus(paths)).toMatchObject({
      available: true,
      supported: true,
      modelId: LOCAL_TTS_MODEL_ID,
    });
    expect(
      buildManagedLocalTtsConfig(paths, {
        ...defaultLocalSpeechSettings,
        outputEnabled: true,
      }),
    ).toMatchObject({
      auto: 'off',
      provider: LOCAL_TTS_PROVIDER_ID,
      providers: {
        [LOCAL_TTS_PROVIDER_ID]: {
          command: paths.executablePath,
          outputFormat: 'wav',
          args: expect.arrayContaining([
            '--sid=3',
            '--num-threads=2',
            '--kokoro-length-scale=1',
            '--output-filename={{OutputPath}}',
            '{{Text}}',
          ]),
        },
      },
    });
  });

  it('maps user-selected voice performance settings to CLI arguments', () => {
    const paths = createAssetPaths();
    prepareAssets(paths);

    const config = buildManagedLocalTtsConfig(paths, {
      inputEnabled: true,
      asrModelId: LOCAL_ASR_DEFAULT_MODEL_ID,
      inputLanguage: 'app',
      maxRecordingSeconds: 60,
      recognitionThreads: 2,
      outputEnabled: true,
      ttsModelId: LOCAL_TTS_MODEL_ID,
      voiceId: 58,
      speechRate: 1.2,
      synthesisThreads: 4,
    }) as { providers: Record<string, { args: string[] }> };

    expect(config.providers[LOCAL_TTS_PROVIDER_ID]?.args).toEqual(
      expect.arrayContaining([
        '--sid=58',
        '--num-threads=4',
        '--kokoro-length-scale=0.8333',
      ]),
    );
  });

  it.each([6, 102])('emits the exact formerly hidden Kokoro speaker %s in native CLI arguments', voiceId => {
    const paths = createAssetPaths();
    prepareAssets(paths);
    const config = buildManagedLocalTtsConfig(paths, {
      ...defaultLocalSpeechSettings,
      outputEnabled: true,
      voiceId,
    }) as { providers: Record<string, { args: string[] }> };

    expect(config.providers[LOCAL_TTS_PROVIDER_ID].args.filter(arg => arg.startsWith('--sid='))).toEqual([
      `--sid=${voiceId}`,
    ]);
  });

  it('removes the managed provider when reply reading is disabled', () => {
    const paths = createAssetPaths();
    prepareAssets(paths);

    expect(
      buildManagedLocalTtsConfig(paths, {
        inputEnabled: true,
        asrModelId: LOCAL_ASR_DEFAULT_MODEL_ID,
        inputLanguage: 'app',
        maxRecordingSeconds: 60,
        recognitionThreads: 2,
        outputEnabled: false,
        ttsModelId: LOCAL_TTS_MODEL_ID,
        voiceId: 3,
        speechRate: 1,
        synthesisThreads: 2,
      }),
    ).toBeNull();
  });

  it('does not expose the local provider in online synthesis mode', () => {
    const paths = createAssetPaths();
    prepareAssets(paths);

    expect(
      buildManagedLocalTtsConfig(paths, {
        ...defaultLocalSpeechSettings,
        outputEnabled: true,
        synthesisMode: 'online',
      }),
    ).toBeNull();
  });
});
