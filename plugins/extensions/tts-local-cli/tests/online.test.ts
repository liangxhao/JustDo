import { afterEach, describe, expect, it, vi } from 'vitest';

import { readOnlineSpeechConfig, synthesizeOnlineSpeech } from '../online';

const http = vi.hoisted(() => ({ fetch: vi.fn(), release: vi.fn(), read: vi.fn(), ok: vi.fn() }));
vi.mock('openclaw/plugin-sdk/provider-http', () => ({
  resolveProviderHttpRequestConfig: (input: { baseUrl: string; defaultHeaders: HeadersInit }) => ({
    baseUrl: input.baseUrl,
    headers: new Headers(input.defaultHeaders),
  }),
  assertOkOrThrowHttpError: (...args: unknown[]) => http.ok(...args),
  readProviderBinaryResponse: (...args: unknown[]) => http.read(...args),
}));
vi.mock('openclaw/plugin-sdk/ssrf-runtime', () => ({
  ssrfPolicyFromHttpBaseUrlAllowedOrigin: (baseUrl: string) => ({
    allowedOrigins: [new URL(baseUrl).origin],
  }),
  fetchWithSsrFGuard: (...args: unknown[]) => http.fetch(...args),
}));
const config = {
  mode: 'online',
  baseUrl: 'https://speech.intranet/v1',
  model: 'company-tts',
  speakerVoice: 'voice-42',
};
afterEach(() => {
  vi.clearAllMocks();
});
function request(target: 'audio-file' | 'voice-note' = 'audio-file') {
  return { text: 'read this', providerConfig: config, cfg: {}, timeoutMs: 5000, target };
}

describe('configured online speech', () => {
  it('requires an explicit endpoint/model/voice and resolved key', () => {
    expect(readOnlineSpeechConfig(config).apiKey).toBe('');
    for (const value of [
      { mode: 'online' },
      { ...config, model: '' },
      { ...config, speakerVoice: '' },
      { ...config, baseUrl: 'http://host/?key=secret' },
      { ...config, apiKey: { source: 'file' } },
    ])
      expect(() => readOnlineSpeechConfig(value)).toThrow();
  });
  it('sends the configured voice without requiring an API key and never follows redirects', async () => {
    http.fetch.mockResolvedValue({ response: new Response(), release: http.release });
    http.read.mockResolvedValue(Buffer.from('audio'));
    expect(await synthesizeOnlineSpeech(request())).toMatchObject({
      audioBuffer: Buffer.from('audio'),
      outputFormat: 'mp3',
      fileExtension: '.mp3',
      voiceCompatible: false,
    });
    const sent = http.fetch.mock.calls[0][0];
    expect(sent).toMatchObject({
      url: 'https://speech.intranet/v1/audio/speech',
      mode: 'strict',
      maxRedirects: 0,
      timeoutMs: 5000,
      policy: { allowedOrigins: ['https://speech.intranet'] },
    });
    expect(sent.init.headers.has('Authorization')).toBe(false);
    expect(JSON.parse(sent.init.body)).toEqual({
      model: 'company-tts',
      voice: 'voice-42',
      input: 'read this',
      response_format: 'mp3',
    });
    expect(http.read.mock.calls[0][3]).toMatchObject({ maxBytes: 50 * 1024 * 1024 });
    expect(http.release).toHaveBeenCalledOnce();
  });
  it('requests Opus for voice notes and releases errors without retry', async () => {
    http.fetch.mockResolvedValue({ response: new Response(), release: http.release });
    http.read.mockResolvedValue(Buffer.from('audio'));
    expect(await synthesizeOnlineSpeech(request('voice-note'))).toMatchObject({
      outputFormat: 'opus',
      fileExtension: '.ogg',
      voiceCompatible: true,
    });
    http.ok.mockRejectedValueOnce(new Error('unavailable'));
    await expect(synthesizeOnlineSpeech(request())).rejects.toThrow('unavailable');
    expect(http.fetch).toHaveBeenCalledTimes(2);
    expect(http.release).toHaveBeenCalledTimes(2);
  });
});
