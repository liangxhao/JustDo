import { LOCAL_ASR_DEFAULT_MODEL_ID, LOCAL_ASR_MODEL_IDS, type LocalAsrModelId } from './localAsr';
import { LOCAL_TTS_MODEL_ID, LOCAL_TTS_MODEL_IDS, type LocalTtsModelId } from './localTts';

export interface LocalSpeechExtensionSettings {
  sttModelId: LocalAsrModelId;
  ttsModelId: LocalTtsModelId;
}

export const defaultLocalSpeechExtensionSettings: LocalSpeechExtensionSettings = {
  sttModelId: LOCAL_ASR_DEFAULT_MODEL_ID,
  ttsModelId: LOCAL_TTS_MODEL_ID,
};

export function normalizeLocalSpeechExtensionSettings(
  value: unknown,
): LocalSpeechExtensionSettings {
  const input =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    sttModelId: LOCAL_ASR_MODEL_IDS.includes(input.sttModelId as LocalAsrModelId)
      ? (input.sttModelId as LocalAsrModelId)
      : LOCAL_ASR_DEFAULT_MODEL_ID,
    ttsModelId: LOCAL_TTS_MODEL_IDS.includes(input.ttsModelId as LocalTtsModelId)
      ? (input.ttsModelId as LocalTtsModelId)
      : LOCAL_TTS_MODEL_ID,
  };
}

export function parseLocalSpeechExtensionSettingsPatch(
  value: unknown,
): Partial<LocalSpeechExtensionSettings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid local speech extension settings.');
  }
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(key => key !== 'sttModelId' && key !== 'ttsModelId') ||
    ('sttModelId' in input && !LOCAL_ASR_MODEL_IDS.includes(input.sttModelId as LocalAsrModelId)) ||
    ('ttsModelId' in input && !LOCAL_TTS_MODEL_IDS.includes(input.ttsModelId as LocalTtsModelId))
  ) {
    throw new Error('Invalid local speech extension model.');
  }
  return { ...input };
}
