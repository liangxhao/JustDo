import { normalizeLocalSpeechExtensionSettings } from '../../../../shared/speech/localSpeechExtensionSettings';
import { defaultLocalSpeechSettings } from '../../../../shared/speech/localSpeechSettings';
import { LOCAL_TTS_MODEL_ID, LOCAL_TTS_PROVIDER_ID } from '../../../../shared/speech/localTts';
import { buildManagedLocalSttConfig } from './localSttConfig';
import { buildManagedLocalTtsConfig } from './localTtsConfig';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

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
    voiceId: settings.ttsModelId === LOCAL_TTS_MODEL_ID ? 3 : 0,
  });
}

/** The tool's local provider is separate from the application's reply-reading preferences. */
export function mergeLocalSpeechExtensionTtsConfig(
  existing: unknown,
  local: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const previous = record(existing);
  const providers = { ...record(previous.providers) };
  delete providers[LOCAL_TTS_PROVIDER_ID];
  const localProvider = record(local?.providers)[LOCAL_TTS_PROVIDER_ID];
  if (localProvider) {
    providers[LOCAL_TTS_PROVIDER_ID] = localProvider;
    return {
      ...previous,
      enabled: true,
      auto: previous.auto ?? 'off',
      provider: typeof previous.provider === 'string' && previous.provider && previous.provider !== LOCAL_TTS_PROVIDER_ID
        ? previous.provider : LOCAL_TTS_PROVIDER_ID,
      providers,
    };
  }
  if (!Object.keys(previous).length) return null;
  return {
    ...previous,
    ...(previous.provider === LOCAL_TTS_PROVIDER_ID ? { enabled: false } : {}),
    providers,
  };
}
