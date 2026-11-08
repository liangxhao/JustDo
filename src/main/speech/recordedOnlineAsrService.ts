import {
  buildTranscriptionRequest,
  normalizeSpeechServiceBaseUrl,
  parseTranscriptionResponse,
  SPEECH_PROTOCOL_IDS,
  type SpeechProtocolSelection,
} from '../../../plugins/sdk/speech-protocols';
import type { LocalAsrLanguage } from '../../shared/speech/localAsr';
import type { LocalSpeechSettings } from '../../shared/speech/localSpeechSettings';
import { resolveOnlineSpeechBinding } from '../../shared/speech/onlineSpeechModels';
import { mainProcessFetch } from '../core/network/mainProcessFetch';

export const MAX_RECORDED_ASR_AUDIO_BYTES = 20 * 1024 * 1024;
export const MAX_RECORDED_ASR_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface RecordedOnlineAsrProfile {
  selection: SpeechProtocolSelection;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export function resolveRecordedOnlineAsrProfile(
  settings: LocalSpeechSettings,
  category: unknown,
): RecordedOnlineAsrProfile | null {
  if (!settings.inputEnabled || settings.recognitionMode !== 'online') return null;
  const selected = resolveOnlineSpeechBinding(
    category,
    settings.onlineAsrModelRef,
    settings.onlineAsrBindingId,
    'composer-asr',
  );
  if (!selected || selected.binding.protocolId !== SPEECH_PROTOCOL_IDS.TRANSCRIPTION_HTTP)
    return null;
  try {
    return {
      selection: { protocolId: selected.binding.protocolId },
      baseUrl: normalizeSpeechServiceBaseUrl(selected.provider.baseUrl, selected.binding),
      model: selected.model.id,
      apiKey: selected.provider.apiKey.trim(),
    };
  } catch {
    return null;
  }
}

/** Memory-only comparison token. Never expose or log it: it includes the credential revision. */
export const getRecordedOnlineAsrSettingsKey = (
  settings: LocalSpeechSettings,
  category: unknown,
): string =>
  JSON.stringify([
    settings.inputEnabled,
    settings.recognitionMode,
    settings.onlineAsrModelRef,
    settings.onlineAsrBindingId,
    resolveRecordedOnlineAsrProfile(settings, category),
  ]);

export async function transcribeRecordedOnlineAudio(
  profile: RecordedOnlineAsrProfile,
  audio: Uint8Array,
  language: LocalAsrLanguage,
  signal: AbortSignal,
  assertCurrent: () => void,
): Promise<string> {
  if (
    !(audio instanceof Uint8Array) ||
    audio.length < 44 ||
    audio.length > MAX_RECORDED_ASR_AUDIO_BYTES ||
    Buffer.from(audio.subarray(0, 4)).toString('ascii') !== 'RIFF' ||
    Buffer.from(audio.subarray(8, 12)).toString('ascii') !== 'WAVE'
  )
    throw new Error('Invalid or oversized WAV recording.');
  const wav = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  if (
    Buffer.from(audio.subarray(12, 16)).toString('ascii') !== 'fmt ' ||
    wav.getUint32(16, true) !== 16 ||
    wav.getUint16(20, true) !== 1 ||
    wav.getUint16(22, true) !== 1 ||
    wav.getUint32(24, true) !== 16_000 ||
    wav.getUint16(34, true) !== 16 ||
    Buffer.from(audio.subarray(36, 40)).toString('ascii') !== 'data' ||
    wav.getUint32(40, true) !== audio.length - 44 ||
    audio.length === 44 ||
    (audio.length - 44) % 2 !== 0 ||
    audio.length - 44 > 16_000 * 2 * 120
  )
    throw new Error('Recording must contain at most 120 seconds of mono PCM16 WAV at 16 kHz.');
  const plan = buildTranscriptionRequest({
    selection: profile.selection,
    model: profile.model,
    audio,
    language,
  });
  const form = new FormData();
  for (const [key, value] of Object.entries(plan.fields)) form.set(key, value);
  form.set(
    'file',
    new Blob([new Uint8Array(plan.file.bytes)], { type: plan.file.mimeType }),
    plan.file.fileName,
  );
  const encoded = new Request(`${profile.baseUrl}${plan.path}`, { method: 'POST', body: form });
  const body = new Uint8Array(await encoded.arrayBuffer());
  const contentType = encoded.headers.get('content-type')!;
  assertCurrent();
  const response = await mainProcessFetch(
    `${profile.baseUrl}${plan.path}`,
    {
      method: 'POST',
      body,
      signal,
      redirect: 'error',
      headers: {
        'content-type': contentType,
        ...(profile.apiKey ? { authorization: `Bearer ${profile.apiKey}` } : {}),
      },
    },
    { maxResponseBytes: MAX_RECORDED_ASR_RESPONSE_BYTES, beforeDispatch: assertCurrent },
  );
  assertCurrent();
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Speech service returned HTTP ${response.status}.`);
  }
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > MAX_RECORDED_ASR_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Speech service response exceeds the size limit.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Speech service returned an empty response.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      assertCurrent();
      const item = await reader.read();
      if (item.done) break;
      length += item.value.length;
      if (length > MAX_RECORDED_ASR_RESPONSE_BYTES)
        throw new Error('Speech service response exceeds the size limit.');
      chunks.push(item.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  assertCurrent();
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
  } catch {
    throw new Error('Speech service returned invalid JSON.');
  }
  return parseTranscriptionResponse(profile.selection, value);
}
