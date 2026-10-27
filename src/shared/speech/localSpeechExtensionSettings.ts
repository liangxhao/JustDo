import { LOCAL_ASR_DEFAULT_MODEL_ID, LOCAL_ASR_MODEL_IDS, type LocalAsrModelId } from './localAsr';
import {
  getLocalTtsDefaultVoiceId,
  isLocalTtsVoiceId,
  LOCAL_TTS_MODEL_ID,
  LOCAL_TTS_MODEL_IDS,
  type LocalTtsModelId,
} from './localTts';
import {
  getOnlineSpeechModelOptions,
  getOnlineSpeechVoiceOptions,
  resolveOnlineSpeechModel,
} from './onlineSpeechModels';

export interface LocalSpeechExtensionSettings {
  sttModelId: LocalAsrModelId;
  ttsModelId: LocalTtsModelId;
  ttsVoiceId: number;
  sttMode: 'local' | 'online';
  onlineSttModelRef: string;
  ttsMode: 'local' | 'online';
  onlineTtsModelRef: string;
  onlineTtsVoice: string;
}

export const defaultLocalSpeechExtensionSettings: LocalSpeechExtensionSettings = {
  sttModelId: LOCAL_ASR_DEFAULT_MODEL_ID,
  ttsModelId: LOCAL_TTS_MODEL_ID,
  ttsVoiceId: getLocalTtsDefaultVoiceId(LOCAL_TTS_MODEL_ID),
  sttMode: 'local',
  onlineSttModelRef: '',
  ttsMode: 'local',
  onlineTtsModelRef: '',
  onlineTtsVoice: '',
};

export function normalizeLocalSpeechExtensionSettings(
  value: unknown,
): LocalSpeechExtensionSettings {
  const input =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const ttsModelId = LOCAL_TTS_MODEL_IDS.includes(input.ttsModelId as LocalTtsModelId)
    ? (input.ttsModelId as LocalTtsModelId)
    : LOCAL_TTS_MODEL_ID;
  return {
    sttModelId: LOCAL_ASR_MODEL_IDS.includes(input.sttModelId as LocalAsrModelId)
      ? (input.sttModelId as LocalAsrModelId)
      : LOCAL_ASR_DEFAULT_MODEL_ID,
    ttsModelId,
    ttsVoiceId: isLocalTtsVoiceId(ttsModelId, input.ttsVoiceId)
      ? input.ttsVoiceId
      : getLocalTtsDefaultVoiceId(ttsModelId),
    sttMode: input.sttMode === 'online' ? 'online' : 'local',
    ttsMode: input.ttsMode === 'online' ? 'online' : 'local',
    onlineSttModelRef:
      typeof input.onlineSttModelRef === 'string' ? input.onlineSttModelRef.trim() : '',
    onlineTtsModelRef:
      typeof input.onlineTtsModelRef === 'string' ? input.onlineTtsModelRef.trim() : '',
    onlineTtsVoice: typeof input.onlineTtsVoice === 'string' ? input.onlineTtsVoice.trim() : '',
  };
}

export function parseLocalSpeechExtensionSettingsPatch(
  value: unknown,
  current?: unknown,
): Partial<LocalSpeechExtensionSettings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid local speech extension settings.');
  }
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      key =>
        ![
          'sttModelId',
          'ttsModelId',
          'ttsVoiceId',
          'sttMode',
          'ttsMode',
          'onlineSttModelRef',
          'onlineTtsModelRef',
          'onlineTtsVoice',
        ].includes(key),
    ) ||
    ('sttModelId' in input && !LOCAL_ASR_MODEL_IDS.includes(input.sttModelId as LocalAsrModelId)) ||
    ('ttsModelId' in input && !LOCAL_TTS_MODEL_IDS.includes(input.ttsModelId as LocalTtsModelId))
  ) {
    throw new Error('Invalid local speech extension model.');
  }
  for (const key of ['sttMode', 'ttsMode']) {
    if (key in input && input[key] !== 'local' && input[key] !== 'online')
      throw new Error('Invalid speech mode.');
  }
  for (const key of ['onlineSttModelRef', 'onlineTtsModelRef', 'onlineTtsVoice']) {
    if (
      key in input &&
      (typeof input[key] !== 'string' ||
        (input[key] as string).length > (key === 'onlineTtsVoice' ? 256 : 512) ||
        /[\r\n\0]/.test(input[key] as string))
    )
      throw new Error('Invalid online speech selection.');
  }
  const ttsModelId = (input.ttsModelId ??
    normalizeLocalSpeechExtensionSettings(current).ttsModelId) as LocalTtsModelId;
  if ('ttsVoiceId' in input && !isLocalTtsVoiceId(ttsModelId, input.ttsVoiceId)) {
    throw new Error('Invalid local speech extension voice.');
  }
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key,
      typeof value === 'string' ? value.trim() : value,
    ]),
  );
}

