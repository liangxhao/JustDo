import path from 'node:path';

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { resolveExplicitTtsOverrides, synthesizeSpeech } from 'openclaw/plugin-sdk/tts-runtime';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SPEECH_SYNTHESIS_METHOD } from '../contracts/speech';
import { registerSpeechSynthesis } from '../speech';

vi.mock('openclaw/plugin-sdk/tts-runtime', () => ({
  synthesizeSpeech: vi.fn(),
  resolveExplicitTtsOverrides: vi.fn(() => ({ provider: 'openai' })),
}));
vi.mock('openclaw/plugin-sdk/secret-input', () => ({
  normalizeResolvedSecretInputString: ({ value }: { value: unknown }) => {
    if (value && typeof value !== 'string') throw new Error('Unresolved speech credential.');
    return typeof value === 'string' ? value : undefined;
  },
}));

const configurationId = 'a'.repeat(64);
const nextConfigurationId = 'b'.repeat(64);
const profile = () => ({
  configurationId,
  baseUrl: 'http://voice.internal/v1',
  model: 'reader-model',
  speakerVoice: 'reader-voice',
  apiKey: 'reader-key',
});
const audio = Buffer.from('RIFF test WAVE data');
const stateDir = path.resolve('runtime-state 语音');
const replyPreferencesPath = path.join(stateDir, 'speech-tools', 'reply-preferences.json');

function fixture() {
  const cfg = {
    tts: {
      provider: 'tts-local-cli',
      persona: 'assistant-speech',
      providers: { 'tts-local-cli': { mode: 'online', model: 'tool-model' } },
    },
    plugins: {
      entries: {
        'runtime-services': { config: { replySpeech: profile() } },
        'tts-local-cli': { enabled: false },
      },
    },
  };
  let handler: (request: Record<string, unknown>) => Promise<void>;
  const registerGatewayMethod = vi.fn((_name, callback) => {
    handler = callback;
  });
  const resolveStateDir = vi.fn(() => stateDir);
  registerSpeechSynthesis({
    registerGatewayMethod,
    runtime: { config: { current: () => cfg }, state: { resolveStateDir } },
  } as unknown as OpenClawPluginApi);
  const respond = vi.fn();
  return {
    cfg,
    respond,
    registerGatewayMethod,
    resolveStateDir,
    invoke: (params: unknown = { text: ' hello ', configurationId }, extra = {}) =>
      handler!({ params, respond, ...extra }),
  };
}

beforeEach(() => {
  vi.mocked(resolveExplicitTtsOverrides).mockReset().mockReturnValue({ provider: 'openai' });
  vi.mocked(synthesizeSpeech).mockReset().mockResolvedValue({
    success: true,
    audioBuffer: audio,
    provider: 'openai',
    fileExtension: '.wav',
    outputFormat: 'wav',
  });
});

