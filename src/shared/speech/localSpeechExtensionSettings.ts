import { LOCAL_ASR_DEFAULT_MODEL_ID, LOCAL_ASR_MODEL_IDS, type LocalAsrModelId } from './localAsr';
import {
  getLocalTtsDefaultVoiceId,
  isLocalTtsVoiceId,
  LOCAL_TTS_MODEL_ID,
  LOCAL_TTS_MODEL_IDS,
  type LocalTtsModelId,
} from './localTts';
import {
  normalizeOnlineSpeechVoiceSelection,
  type OnlineSpeechVoiceSelection,
  resolveOnlineSpeechBinding,
  resolveOnlineSpeechModel,
  resolveOnlineSpeechVoiceSelection,
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
  onlineSttBindingId: string;
  onlineTtsBindingId: string;
  onlineTtsVoiceSelection: OnlineSpeechVoiceSelection | null;
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
  onlineSttBindingId: '',
  onlineTtsBindingId: '',
  onlineTtsVoiceSelection: null,
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
  const onlineTtsVoiceSelection = normalizeOnlineSpeechVoiceSelection(
    input.onlineTtsVoiceSelection,
    typeof input.onlineTtsVoice === 'string' ? input.onlineTtsVoice : undefined,
  );
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
    onlineTtsVoice:
      onlineTtsVoiceSelection?.kind === 'preset' ? onlineTtsVoiceSelection.voiceId : '',
    onlineSttBindingId:
      typeof input.onlineSttBindingId === 'string' ? input.onlineSttBindingId.trim() : '',
    onlineTtsBindingId:
      typeof input.onlineTtsBindingId === 'string' ? input.onlineTtsBindingId.trim() : '',
    onlineTtsVoiceSelection,
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
          'onlineSttBindingId',
          'onlineTtsBindingId',
          'onlineTtsVoiceSelection',
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
  for (const key of [
    'onlineSttModelRef',
    'onlineTtsModelRef',
    'onlineTtsVoice',
    'onlineSttBindingId',
    'onlineTtsBindingId',
  ]) {
    if (
      key in input &&
      (typeof input[key] !== 'string' ||
        (input[key] as string).length > (key === 'onlineTtsVoice' ? 256 : 512) ||
        /[\r\n\0]/.test(input[key] as string))
    )
      throw new Error('Invalid online speech selection.');
  }
  if (
    'onlineTtsVoiceSelection' in input &&
    input.onlineTtsVoiceSelection !== null &&
    !normalizeOnlineSpeechVoiceSelection(input.onlineTtsVoiceSelection)
  )
    throw new Error('Invalid online speech voice selection.');
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
  if ('onlineTtsVoice' in patch && !('onlineTtsVoiceSelection' in patch))
    merged.onlineTtsVoiceSelection = normalizeOnlineSpeechVoiceSelection(
      undefined,
      patch.onlineTtsVoice,
    );
  if ('onlineTtsVoiceSelection' in patch)
    merged.onlineTtsVoice =
      merged.onlineTtsVoiceSelection?.kind === 'preset'
        ? merged.onlineTtsVoiceSelection.voiceId
        : '';
  if (categories) {
    if (
      merged.sttMode === 'online' &&
      ('sttMode' in patch || 'onlineSttModelRef' in patch || 'onlineSttBindingId' in patch) &&
      !resolveOnlineSpeechBinding(
        categories.stt,
        merged.onlineSttModelRef,
        merged.onlineSttBindingId,
        'stt-tool',
      )
    )
      throw new Error('Select a configured HTTP audio transcription model.');
    if (
      merged.ttsMode === 'online' &&
      ('ttsMode' in patch ||
        'onlineTtsModelRef' in patch ||
        'onlineTtsVoice' in patch ||
        'onlineTtsBindingId' in patch ||
        'onlineTtsVoiceSelection' in patch)
    ) {
      const selection = resolveOnlineSpeechBinding(
        categories.tts,
        merged.onlineTtsModelRef,
        merged.onlineTtsBindingId,
        'tts',
      );
      if (
        !selection ||
        !resolveOnlineSpeechVoiceSelection(
          selection.model,
          selection.binding,
          merged.onlineTtsVoiceSelection,
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
  const sttExists = Boolean(resolveOnlineSpeechModel(categories.stt, settings.onlineSttModelRef));
  const ttsExists = Boolean(resolveOnlineSpeechModel(categories.tts, settings.onlineTtsModelRef));
  const tts = ttsExists
    ? resolveOnlineSpeechBinding(
        categories.tts,
        settings.onlineTtsModelRef,
        settings.onlineTtsBindingId,
        'tts',
      )
    : null;
  const voice = tts
    ? resolveOnlineSpeechVoiceSelection(tts.model, tts.binding, settings.onlineTtsVoiceSelection)
    : null;
  return {
    ...settings,
    onlineSttModelRef: sttExists ? settings.onlineSttModelRef : '',
    onlineSttBindingId: sttExists ? settings.onlineSttBindingId : '',
    onlineTtsModelRef: ttsExists ? settings.onlineTtsModelRef : '',
    onlineTtsBindingId: ttsExists ? settings.onlineTtsBindingId : '',
    onlineTtsVoice: voice?.kind === 'preset' ? voice.voiceId : '',
    onlineTtsVoiceSelection: voice,
  };
}
