import { isDeepStrictEqual } from 'node:util';

import { OpenClawExtensionId } from '../../../../shared/plugins/nativeIds';
import { normalizeLocalSpeechExtensionSettings } from '../../../../shared/speech/localSpeechExtensionSettings';
import { defaultLocalSpeechSettings } from '../../../../shared/speech/localSpeechSettings';
import { LOCAL_TTS_PROVIDER_ID } from '../../../../shared/speech/localTts';
import { buildManagedLocalSttConfig } from './localSttConfig';
import { buildManagedLocalTtsConfig } from './localTtsConfig';
import { normalizeNativeTtsConfig } from './nativeTtsConfig';

export const ASSISTANT_SPEECH_PERSONA = 'assistant-speech';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function hasSpeechToolConfigChanged(previous: unknown, expected: unknown): boolean {
  const readSelections = (value: unknown) => {
    const config = record(value);
    const entries = record(record(config.plugins).entries);
    const tts = record(config.tts);
    const persona = record(record(tts.personas)[ASSISTANT_SPEECH_PERSONA]);
    return {
      stt: record(entries[OpenClawExtensionId.STT_LOCAL_CLI]).config,
      tts: record(tts.providers)[LOCAL_TTS_PROVIDER_ID],
      persona: record(persona.providers)[LOCAL_TTS_PROVIDER_ID],
    };
  };
  return !isDeepStrictEqual(readSelections(previous), readSelections(expected));
}

export function buildLocalSpeechExtensionSttConfig(value: unknown, language: 'zh' | 'en') {
  const settings = normalizeLocalSpeechExtensionSettings(value);
  return buildManagedLocalSttConfig({
    ...defaultLocalSpeechSettings, asrModelId: settings.sttModelId,
  }, language);
}

export function buildLocalSpeechExtensionTtsConfig(value: unknown) {
  const settings = normalizeLocalSpeechExtensionSettings(value);
  return buildManagedLocalTtsConfig(undefined, {
    ...defaultLocalSpeechSettings,
    outputEnabled: true,
    synthesisMode: 'local',
    ttsModelId: settings.ttsModelId,
    voiceId: settings.ttsVoiceId,
  });
}

/** The tool's local provider is separate from the application's reply-reading preferences. */
export function mergeLocalSpeechExtensionTtsConfig(
  existing: unknown,
  local: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const previous = normalizeNativeTtsConfig(existing) ?? {};
  const providers = { ...record(previous.providers) };
  delete providers[LOCAL_TTS_PROVIDER_ID];
  const localProvider = record(local?.providers)[LOCAL_TTS_PROVIDER_ID];
  if (localProvider) {
    providers[LOCAL_TTS_PROVIDER_ID] = localProvider;
    return {
      ...previous,
      auto: previous.auto ?? 'off',
      provider: typeof previous.provider === 'string' && previous.provider && previous.provider !== LOCAL_TTS_PROVIDER_ID
        ? previous.provider : LOCAL_TTS_PROVIDER_ID,
      providers,
    };
  }
  if (!Object.keys(previous).length) return null;
  return {
    ...previous,
    ...(previous.provider === LOCAL_TTS_PROVIDER_ID ? { auto: 'off' } : {}),
    providers,
  };
}
