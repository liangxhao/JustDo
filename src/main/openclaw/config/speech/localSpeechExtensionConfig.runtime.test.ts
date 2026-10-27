import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LOCAL_TTS_MODEL_ID, LOCAL_TTS_PROVIDER_ID } from '../../../../shared/speech/localTts';
import { buildLocalSpeechExtensionTtsConfig } from './localSpeechExtensionConfig';

const fixture = vi.hoisted(() => ({ root: '' }));

vi.mock('../../../speech/localSpeechPaths', () => ({
  isLocalSpeechRuntimeReady: () => true,
  resolveLocalSpeechRuntimeDir: () => path.join(fixture.root, 'runtime'),
  resolveLocalSpeechModelDir: (modelId: string) => path.join(fixture.root, modelId),
}));

beforeEach(() => {
  fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-provider-'));
  fs.mkdirSync(path.join(fixture.root, 'runtime', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(fixture.root, 'runtime', 'bin', 'sherpa-onnx-offline-tts.exe'), 'fixture');
  const modelDir = path.join(fixture.root, LOCAL_TTS_MODEL_ID);
  fs.mkdirSync(path.join(modelDir, 'espeak-ng-data'), { recursive: true });
  for (const file of [
    'model.int8.onnx', 'voices.bin', 'tokens.txt', 'lexicon-us-en.txt', 'lexicon-zh.txt',
    'phone-zh.fst', 'date-zh.fst', 'number-zh.fst',
  ]) {
    fs.writeFileSync(path.join(modelDir, file), 'fixture');
  }
  const aishellDir = path.join(fixture.root, 'vits-icefall-zh-aishell3');
  fs.mkdirSync(aishellDir, { recursive: true });
  for (const file of ['model.onnx', 'tokens.txt', 'lexicon.txt', 'phone.fst', 'date.fst', 'number.fst']) {
    fs.writeFileSync(path.join(aishellDir, file), 'fixture');
  }
});

afterEach(() => {
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

describe('extension selection to native CLI speech arguments', () => {
  it.each([6, 102])('uses selected Kokoro voice %s in the actual native provider', ttsVoiceId => {
    const config = buildLocalSpeechExtensionTtsConfig({ ttsModelId: LOCAL_TTS_MODEL_ID, ttsVoiceId }) as {
      providers: Record<string, { command: string; args: string[] }>;
    };
    const provider = config.providers[LOCAL_TTS_PROVIDER_ID];

    expect(provider.command).toBe(path.join(fixture.root, 'runtime', 'bin', 'sherpa-onnx-offline-tts.exe'));
    expect(provider.args.filter(arg => arg.startsWith('--sid='))).toEqual([`--sid=${ttsVoiceId}`]);
    expect(provider.args).toContain(`--kokoro-model=${path.join(fixture.root, LOCAL_TTS_MODEL_ID, 'model.int8.onnx')}`);
  });

  it('keeps the existing native default for a model-only legacy preference', () => {
    const config = buildLocalSpeechExtensionTtsConfig({ ttsModelId: LOCAL_TTS_MODEL_ID }) as {
      providers: Record<string, { args: string[] }>;
    };

    expect(config.providers[LOCAL_TTS_PROVIDER_ID].args).toContain('--sid=3');
  });

  it('emits the last AISHELL-3 voice together with the independently selected VITS model', () => {
    const config = buildLocalSpeechExtensionTtsConfig({
      ttsModelId: 'vits-icefall-zh-aishell3', ttsVoiceId: 173,
    }) as { providers: Record<string, { args: string[] }> };
    const args = config.providers[LOCAL_TTS_PROVIDER_ID].args;

    expect(args.filter(arg => arg.startsWith('--sid='))).toEqual(['--sid=173']);
    expect(args).toContain(`--vits-model=${path.join(fixture.root, 'vits-icefall-zh-aishell3', 'model.onnx')}`);
    expect(args.some(arg => arg.startsWith('--kokoro-model='))).toBe(false);
  });
});
