import fs from 'node:fs/promises';
import path from 'node:path';

import { MAX_AUDIO_BYTES, transcribeAudioSegments, type TranscriptionOptions } from './transcribe';

/** Snapshot the admitted file through the native root boundary before any remote upload. */
export async function stageOnlineInput(
  source: string,
  target: string,
  permittedRoot: string,
  signal: AbortSignal,
) {
  const { root } = await import('openclaw/plugin-sdk/file-access-runtime');
  signal.throwIfAborted();
  const boundary = await root(permittedRoot);
  const opened = await boundary.read(path.relative(permittedRoot, source), {
    maxBytes: MAX_AUDIO_BYTES,
    hardlinks: 'reject',
    symlinks: 'reject',
  });
  signal.throwIfAborted();
  await fs.writeFile(target, opened.buffer, { signal, flag: 'wx' });
}

export type OnlineTranscriptionConfig = {
  mode: 'online';
  baseUrl: string;
  model: string;
  apiKey: string;
  language: string;
};

export function readOnlineConfig(value: unknown): OnlineTranscriptionConfig {
  const input = value as Partial<OnlineTranscriptionConfig> | null;
  if (
    !input ||
    input.mode !== 'online' ||
    typeof input.baseUrl !== 'string' ||
    !input.baseUrl.trim() ||
    typeof input.model !== 'string' ||
    !input.model.trim() ||
    typeof input.language !== 'string' ||
    !['auto', 'zh', 'en', 'ja', 'ko', 'yue'].includes(input.language)
  ) {
    throw new Error(
      'The selected online transcription model is unavailable. Configure it in model settings.',
    );
  }
  let url: URL;
  try {
    url = new URL(input.baseUrl);
  } catch {
    throw new Error('Invalid transcription service URL.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid transcription service URL.');
  if (input.apiKey !== undefined && typeof input.apiKey !== 'string')
    throw new Error('The transcription service credential has not been resolved.');
  return {
    mode: 'online',
    baseUrl: url.toString().replace(/\/+$/, ''),
    model: input.model.trim(),
    apiKey: input.apiKey ?? '',
    language: input.language,
  };
}

export type OnlineTranscriptionRequest = {
  buffer: Buffer;
  config: OnlineTranscriptionConfig;
  signal: AbortSignal;
  assertCurrent?: () => void;
};

/** One bounded upload, with native multipart, HTTP policy, response and redaction helpers. */
export async function requestOnlineTranscription({
  buffer,
  config,
  signal,
  assertCurrent,
}: OnlineTranscriptionRequest): Promise<string> {
  const {
    buildAudioTranscriptionFormData,
    resolveProviderHttpRequestConfig,
    assertOkOrThrowHttpError,
    readProviderJsonObjectResponse,
    requireTranscriptionText,
  } = await import('openclaw/plugin-sdk/provider-http');
  const { fetchWithSsrFGuard, ssrfPolicyFromHttpBaseUrlAllowedOrigin } =
    await import('openclaw/plugin-sdk/ssrf-runtime');
  signal.throwIfAborted();
  assertCurrent?.();
  const http = resolveProviderHttpRequestConfig({
    provider: 'openai',
    capability: 'audio',
    transport: 'media-understanding',
    baseUrl: config.baseUrl,
    defaultBaseUrl: config.baseUrl,
    defaultHeaders: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
  });
  const body = buildAudioTranscriptionFormData({
    buffer,
    fileName: 'audio.wav',
    mime: 'audio/wav',
    fields: {
      model: config.model,
      language: config.language === 'auto' ? undefined : config.language,
    },
  });
  const { response, release } = await fetchWithSsrFGuard({
    url: `${http.baseUrl}/audio/transcriptions`,
    init: { method: 'POST', headers: http.headers, body, signal },
    timeoutMs: 120_000,
    policy: ssrfPolicyFromHttpBaseUrlAllowedOrigin(config.baseUrl),
    dispatcherPolicy: http.dispatcherPolicy,
    mode: 'strict',
    maxRedirects: 0,
    beforeRequest: () => {
      signal.throwIfAborted();
      assertCurrent?.();
    },
  });
  try {
    await assertOkOrThrowHttpError(response, 'Audio transcription failed', {
      requestHeaders: http.headers,
    });
    const result = await readProviderJsonObjectResponse(response, 'Audio transcription failed', {
      requestHeaders: http.headers,
    });
    signal.throwIfAborted();
    assertCurrent?.();
    return requireTranscriptionText(
      typeof result.text === 'string' ? result.text : undefined,
      'No speech was recognized.',
    );
  } finally {
    await release();
  }
}

export function transcribeOnlineFile(
  audioPath: string,
  config: OnlineTranscriptionConfig,
  options: TranscriptionOptions & { send?: typeof requestOnlineTranscription } = {},
) {
  return transcribeAudioSegments(
    audioPath,
    { modelId: config.model, language: config.language },
    async (segment, signal) => {
      // The decoder owns these 30-second PCM WAV segments; bound reads independently of input size.
      const stat = await fs.stat(segment);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024)
        throw new Error('Decoded audio segment exceeds the upload limit.');
      const buffer = await fs.readFile(segment, { signal });
      if (buffer.length > 2 * 1024 * 1024)
        throw new Error('Decoded audio segment exceeds the upload limit.');
      return (options.send ?? requestOnlineTranscription)({
        buffer,
        config,
        signal,
        assertCurrent: options.assertCurrent,
      });
    },
    { ...options, stageInput: stageOnlineInput },
  );
}
