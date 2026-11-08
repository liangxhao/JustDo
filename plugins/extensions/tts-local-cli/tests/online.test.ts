import { afterEach, describe, expect, it, vi } from 'vitest';

import { readOnlineSpeechConfig, synthesizeOnlineSpeech } from '../online';

const native = vi.hoisted(() => ({ get: vi.fn(), configured: vi.fn(), synthesize: vi.fn() }));
vi.mock('openclaw/plugin-sdk/speech-core', () => ({
  getSpeechProvider: (...args: unknown[]) => native.get(...args),
}));
const config = {
  mode: 'online',
  baseUrl: 'https://speech.intranet/v1',
  model: 'company-tts',
  speakerVoice: 'voice-42',
};
const request = () => ({
  text: 'read this',
  providerConfig: config,
  cfg: {},
  timeoutMs: 5000,
  target: 'audio-file' as const,
});
afterEach(() => vi.resetAllMocks());
function adapter() {
  native.configured.mockReturnValue(true);
  native.get.mockReturnValue({
    id: 'openai',
    isConfigured: native.configured,
    synthesize: native.synthesize,
  });
  native.synthesize.mockResolvedValue({
    audioBuffer: Buffer.from('audio'),
    outputFormat: 'mp3',
    fileExtension: '.mp3',
    voiceCompatible: false,
  });
}

describe('configured online tool speech', () => {
  it('requires an explicit endpoint/model/voice and resolved key', () => {
    expect(readOnlineSpeechConfig(config).apiKey).toBe('');
    for (const value of [
      { mode: 'online' },
      { ...config, model: '' },
      { ...config, speakerVoice: '' },
      { ...config, voicePolicy: null },
      { ...config, baseUrl: 'http://host/?key=secret' },
      { ...config, apiKey: { source: 'file' } },
      { ...config, protocolId: 'chat-audio-speech' },
    ])
      expect(() => readOnlineSpeechConfig(value)).toThrow();
  });
  it('delegates through the public native registry with isolated tool settings', async () => {
    adapter();
    expect(await synthesizeOnlineSpeech(request())).toMatchObject({ outputFormat: 'mp3' });
    expect(native.get).toHaveBeenCalledWith('openai', {});
    expect(native.synthesize).toHaveBeenCalledOnce();
    expect(native.synthesize.mock.calls[0][0]).toMatchObject({
      ...request(),
      providerConfig: {
        ...config,
        protocolId: 'openai-speech-http',
        voicePolicy: 'preset',
        voiceSelection: { kind: 'preset', voiceId: 'voice-42' },
        apiKey: '',
      },
    });
  });
  it('does not delegate without an explicit model, endpoint, voice or resolved credential', async () => {
    adapter();
    for (const fields of [
      { model: undefined },
      { model: '\ncustom-model' },
      { baseUrl: undefined },
      { speakerVoice: undefined },
      { speakerVoice: '\ncustom-voice' },
      { apiKey: { source: 'file' } },
    ]) {
      await expect(
        synthesizeOnlineSpeech({
          ...request(),
          providerConfig: { ...config, ...fields },
        }),
      ).rejects.toThrow();
    }
    expect(native.get).not.toHaveBeenCalled();
    expect(native.synthesize).not.toHaveBeenCalled();
  });
  it('rejects retired fields and default voice selection before native delegation', async () => {
    adapter();
    for (const fields of [
      { protocolId: 'chat-audio-speech' },
      { compatibilityProfile: 'removed' },
      { protocolId: 'openai-speech-http', compatibilityProfile: undefined },
      { voiceSelection: { kind: 'service-default' } },
    ]) {
      const providerConfig = { ...config, ...fields };
      expect(() => readOnlineSpeechConfig(providerConfig)).toThrow();
      await expect(synthesizeOnlineSpeech({ ...request(), providerConfig })).rejects.toThrow();
    }
    expect(native.get).not.toHaveBeenCalled();
    expect(native.synthesize).not.toHaveBeenCalled();
  });
  it('refuses unavailable adapters without fallback', async () => {
    adapter();
    native.get.mockReturnValueOnce(undefined);
    await expect(synthesizeOnlineSpeech(request())).rejects.toThrow('unavailable');
    expect(native.synthesize).not.toHaveBeenCalled();
    native.synthesize.mockRejectedValueOnce(new Error('synthesis rejected'));
    await expect(synthesizeOnlineSpeech(request())).rejects.toThrow('rejected');
    expect(native.synthesize).toHaveBeenCalledOnce();
  });
});