/** Apply sparse settings in Main's serialized config queue, keeping model and voice coherent. */
export function mergeLocalSpeechExtensionSettingsPatch(
  current: unknown,
  value: unknown,
  categories?: { stt?: unknown; tts?: unknown },
): LocalSpeechExtensionSettings {
  const previous = normalizeLocalSpeechExtensionSettings(current);
  const patch = parseLocalSpeechExtensionSettingsPatch(value, previous);
  const ttsModelId = patch.ttsModelId ?? previous.ttsModelId;
  const modelChanged = ttsModelId !== previous.ttsModelId;
  const merged: LocalSpeechExtensionSettings = {
    ...previous,
    ...patch,
    ...(modelChanged && patch.ttsVoiceId === undefined
      ? { ttsVoiceId: getLocalTtsDefaultVoiceId(ttsModelId) }
      : {}),
  };
  if (categories) {
    if (
      merged.sttMode === 'online' &&
      ('sttMode' in patch || 'onlineSttModelRef' in patch) &&
      !getOnlineSpeechModelOptions(categories.stt, { fileTranscription: true }).some(
        option => option.value === merged.onlineSttModelRef,
      )
    )
      throw new Error('Select a configured HTTP audio transcription model.');
    if (
      merged.ttsMode === 'online' &&
      ('ttsMode' in patch || 'onlineTtsModelRef' in patch || 'onlineTtsVoice' in patch)
    ) {
      const selection = resolveOnlineSpeechModel(categories.tts, merged.onlineTtsModelRef);
      if (
        !selection ||
        !getOnlineSpeechModelOptions(categories.tts, {
          requireVoice: true,
          fileTranscription: true,
        }).some(option => option.value === merged.onlineTtsModelRef) ||
        !getOnlineSpeechVoiceOptions(selection.model).some(
          option => option.value === merged.onlineTtsVoice,
        )
      )
        throw new Error('Select a configured online speech model and voice.');
    }
  }
  return merged;
}

export function reconcileLocalSpeechExtensionCatalog(
  value: unknown,
  categories: { stt?: unknown; tts?: unknown },
): LocalSpeechExtensionSettings {
  const settings = normalizeLocalSpeechExtensionSettings(value);
  const sttExists = getOnlineSpeechModelOptions(categories.stt, { fileTranscription: true }).some(
    option => option.value === settings.onlineSttModelRef,
  );
  const ttsExists = getOnlineSpeechModelOptions(categories.tts, {
    requireVoice: true,
    fileTranscription: true,
  }).some(option => option.value === settings.onlineTtsModelRef);
  const tts = ttsExists
    ? resolveOnlineSpeechModel(categories.tts, settings.onlineTtsModelRef)
    : null;
  return {
    ...settings,
    onlineSttModelRef: sttExists ? settings.onlineSttModelRef : '',
    onlineTtsModelRef: tts ? settings.onlineTtsModelRef : '',
    onlineTtsVoice:
      tts &&
      getOnlineSpeechVoiceOptions(tts.model).some(
        option => option.value === settings.onlineTtsVoice,
      )
        ? settings.onlineTtsVoice
        : '',
  };
}
