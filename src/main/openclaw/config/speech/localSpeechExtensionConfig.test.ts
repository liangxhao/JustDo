import { beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultLocalSpeechSettings } from '../../../../shared/speech/localSpeechSettings';
import {
  buildLocalSpeechExtensionSttConfig,
  buildLocalSpeechExtensionTtsConfig,
  mergeLocalSpeechExtensionTtsConfig,
} from './localSpeechExtensionConfig';
import { buildManagedLocalSttConfig } from './localSttConfig';
import { buildManagedLocalTtsConfig } from './localTtsConfig';

vi.mock('./localSttConfig', () => ({ buildManagedLocalSttConfig: vi.fn() }));
vi.mock('./localTtsConfig', () => ({ buildManagedLocalTtsConfig: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

describe('extension speech model projection', () => {
  it('prepares STT from its own selection while microphone input stays off', () => {
    buildLocalSpeechExtensionSttConfig({ sttModelId: 'sherpa-onnx-whisper-base' }, 'en');
    expect(buildManagedLocalSttConfig).toHaveBeenCalledWith({
      ...defaultLocalSpeechSettings, asrModelId: 'sherpa-onnx-whisper-base',
    }, 'en');
  });

  it('prepares TTS without a reply-reading switch and uses a valid voice for its model', () => {
    buildLocalSpeechExtensionTtsConfig({ ttsModelId: 'vits-icefall-zh-aishell3' });
    expect(buildManagedLocalTtsConfig).toHaveBeenCalledWith(undefined, expect.objectContaining({
      outputEnabled: true, synthesisMode: 'local', ttsModelId: 'vits-icefall-zh-aishell3', voiceId: 0,
    }));
  });

  it('projects the extension voice rather than the reply-reading default', () => {
    buildLocalSpeechExtensionTtsConfig({ ttsModelId: 'kokoro-int8-multi-lang-v1_1', ttsVoiceId: 102 });
    expect(buildManagedLocalTtsConfig).toHaveBeenCalledWith(undefined, expect.objectContaining({
      outputEnabled: true, synthesisMode: 'local', ttsModelId: 'kokoro-int8-multi-lang-v1_1', voiceId: 102,
    }));
  });

  const local = { providers: { 'tts-local-cli': { command: 'extension.exe' } } };

  it('makes the prepared local tool available even when reply reading is off', () => {
    const existing = { auto: 'off', providers: { 'tts-local-cli': { command: 'voice.exe' } } };
    expect(mergeLocalSpeechExtensionTtsConfig(existing, local)).toMatchObject({
      auto: 'off', provider: 'tts-local-cli', providers: local.providers,
    });
    expect(existing.providers['tts-local-cli'].command).toBe('voice.exe');
  });

  it.each(['off', 'always'])('preserves the online default with native auto mode %s', auto => {
    expect(mergeLocalSpeechExtensionTtsConfig({
      provider: 'openai', auto, providers: { openai: { model: 'online' } },
    }, local)).toEqual({
      provider: 'openai', auto,
      providers: { openai: { model: 'online' }, ...local.providers },
    });
  });

  it('removes stale local parameters when the independently selected model is missing', () => {
    expect(mergeLocalSpeechExtensionTtsConfig({
      auto: 'always', provider: 'tts-local-cli', providers: { ...local.providers, openai: {} },
    }, null)).toEqual({ auto: 'off', provider: 'tts-local-cli', providers: { openai: {} } });
    expect(mergeLocalSpeechExtensionTtsConfig(undefined, null)).toBeNull();
  });
});
