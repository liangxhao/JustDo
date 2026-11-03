import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultLocalSpeechExtensionSettings } from '../../../../shared/speech/localSpeechExtensionSettings';
import { defaultLocalSpeechSettings } from '../../../../shared/speech/localSpeechSettings';
import { mergeOpenClawPluginConfig } from '../plugins/pluginProjection';
import {
  buildLocalSpeechExtensionSttConfig,
  buildLocalSpeechExtensionTtsConfig,
} from './localSpeechExtensionConfig';
import {
  applyManagedSpeechModelConfiguration,
  type ManagedSpeechModelSettings,
} from './speechModelConfig';

vi.mock('../models/providerSecretFile', () => ({ restrictCredentialFile: vi.fn() }));
vi.mock('./localSpeechExtensionConfig', () => ({
  buildLocalSpeechExtensionSttConfig: vi.fn(() => ({
    mode: 'local',
    command: 'local-stt',
    args: [],
  })),
  buildLocalSpeechExtensionTtsConfig: vi.fn(() => ({
    providers: { 'tts-local-cli': { command: 'local-tts', args: ['--sid=102'] } },
  })),
}));

const category = (id: string, key: string, voices?: string[]) => ({
  providers: {
    internal: {
      displayName: 'Internal',
      baseUrl: `https://${id}.internal/v1`,
      apiKey: key,
      models: [{ id, name: id, voices: voices?.map(id => ({ id, name: id })) }],
    },
  },
});
const settings = (): ManagedSpeechModelSettings => ({
  language: 'zh',
  extensions: {
    ...defaultLocalSpeechExtensionSettings,
    sttMode: 'online',
    onlineSttModelRef: 'internal/asr',
    ttsMode: 'online',
    onlineTtsModelRef: 'internal/tool',
    onlineTtsVoice: 'tool-voice',
  },
  voice: {
    ...defaultLocalSpeechSettings,
    outputEnabled: true,
    synthesisMode: 'online',
    onlineTtsModelRef: 'replyProvider/reply',
    onlineTtsVoice: 'reply-voice',
  },
  recognitionModels: category('asr', 'recognition-secret'),
  synthesisModels: {
    providers: {
      ...category('tool', 'tool-secret', ['tool-voice']).providers,
      replyProvider: { ...category('reply', 'reply-secret', ['reply-voice']).providers.internal },
    },
  },
});
const nativeConfig = (): Record<string, unknown> => ({
  plugins: {
    allow: ['runtime-services'],
    deny: ['stt-local-cli'],
    entries: {
      'stt-local-cli': { enabled: false, config: { command: 'stale-offline' } },
      'tts-local-cli': { enabled: false },
      'runtime-services': { enabled: true, config: { retained: true } },
    },
  },
  tts: {
    providers: { openai: { baseUrl: 'https://unrelated.internal/v1' } },
    personas: { custom: { provider: 'openai' } },
  },
});
const pluginConfig = (config: Record<string, unknown>, id: string) =>
  (config.plugins as { entries: Record<string, { config: Record<string, unknown> }> }).entries[id]
    .config;
const toolConfig = (config: Record<string, unknown>) =>
  (config.tts as { providers: Record<string, Record<string, unknown>> }).providers['tts-local-cli'];

