import fs from 'node:fs/promises';
import path from 'node:path';

import {
  buildTranscriptionRequest,
  normalizeSpeechServiceBaseUrl,
  parseTranscriptionResponse,
  resolveSpeechProtocolSelection,
  SPEECH_PROTOCOL_IDS,
  type SpeechProtocolSelection,
} from '../../sdk/speech-protocols/index.js';
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

export type OnlineTranscriptionConfig = SpeechProtocolSelection & {
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
    input.model.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(input.model) ||
    typeof input.language !== 'string' ||
    !['auto', 'zh', 'en', 'ja', 'ko', 'yue'].includes(input.language)
  ) {
    throw new Error(
      'The selected online transcription model is unavailable. Configure it in model settings.',
    );
  }
  const selection = resolveSpeechProtocolSelection(
    input,
    'transcription',
    SPEECH_PROTOCOL_IDS.TRANSCRIPTION_HTTP,
  );
  const baseUrl = normalizeSpeechServiceBaseUrl(input.baseUrl, selection);
  if (input.apiKey !== undefined && typeof input.apiKey !== 'string')
    throw new Error('The transcription service credential has not been resolved.');
  return {
    mode: 'online',
    ...selection,
    baseUrl,
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
  config: rawConfig,
  signal,
  assertCurrent,
}: OnlineTranscriptionRequest): Promise<string> {
  const config = readOnlineConfig(rawConfig);
  const {
    buildAudioTranscriptionFormData,
    resolveProviderHttpRequestConfig,
    assertOkOrThrowHttpError,
    readProviderJsonObjectResponse,
  } = await import('openclaw/plugin-sdk/provider-http');
  const { fetchWithSsrFGuard, ssrfPolicyFromHttpBaseUrlAllowedOrigin } =
    await import('openclaw/plugin-sdk/ssrf-runtime');
  signal.throwIfAborted();
  assertCurrent?.();
  const plan = buildTranscriptionRequest({
    selection: config,
    model: config.model,
    audio: buffer,
    language: config.language,
  });
  const http = resolveProviderHttpRequestConfig({
    provider: 'openai',
    capability: 'audio',
    transport: 'media-understanding',
    baseUrl: config.baseUrl,
    defaultBaseUrl: config.baseUrl,
    defaultHeaders: {
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
  });
  const body = buildAudioTranscriptionFormData({
    buffer: Buffer.from(plan.file.bytes),
    fileName: plan.file.fileName,
    mime: plan.file.mimeType,
    fields: plan.fields,
  });
  const { response, release } = await fetchWithSsrFGuard({
    url: `${http.baseUrl}${plan.path}`,
    init: { method: 'POST', headers: http.headers, body, signal },
    timeoutMs: 120_000,
    policy: ssrfPolicyFromHttpBaseUrlAllowedOrigin(config.baseUrl),
    dispatcherPolicy: http.dispatcherPolicy,
    mode: 'strict',
    maxRedirects: 0,
    capture: false,
    beforeRequest: () => {
      signal.throwIfAborted();
      assertCurrent?.();
    },
  });
  try {
    try {
      await assertOkOrThrowHttpError(response, 'Audio transcription failed', {
        requestHeaders: http.headers,
      });
    } catch {
      throw new Error(`Audio transcription failed (HTTP ${response.status}).`);
    }
    const result = await readProviderJsonObjectResponse(response, 'Audio transcription failed', {
      requestHeaders: http.headers,
      maxBytes: 2 * 1024 * 1024,
    });
    signal.throwIfAborted();
    assertCurrent?.();
    return parseTranscriptionResponse(config, result);
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
