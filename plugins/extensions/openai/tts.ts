import {
  buildSpeechRequest,
  normalizeSpeechServiceBaseUrl,
  parseSpeechResponse,
  resolveSpeechProtocolSelection,
  resolveSpeechVoiceSelection,
  SPEECH_PROTOCOL_IDS,
  type SpeechProtocolId,
  type SpeechVoicePolicy,
  type SpeechVoiceSelection,
} from '../../sdk/speech-protocols/index.js';
import { requireServiceBaseUrl } from './intranet-config.js';
const DEFAULT_TTS_MAX_BYTES = 16 * 1024 * 1024;

export function normalizeOpenAITtsBaseUrl(baseUrl?: string): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.replace(/\/+$/, '');
}

export function isValidOpenAISpeechIdentifier(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

export async function openaiTTS(options: {
  text: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  voice?: string;
  speed?: number;
  instructions?: string;
  responseFormat: 'mp3' | 'opus' | 'pcm' | 'wav';
  extraBody?: Record<string, unknown>;
  timeoutMs: number;
  maxBytes?: number;
  protocolId?: SpeechProtocolId;
  voicePolicy?: SpeechVoicePolicy;
  voiceSelection?: SpeechVoiceSelection;
}): Promise<Buffer> {
  const selection = resolveSpeechProtocolSelection(options, 'speech', SPEECH_PROTOCOL_IDS.SPEECH_HTTP);
  let { baseUrl } = options;
  const { text, apiKey, model, voice, speed, instructions, responseFormat, extraBody, timeoutMs,
    maxBytes = DEFAULT_TTS_MAX_BYTES, voicePolicy, voiceSelection } = options;
  if (typeof apiKey !== 'string' || apiKey.length > 16384 || /[\r\n\0]/.test(apiKey))
    throw new Error('The speech credential has not been resolved.');
  baseUrl = requireServiceBaseUrl(baseUrl, 'Speech');
  baseUrl = normalizeSpeechServiceBaseUrl(baseUrl, selection);
  const selectedVoice = resolveSpeechVoiceSelection(voiceSelection, selection, voicePolicy, voice);
  const plan = buildSpeechRequest({ selection, model, text, voiceSelection: selectedVoice, voicePolicy,
    format: responseFormat, speed, instructions });
  if (extraBody !== undefined)
    throw new Error('Speech does not support arbitrary request fields.');
  const {
    assertOkOrThrowHttpError,
    readProviderBinaryResponse,
    resolveProviderHttpRequestConfig,
  } = await import('openclaw/plugin-sdk/provider-http');
  const { fetchWithSsrFGuard, ssrfPolicyFromHttpBaseUrlAllowedOrigin } =
    await import('openclaw/plugin-sdk/ssrf-runtime');

  const http = resolveProviderHttpRequestConfig({
    provider: 'openai',
    baseUrl,
    defaultBaseUrl: baseUrl,
    capability: 'audio',
    transport: 'http',
    defaultHeaders: {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      'Content-Type': 'application/json',
    },
  });
  const requestHeaders = http.headers;
  const requestBody = JSON.stringify(plan.body);
  const requestUrl = `${http.baseUrl}${plan.path}`;
  const { response, release } = await fetchWithSsrFGuard({
    url: requestUrl,
    init: {
      method: 'POST',
      headers: requestHeaders,
      body: requestBody,
    },
    timeoutMs,
    policy: ssrfPolicyFromHttpBaseUrlAllowedOrigin(baseUrl),
    dispatcherPolicy: http.dispatcherPolicy,
    mode: 'strict',
    maxRedirects: 0,
    capture: false,
    auditContext: 'openai-tts',
  });
  try {
    try {
      await assertOkOrThrowHttpError(response, 'Speech synthesis failed', { requestHeaders });
    } catch {
      // Providers can echo submitted text/audio or credentials in error bodies.
      throw new Error(`Speech synthesis failed (HTTP ${response.status}).`);
    }
    const result = await readProviderBinaryResponse(response, 'Speech synthesis failed', 'audio', { maxBytes, requestHeaders });
    return Buffer.from(parseSpeechResponse(selection, result, maxBytes));
  } finally {
    await release();
  }
}