describe('managed speech configuration', () => {
  let stateDir: string;
  beforeEach(() => {
    vi.clearAllMocks();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-config-'));
  });
  afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

  it('keeps the composer selection in the installed adapter through plugin cleanup and withdraws stale models', () => {
    const input = settings();
    input.voice = {
      ...defaultLocalSpeechSettings,
      inputEnabled: true,
      recognitionMode: 'online',
      onlineAsrModelRef: 'composer/input',
    };
    input.recognitionModels = {
      providers: {
        ...category('asr', 'recognition-secret').providers,
        composer: {
          ...category('input', 'input-secret').providers.internal,
          baseUrl: 'wss://input.internal/v1/realtime',
        },
      },
    };
    const config = nativeConfig();
    const entries = (config.plugins as { entries: Record<string, unknown> }).entries;
    entries.openai = { config: { personality: 'off' } };
    applyManagedSpeechModelConfiguration(config, input, stateDir);
    config.plugins = mergeOpenClawPluginConfig(config.plugins as Record<string, unknown>, {}, [], [
      'openai', 'runtime-services', 'stt-local-cli', 'tts-local-cli',
    ]);

    const profile = pluginConfig(config, 'openai').transcription as Record<string, unknown>;
    expect(profile).toMatchObject({
      baseUrl: 'wss://input.internal/v1/realtime',
      model: 'input',
      apiKey: { source: 'file' },
    });
    expect(pluginConfig(config, 'openai').personality).toBe('off');
    expect(pluginConfig(config, 'stt-local-cli').model).toBe('asr');
    expect(JSON.stringify(config)).not.toContain('input-secret');
    expect((config.plugins as { entries: Record<string, unknown> }).entries).not.toHaveProperty(
      'voice-call',
    );
    const originalReference = profile.apiKey;
    input.recognitionModels = {
      providers: {
        composer: {
          ...category('input', 'rotated-input-secret').providers.internal,
          baseUrl: 'wss://changed.internal/v1/realtime',
        },
      },
    };
    applyManagedSpeechModelConfiguration(config, input, stateDir);
    expect(
      (pluginConfig(config, 'openai').transcription as Record<string, unknown>).apiKey,
    ).not.toEqual(originalReference);

    input.recognitionModels = { providers: {} };
    applyManagedSpeechModelConfiguration(config, input, stateDir);
    expect(pluginConfig(config, 'openai').transcription).toBeNull();
  });

  it.each([{ inputEnabled: false }, { recognitionMode: 'local' }])(
    'withdraws the composer profile when input settings change: %j',
    patch => {
      const input = settings();
      input.voice = {
        ...defaultLocalSpeechSettings,
        inputEnabled: true,
        recognitionMode: 'online',
        onlineAsrModelRef: 'internal/asr',
      };
      const config = nativeConfig();
      applyManagedSpeechModelConfiguration(config, input, stateDir);
      expect(pluginConfig(config, 'openai').transcription).toMatchObject({ model: 'asr' });
      input.voice = { ...(input.voice as object), ...patch };
      applyManagedSpeechModelConfiguration(config, input, stateDir);
      expect(pluginConfig(config, 'openai').transcription).toBeNull();
    },
  );

  it('projects independent online tool and reply selections without requiring local assets or changing plugin admission', () => {
    const input = settings();
    const config = nativeConfig();
    expect(applyManagedSpeechModelConfiguration(config, input, stateDir)).toBe(true);
    expect(buildLocalSpeechExtensionSttConfig).not.toHaveBeenCalled();
    expect(buildLocalSpeechExtensionTtsConfig).not.toHaveBeenCalled();
    expect(pluginConfig(config, 'stt-local-cli')).toMatchObject({
      mode: 'online',
      baseUrl: 'https://asr.internal/v1',
      model: 'asr',
      language: 'zh',
    });
    expect(toolConfig(config)).toMatchObject({
      mode: 'online',
      model: 'tool',
      speakerVoice: 'tool-voice',
    });
    expect(pluginConfig(config, 'runtime-services')).toMatchObject({
      retained: true,
      replySpeech: { model: 'reply', speakerVoice: 'reply-voice' },
    });
    expect(config.plugins).toMatchObject({
      allow: ['runtime-services', 'openai'],
      deny: ['stt-local-cli'],
      entries: {
        'stt-local-cli': { enabled: false },
        'tts-local-cli': { enabled: false },
        openai: { enabled: true },
      },
    });
    expect(config.tts).toMatchObject({
      provider: 'tts-local-cli',
      persona: 'assistant-speech',
      personas: {
        'assistant-speech': {
          provider: 'tts-local-cli',
          fallbackPolicy: 'fail',
          providers: { 'tts-local-cli': toolConfig(config) },
        },
        custom: { provider: 'openai' },
      },
    });
    expect(JSON.stringify(config)).not.toMatch(/recognition-secret|tool-secret|reply-secret/);
    expect(config.tts).not.toHaveProperty('prefsPath');
    const stored = JSON.parse(
      fs.readFileSync(path.join(stateDir, 'extension-secrets.json'), 'utf8'),
    );
    expect(Object.values(stored)).toEqual(
      expect.arrayContaining(['recognition-secret', 'tool-secret', 'reply-secret']),
    );
    expect(applyManagedSpeechModelConfiguration(config, input, stateDir)).toBe(false);
  });

  it.each(['credential', 'endpoint'])(
    'uses immutable references so an unpublished %s change cannot mutate a published profile',
    change => {
      const input = settings();
      const published = nativeConfig();
      applyManagedSpeechModelConfiguration(published, input, stateDir);
      const originalRef = toolConfig(published).apiKey as { id: string };
      const changed = structuredClone(published);
      const updated = category('tool', change === 'credential' ? 'rotated-secret' : 'tool-secret', [
        'tool-voice',
      ]);
      if (change === 'endpoint') updated.providers.internal.baseUrl = 'https://changed.internal/v1';
      input.synthesisModels = updated;
      expect(applyManagedSpeechModelConfiguration(changed, input, stateDir)).toBe(true);
      expect(toolConfig(changed).apiKey).not.toEqual(originalRef);
      const stored = JSON.parse(
        fs.readFileSync(path.join(stateDir, 'extension-secrets.json'), 'utf8'),
      );
      expect(stored[originalRef.id.slice(1)]).toBe('tool-secret');
      const newRef = toolConfig(changed).apiKey as { id: string };
      expect(stored[newRef.id.slice(1)]).toBe(
        change === 'credential' ? 'rotated-secret' : 'tool-secret',
      );
    },
  );

  it('withdraws invalid online selections and websocket-only file models without falling back to local or retaining old parameters', () => {
    const config = nativeConfig();
    const input = settings();
    applyManagedSpeechModelConfiguration(config, input, stateDir);
    input.recognitionModels = {
      providers: {
        internal: {
          ...category('asr', '').providers.internal,
          baseUrl: 'wss://speech.internal/realtime',
        },
      },
    };
    input.synthesisModels = category('different', '', ['different-voice']);
    applyManagedSpeechModelConfiguration(config, input, stateDir);
    expect(pluginConfig(config, 'stt-local-cli')).toEqual({ mode: 'online', language: 'zh' });
    expect(toolConfig(config)).toEqual({ mode: 'online' });
    expect(pluginConfig(config, 'runtime-services').replySpeech).toBeNull();
    expect(buildLocalSpeechExtensionSttConfig).not.toHaveBeenCalled();
    expect(buildLocalSpeechExtensionTtsConfig).not.toHaveBeenCalled();
  });

  it('withdraws disabled reply reading without changing the assistant tool profile or saved selection', () => {
    const config = nativeConfig();
    const input = settings();
    applyManagedSpeechModelConfiguration(config, input, stateDir);
    const tool = structuredClone(toolConfig(config));
    input.voice = { ...(input.voice as object), outputEnabled: false };

    applyManagedSpeechModelConfiguration(config, input, stateDir);

    expect(pluginConfig(config, 'runtime-services').replySpeech).toBeNull();
    expect(toolConfig(config)).toEqual(tool);
    expect(input.voice).toMatchObject({
      onlineTtsModelRef: 'replyProvider/reply',
      onlineTtsVoice: 'reply-voice',
    });
    input.voice = { ...(input.voice as object), outputEnabled: true };
    applyManagedSpeechModelConfiguration(config, input, stateDir);
    expect(pluginConfig(config, 'runtime-services').replySpeech).toMatchObject({
      model: 'reply',
      speakerVoice: 'reply-voice',
    });
  });

  it('supports configured keyless internal services without a synthetic key', () => {
    const config = nativeConfig();
    const input = settings();
    input.recognitionModels = category('asr', '');
    input.synthesisModels = category('tool', '', ['tool-voice']);
    input.voice = {
      ...defaultLocalSpeechSettings,
      inputEnabled: true,
      recognitionMode: 'online',
      onlineAsrModelRef: 'internal/asr',
    };
    expect(applyManagedSpeechModelConfiguration(config, input, stateDir)).toBe(false);
    expect(toolConfig(config).apiKey).toBe('');
    expect(pluginConfig(config, 'stt-local-cli').apiKey).toBe('');
    expect(pluginConfig(config, 'openai').transcription).toMatchObject({ apiKey: '' });
    expect(fs.existsSync(path.join(stateDir, 'extension-secrets.json'))).toBe(false);
  });

  it('does not enable or disable the shared online adapter when reply reading is local or unavailable', () => {
    const config = nativeConfig();
    const plugins = config.plugins as { deny: string[]; entries: Record<string, unknown> };
    plugins.deny.push('openai');
    plugins.entries.openai = { enabled: false, config: { retained: true } };
    const input = settings();
    input.voice = { ...defaultLocalSpeechSettings, synthesisMode: 'local' };
    applyManagedSpeechModelConfiguration(config, input, stateDir);
    expect(config.plugins).toMatchObject({
      deny: ['stt-local-cli', 'openai'],
      entries: { openai: { enabled: false, config: { retained: true } } },
    });
    expect(pluginConfig(config, 'runtime-services').replySpeech).toBeNull();
    expect(toolConfig(config)).toMatchObject({ mode: 'online', model: 'tool' });
  });

  it('keeps the local model/voice CLI projection independent from online reply reading', () => {
    const config = nativeConfig();
    const input = settings();
    input.extensions = { ...defaultLocalSpeechExtensionSettings, ttsVoiceId: 102 };
    applyManagedSpeechModelConfiguration(config, input, stateDir);
    expect(buildLocalSpeechExtensionTtsConfig).toHaveBeenCalledWith(
      expect.objectContaining({ ttsVoiceId: 102, ttsMode: 'local' }),
    );
    expect(toolConfig(config)).toEqual({ command: 'local-tts', args: ['--sid=102'] });
    expect(pluginConfig(config, 'stt-local-cli')).toMatchObject({
      mode: 'local',
      command: 'local-stt',
    });
  });
});
