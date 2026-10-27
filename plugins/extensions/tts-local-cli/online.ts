import type { SpeechSynthesisRequest } from 'openclaw/plugin-sdk/speech-core';

export type OnlineSpeechConfig = {
  mode: 'online';
  baseUrl: string;
  model: string;
  speakerVoice: string;
  apiKey: string;
};

export function readOnlineSpeechConfig(value: unknown): OnlineSpeechConfig {
  const input = value as Partial<OnlineSpeechConfig> | null;
  if (
    !input ||
    input.mode !== 'online' ||
    typeof input.baseUrl !== 'string' ||
    !input.baseUrl.trim() ||
    typeof input.model !== 'string' ||
    !input.model.trim() ||
    typeof input.speakerVoice !== 'string' ||
    !input.speakerVoice.trim()
  )
    throw new Error(
      'The selected online speech model is unavailable. Configure it in model settings.',
    );
  let url: URL;
  try {
    url = new URL(input.baseUrl);
  } catch {
    throw new Error('Invalid speech service URL.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid speech service URL.');
  if (input.apiKey !== undefined && typeof input.apiKey !== 'string')
    throw new Error('The speech service credential has not been resolved.');
  return {
    mode: 'online',
    baseUrl: url.toString().replace(/\/+$/, ''),
    model: input.model.trim(),
    speakerVoice: input.speakerVoice.trim(),
    apiKey: input.apiKey ?? '',
  };
}

export async function synthesizeOnlineSpeech(req: SpeechSynthesisRequest) {
  const config = readOnlineSpeechConfig(req.providerConfig);
  const { resolveProviderHttpRequestConfig, assertOkOrThrowHttpError, readProviderBinaryResponse } =
    await import('openclaw/plugin-sdk/provider-http');
  const { fetchWithSsrFGuard, ssrfPolicyFromHttpBaseUrlAllowedOrigin } =
    await import('openclaw/plugin-sdk/ssrf-runtime');
  const outputFormat = req.target === 'voice-note' ? 'opus' : 'mp3';
  const http = resolveProviderHttpRequestConfig({
    provider: 'openai',
    capability: 'audio',
    transport: 'http',
    baseUrl: config.baseUrl,
    defaultBaseUrl: config.baseUrl,
    defaultHeaders: {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
  });
  const { response, release } = await fetchWithSsrFGuard({
    url: `${http.baseUrl}/audio/speech`,
    init: {
      method: 'POST',
      headers: http.headers,
      body: JSON.stringify({
        model: config.model,
        voice: config.speakerVoice,
        input: req.text,
        response_format: outputFormat,
      }),
    },
    timeoutMs: req.timeoutMs,
    policy: ssrfPolicyFromHttpBaseUrlAllowedOrigin(config.baseUrl),
    dispatcherPolicy: http.dispatcherPolicy,
    mode: 'strict',
    maxRedirects: 0,
  });
  try {
    await assertOkOrThrowHttpError(response, 'Speech synthesis failed', {
      requestHeaders: http.headers,
    });
    const audioBuffer = await readProviderBinaryResponse(
      response,
      'Speech synthesis failed',
      'audio',
      { maxBytes: 50 * 1024 * 1024, requestHeaders: http.headers },
    );
    return {
      audioBuffer,
      outputFormat,
      fileExtension: outputFormat === 'opus' ? '.ogg' : '.mp3',
      voiceCompatible: outputFormat === 'opus',
    };
  } finally {
    await release();
  }
}