describe('managed reply speech RPC', () => {
  it('uses the read-aloud profile through the public runtime with fallback disabled', async () => {
    const f = fixture();
    const original = structuredClone(f.cfg);
    await f.invoke();

    expect(f.registerGatewayMethod).toHaveBeenCalledWith(
      SPEECH_SYNTHESIS_METHOD,
      expect.any(Function),
      { scope: 'operator.write' },
    );
    expect(synthesizeSpeech).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'hello',
        disableFallback: true,
        overrides: { provider: 'openai' },
        cfg: expect.objectContaining({
          tts: expect.objectContaining({
            provider: 'openai',
            persona: 'reply-reading',
            personas: {
              'reply-reading': expect.objectContaining({
                provider: 'openai',
                fallbackPolicy: 'fail',
              }),
            },
            providers: {
              openai: expect.objectContaining({
                model: 'reader-model',
                speakerVoice: 'reader-voice',
                apiKey: 'reader-key',
              }),
            },
          }),
        }),
      }),
    );
    expect(f.resolveStateDir).toHaveBeenCalledOnce();
    expect(vi.mocked(synthesizeSpeech).mock.calls[0][0]).toMatchObject({
      prefsPath: replyPreferencesPath,
    });
    expect(vi.mocked(synthesizeSpeech).mock.calls[0][0].cfg.tts).not.toHaveProperty('prefsPath');
    expect(f.cfg).toEqual(original);
    expect(resolveExplicitTtsOverrides).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openai',
        modelId: 'reader-model',
        voiceId: 'reader-voice',
        prefsPath: replyPreferencesPath,
      }),
    );
    expect(f.respond).toHaveBeenCalledWith(true, {
      audioBase64: audio.toString('base64'),
      provider: 'openai',
      outputFormat: 'wav',
      fileExtension: 'wav',
      mimeType: 'audio/wav',
    });
  });

  it.each(['', 'relative-state'])(
    'rejects unavailable or nonabsolute state roots without borrowing tool preferences (%j)',
    async value => {
      const f = fixture();
      f.resolveStateDir.mockReturnValue(value);
      await f.invoke();
      expect(synthesizeSpeech).not.toHaveBeenCalled();
      expect(resolveExplicitTtsOverrides).not.toHaveBeenCalled();
      expect(f.respond.mock.calls[0]).toEqual([
        false,
        undefined,
        {
          code: 'UNAVAILABLE',
          message: 'Reply speech is unavailable. Check its model and voice settings.',
        },
      ]);
    },
  );

  it.each([
    { text: '', configurationId },
    { text: 'x'.repeat(10_001), configurationId },
    { text: 'hello', configurationId, baseUrl: 'http://other.invalid' },
    { text: 'hello', configurationId, model: 'another-model' },
    { text: 'hello' },
    { text: 'hello', configurationId: 'not-a-managed-profile' },
  ])('rejects arbitrary request targets and invalid text', async params => {
    const f = fixture();
    await f.invoke(params);
    expect(f.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: 'UNAVAILABLE' }),
    );
    expect(synthesizeSpeech).not.toHaveBeenCalled();
  });

  it('accepts an explicitly configured service without credentials', async () => {
    const f = fixture();
    f.cfg.plugins.entries['runtime-services'].config.replySpeech.apiKey = '';
    await f.invoke();
    expect(synthesizeSpeech).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: expect.objectContaining({
          tts: expect.objectContaining({
            providers: { openai: expect.objectContaining({ apiKey: '' }) },
          }),
        }),
      }),
    );
    expect(f.respond.mock.calls[0][0]).toBe(true);
  });

  it('rejects the requested profile until that exact configuration is native current', async () => {
    const f = fixture();
    const request = { text: 'selected reply', configurationId: nextConfigurationId };

    await f.invoke(request);

    expect(synthesizeSpeech).not.toHaveBeenCalled();
    expect(resolveExplicitTtsOverrides).not.toHaveBeenCalled();
    expect(f.respond.mock.calls[0][0]).toBe(false);

    Object.assign(f.cfg.plugins.entries['runtime-services'].config.replySpeech, {
      configurationId: nextConfigurationId,
      protocolId: 'openai-speech-http',
      model: 'next-reader-model',
      voicePolicy: 'preset',
      voiceSelection: { kind: 'preset', voiceId: 'next-reader-voice' },
      apiKey: '',
    });
    await f.invoke(request);

    expect(synthesizeSpeech).toHaveBeenCalledOnce();
    expect(resolveExplicitTtsOverrides).toHaveBeenCalledWith(
      expect.objectContaining({ voiceId: 'next-reader-voice' }),
    );
    expect(vi.mocked(synthesizeSpeech).mock.calls[0][0].cfg.tts?.providers).toEqual({
      openai: expect.objectContaining({
        model: 'next-reader-model',
        protocolId: 'openai-speech-http',
        voiceSelection: { kind: 'preset', voiceId: 'next-reader-voice' },
        apiKey: '',
      }),
    });
    expect(f.respond.mock.calls[1][0]).toBe(true);
  });

  it('does not delegate retired protocol fields or an unspecified voice', async () => {
    for (const fields of [
      { protocolId: 'chat-audio-speech' },
      { compatibilityProfile: 'removed' },
      { protocolId: 'openai-speech-http', compatibilityProfile: undefined },
      { voiceSelection: { kind: 'service-default' } },
    ]) {
      const f = fixture();
      Object.assign(f.cfg.plugins.entries['runtime-services'].config.replySpeech, fields);
      await f.invoke();
      expect(f.respond.mock.calls[0][0]).toBe(false);
    }
    expect(synthesizeSpeech).not.toHaveBeenCalled();
    expect(resolveExplicitTtsOverrides).not.toHaveBeenCalled();
  });
  it('does not delegate a profile missing its explicit model, endpoint or voice', async () => {
    for (const fields of [
      { model: undefined },
      { model: '\ncustom-model' },
      { baseUrl: undefined },
      { speakerVoice: undefined },
      { speakerVoice: '\ncustom-voice' },
    ]) {
      const f = fixture();
      Object.assign(f.cfg.plugins.entries['runtime-services'].config.replySpeech, fields);
      await f.invoke();
      expect(f.respond.mock.calls[0][0]).toBe(false);
    }
    expect(synthesizeSpeech).not.toHaveBeenCalled();
    expect(resolveExplicitTtsOverrides).not.toHaveBeenCalled();
  });

  it('does not invoke a provider when authority has been revoked', async () => {
    const f = fixture();
    await f.invoke(undefined, { hasCurrentClientAuthority: () => false });
    expect(synthesizeSpeech).not.toHaveBeenCalled();
    expect(f.respond.mock.calls[0][0]).toBe(false);
  });

  it('discards late output after the managed profile changes', async () => {
    const f = fixture();
    let finish!: (result: Awaited<ReturnType<typeof synthesizeSpeech>>) => void;
    vi.mocked(synthesizeSpeech).mockReturnValue(
      new Promise(resolve => {
        finish = resolve;
      }),
    );
    const pending = f.invoke();
    f.cfg.plugins.entries['runtime-services'].config.replySpeech.model = 'new-reader-model';
    finish({ success: true, provider: 'openai', audioBuffer: audio, fileExtension: '.wav' });
    await pending;
    expect(f.respond.mock.calls[0][0]).toBe(false);
  });

  it('does not replace a failed requested provider with the assistant tool provider', async () => {
    const f = fixture();
    vi.mocked(synthesizeSpeech).mockResolvedValue({
      success: false,
      error: 'private service response',
    });
    await f.invoke();
    expect(synthesizeSpeech).toHaveBeenCalledTimes(1);
    expect(f.respond.mock.calls[0]).toEqual([
      false,
      undefined,
      {
        code: 'UNAVAILABLE',
        message: 'Reply speech is unavailable. Check its model and voice settings.',
      },
    ]);
  });

  it('fails before synthesis when the explicitly requested adapter is unavailable', async () => {
    const f = fixture();
    vi.mocked(resolveExplicitTtsOverrides).mockImplementation(() => {
      throw new Error('Unknown TTS provider');
    });
    await f.invoke();
    expect(synthesizeSpeech).not.toHaveBeenCalled();
    expect(f.respond.mock.calls[0][0]).toBe(false);
  });
});
