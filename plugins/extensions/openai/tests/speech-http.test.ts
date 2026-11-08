import { afterEach, describe, expect, it, vi } from 'vitest';

import { openaiTTS } from '../tts';

const http = vi.hoisted(() => ({ fetch: vi.fn(), release: vi.fn(), binary: vi.fn(), ok: vi.fn() }));
vi.mock('openclaw/plugin-sdk/secret-input', () => ({
  normalizeResolvedSecretInputString: ({ value }: { value: unknown }) =>
    typeof value === 'string' ? value : undefined,
}));
vi.mock('openclaw/plugin-sdk/provider-http', () => ({
  resolveProviderHttpRequestConfig: (input: { baseUrl: string; defaultHeaders: HeadersInit }) => ({
    baseUrl: input.baseUrl,
    headers: new Headers(input.defaultHeaders),
    dispatcherPolicy: 'managed-proxy',
  }),
  assertOkOrThrowHttpError: (...args: unknown[]) => http.ok(...args),
  readProviderBinaryResponse: (...args: unknown[]) => http.binary(...args),
}));
vi.mock('openclaw/plugin-sdk/ssrf-runtime', () => ({
  ssrfPolicyFromHttpBaseUrlAllowedOrigin: (baseUrl: string) => ({
    allowedOrigins: [new URL(baseUrl).origin],
  }),
  fetchWithSsrFGuard: (...args: unknown[]) => http.fetch(...args),
}));
const base = {
  text: 'read this',
  baseUrl: 'https://speech.intranet/deployment/v1',
  model: 'any/model',
  apiKey: '',
  timeoutMs: 5000,
  maxBytes: 16,
  responseFormat: 'wav' as const,
};
afterEach(() => vi.resetAllMocks());
function transport() {
  http.fetch.mockResolvedValue({ response: new Response(), release: http.release });
}

describe('speech HTTP protocol adapter', () => {
  it('sends one standard request to the exact configured origin without credentials or redirects', async () => {
    transport();
    http.binary.mockResolvedValue(Buffer.from([1, 2, 3]));
    expect(
      await openaiTTS({
        ...base,
        protocolId: 'openai-speech-http',
        voiceSelection: { kind: 'preset', voiceId: 'voice42' },
      }),
    ).toEqual(Buffer.from([1, 2, 3]));
    const sent = http.fetch.mock.calls[0][0];
    expect(sent).toMatchObject({
      url: `${base.baseUrl}/audio/speech`,
      maxRedirects: 0,
      mode: 'strict',
      dispatcherPolicy: 'managed-proxy',
      capture: false,
    });
    expect(sent.init.headers.has('Authorization')).toBe(false);
    expect(JSON.parse(sent.init.body)).toEqual({
      input: base.text,
      model: base.model,
      voice: 'voice42',
      response_format: 'wav',
    });
    expect(http.release).toHaveBeenCalledOnce();
  });

  it('rejects retired protocol fields and an unspecified voice before dispatch', async () => {
    for (const fields of [
      { protocolId: 'chat-audio-speech' },
      { compatibilityProfile: 'removed' },
      { protocolId: 'openai-speech-http', compatibilityProfile: undefined },
      { voiceSelection: { kind: 'service-default' } },
    ]) {
      const input = { ...base, voice: 'fixture', ...fields } as unknown as Parameters<
        typeof openaiTTS
      >[0];
      await expect(openaiTTS(input)).rejects.toThrow();
    }
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it('requires configured identifiers and never fills omitted model, voice or endpoint in legacy calls', async () => {
    for (const fields of [{ model: undefined }, { voice: undefined }, { baseUrl: undefined },
      { model: '\ncustom-model' }, { voice: 'custom-voice\n' }, { apiKey: { source: 'file', id: 'unresolved' } },
      { extraBody: { model: 'other-model', voice: 'other-voice' } }]) {
      await expect(openaiTTS({ ...base, voice: 'custom-voice', ...fields } as unknown as Parameters<typeof openaiTTS>[0])).rejects.toThrow();
    }
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it('passes generic instructions for arbitrary configured model names and keeps text line breaks', async () => {
    transport(); http.binary.mockResolvedValue(Buffer.from([1, 2, 3]));
    await openaiTTS({ ...base, voice: 'Custom Voice', text: 'First line\nSecond line', instructions: 'Calm' });
    expect(JSON.parse(http.fetch.mock.calls[0][0].init.body)).toMatchObject({
      model: 'any/model', voice: 'Custom Voice', instructions: 'Calm', input: 'First line\nSecond line',
    });
  });

  it('does not retry or accept empty or oversized audio responses', async () => {
    for (const audio of [Buffer.alloc(0), Buffer.alloc(base.maxBytes + 1)]) {
      transport();
      http.binary.mockResolvedValue(audio);
      await expect(openaiTTS({ ...base, voice: 'fixture' })).rejects.toThrow('audio');
      expect(http.fetch).toHaveBeenCalledOnce();
      expect(http.release).toHaveBeenCalledOnce();
      http.fetch.mockClear();
      http.release.mockClear();
    }
    transport();
    http.ok.mockRejectedValueOnce(new Error('service unavailable'));
    await expect(openaiTTS({ ...base, voice: 'fixture' })).rejects.toThrow(
      'Speech synthesis failed',
    );
    expect(http.fetch).toHaveBeenCalledOnce();
  });
});
