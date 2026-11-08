/** Pure wire contracts. Callers own credentials, networking, cancellation and resource admission. */
export const SPEECH_PROTOCOL_IDS = {
  TRANSCRIPTION_HTTP: 'openai-transcription-http',
  SPEECH_HTTP: 'openai-speech-http',
  TRANSCRIPTION_REALTIME: 'openai-transcription-realtime',
  VOICE_REALTIME: 'openai-voice-realtime',
} as const;

export type SpeechProtocolId = (typeof SPEECH_PROTOCOL_IDS)[keyof typeof SPEECH_PROTOCOL_IDS];
export type SpeechCapability = 'transcription' | 'speech' | 'realtime-transcription' | 'realtime-voice';
export type SpeechVoicePolicy = 'preset';
export type SpeechVoiceSelection = { kind: 'preset'; voiceId: string };
export type SpeechProtocolSelection = {
  protocolId: SpeechProtocolId;
};
export type SpeechAudioFormat = 'wav' | 'mp3' | 'opus' | 'pcm';

const capabilities: Record<SpeechProtocolId, SpeechCapability> = {
  'openai-transcription-http': 'transcription',
  'openai-speech-http': 'speech',
  'openai-transcription-realtime': 'realtime-transcription',
  'openai-voice-realtime': 'realtime-voice',
};
export const MAX_TRANSCRIPTION_AUDIO_BYTES = 25 * 1024 * 1024;
export const MAX_SPEECH_TEXT_LENGTH = 10_000;
export const MAX_TRANSCRIPTION_TEXT_LENGTH = 1_000_000;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

function requiredString(value: unknown, label: string, maxLength = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength)
    throw new Error(`Invalid ${label}.`);
  return value.trim();
}

function requiredIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value))
    throw new Error(`Invalid ${label}.`);
  const result = requiredString(value, label);
  return result;
}

/** Legacy defaults are selected by the consumer, never inferred from a vendor/model/URL. */
export function resolveSpeechProtocolSelection(
  value: unknown,
  capability: SpeechCapability,
  legacyProtocolId?: SpeechProtocolId,
): SpeechProtocolSelection {
  const input = record(value);
  if (!input) throw new Error('Invalid speech protocol configuration.');
  if (Object.prototype.hasOwnProperty.call(input, 'compatibilityProfile'))
    throw new Error('Unsupported speech configuration field.');
  const protocolId = input.protocolId === undefined ? legacyProtocolId : input.protocolId;
  if (typeof protocolId !== 'string' || !Object.prototype.hasOwnProperty.call(capabilities, protocolId) ||
      capabilities[protocolId as SpeechProtocolId] !== capability)
    throw new Error('Unsupported speech protocol.');
  return { protocolId: protocolId as SpeechProtocolId };
}

export function resolveSpeechVoiceSelection(
  value: unknown,
  selection: SpeechProtocolSelection,
  voicePolicy: unknown = 'preset',
  legacyVoice?: unknown,
): SpeechVoiceSelection {
  resolveSpeechProtocolSelection(selection, 'speech');
  if (voicePolicy !== 'preset')
    throw new Error('This speech voice workflow is not supported.');
  const input = value === undefined && typeof legacyVoice === 'string'
    ? { kind: 'preset', voiceId: legacyVoice }
    : record(value);
  if (input?.kind === 'preset' && Object.keys(input).every(key => key === 'kind' || key === 'voiceId'))
    return { kind: 'preset', voiceId: requiredIdentifier(input.voiceId, 'speech voice') };
  throw new Error('The selected speech voice is unavailable.');
}

/** Normalize only this contract's suffix; retain deployment/version prefixes. */
export function normalizeSpeechServiceBaseUrl(value: unknown, selection: SpeechProtocolSelection): string {
  if (!Object.prototype.hasOwnProperty.call(capabilities, selection.protocolId))
    throw new Error('Unsupported speech protocol.');
  resolveSpeechProtocolSelection(selection, capabilities[selection.protocolId]);
  const configured = requiredString(value, 'speech service URL', 2048);
  let url: URL;
  try { url = new URL(configured); } catch { throw new Error('Invalid speech service URL.'); }
  const realtime = capabilities[selection.protocolId]?.startsWith('realtime-');
  if (!(realtime ? ['http:', 'https:', 'ws:', 'wss:'] : ['http:', 'https:']).includes(url.protocol) ||
      url.username || url.password || url.search || url.hash)
    throw new Error('Invalid speech service URL.');
  const suffix = selection.protocolId === SPEECH_PROTOCOL_IDS.TRANSCRIPTION_HTTP ? '/audio/transcriptions'
    : selection.protocolId === SPEECH_PROTOCOL_IDS.SPEECH_HTTP ? '/audio/speech'
      : '/realtime';
  let pathname = url.pathname.replace(/\/+$/, '');
  if (pathname.endsWith(suffix)) pathname = pathname.slice(0, -suffix.length);
  // A known but different complete endpoint is a configuration error, not a second prefix.
  if (['/audio/transcriptions', '/audio/speech', '/chat/completions', '/realtime'].some(other => pathname.endsWith(other)))
    throw new Error('Speech service endpoint does not match the selected protocol.');
  url.pathname = pathname;
  return url.toString().replace(/\/+$/, '');
}

export type TranscriptionRequestPlan = {
  kind: 'multipart'; path: '/audio/transcriptions'; fields: Record<string, string>;
  file: { bytes: Uint8Array; fileName: string; mimeType: string };
};

export function buildTranscriptionRequest(input: {
  selection: SpeechProtocolSelection; model: string; audio: Uint8Array; language?: string;
}): TranscriptionRequestPlan {
  resolveSpeechProtocolSelection(input.selection, 'transcription');
  const model = requiredIdentifier(input.model, 'transcription model');
  if (!(input.audio instanceof Uint8Array) || !input.audio.length || input.audio.length > MAX_TRANSCRIPTION_AUDIO_BYTES)
    throw new Error('Invalid or oversized transcription audio.');
  const language = input.language === undefined || input.language === 'auto' ? undefined : requiredString(input.language, 'transcription language', 32);
  return {
    kind: 'multipart', path: '/audio/transcriptions', fields: { model, ...(language ? { language } : {}) },
    file: { bytes: input.audio, fileName: 'audio.wav', mimeType: 'audio/wav' },
  };
}

export function parseTranscriptionResponse(selection: SpeechProtocolSelection, value: unknown): string {
  resolveSpeechProtocolSelection(selection, 'transcription');
  const input = record(value);
  return requiredString(input?.text, 'transcription result', MAX_TRANSCRIPTION_TEXT_LENGTH);
}

export type SpeechRequestPlan = {
  kind: 'json'; path: '/audio/speech'; body: Record<string, unknown>;
  outputFormat: SpeechAudioFormat; responseKind: 'binary';
};

export function buildSpeechRequest(input: {
  selection: SpeechProtocolSelection; model: string; text: string; voiceSelection: SpeechVoiceSelection;
  voicePolicy?: SpeechVoicePolicy; format: SpeechAudioFormat; speed?: number; instructions?: string;
}): SpeechRequestPlan {
  const selection = resolveSpeechProtocolSelection(input.selection, 'speech');
  const model = requiredIdentifier(input.model, 'speech model');
  const text = requiredString(input.text, 'speech text', MAX_SPEECH_TEXT_LENGTH);
  const voice = resolveSpeechVoiceSelection(input.voiceSelection, selection, input.voicePolicy);
  if (!['wav', 'mp3', 'opus', 'pcm'].includes(input.format)) throw new Error('Unsupported speech audio format.');
  if (input.speed !== undefined && (!Number.isFinite(input.speed) || input.speed <= 0)) throw new Error('Invalid speech speed.');
  return {
    kind: 'json', path: '/audio/speech', outputFormat: input.format, responseKind: 'binary',
    body: { model, input: text, voice: voice.voiceId, response_format: input.format,
      ...(input.speed === undefined ? {} : { speed: input.speed }),
      ...(input.instructions === undefined ? {} : { instructions: requiredString(input.instructions, 'speech instructions', 4096) }) },
  };
}

export function parseSpeechResponse(selection: SpeechProtocolSelection, value: unknown, maxAudioBytes: number): Uint8Array {
  resolveSpeechProtocolSelection(selection, 'speech');
  if (!Number.isSafeInteger(maxAudioBytes) || maxAudioBytes < 1)
    throw new Error('Invalid speech audio limit.');
  if (!(value instanceof Uint8Array) || !value.length || value.length > maxAudioBytes)
    throw new Error('Invalid or oversized speech audio response.');
  return value;
}
