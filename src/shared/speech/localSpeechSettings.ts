import { LOCAL_ASR_DEFAULT_MODEL_ID, LOCAL_ASR_MODEL_IDS, type LocalAsrModelId } from './localAsr';
import {
  getLocalTtsDefaultVoiceId,
  getLocalTtsVoiceCount,
  LOCAL_TTS_DEFAULT_VOICE_ID,
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

export const LOCAL_SPEECH_MIN_RECORDING_SECONDS = 5;
export const LOCAL_SPEECH_MAX_RECORDING_SECONDS = 120;
export const LOCAL_SPEECH_MIN_MEETING_SEGMENT_SECONDS = 15;
export const LOCAL_SPEECH_MAX_MEETING_SEGMENT_SECONDS = 60;
export const LOCAL_SPEECH_MIN_THREADS = 1;
export const LOCAL_SPEECH_MAX_THREADS = 8;
export const LOCAL_SPEECH_MIN_RATE = 0.5;
export const LOCAL_SPEECH_MAX_RATE = 2;

export type LocalSpeechInputLanguage = 'auto' | 'app' | 'zh' | 'en' | 'ja' | 'ko' | 'yue';
export type LocalSpeechInputSource = 'microphone' | 'system' | 'microphone-system';
export type SpeechRecognitionMode = 'local' | 'online';
export type SpeechSynthesisMode = 'local' | 'online';

export interface LocalSpeechSettings {
  inputEnabled: boolean;
  recognitionMode: SpeechRecognitionMode;
  asrModelId: LocalAsrModelId;
  onlineAsrModelRef: string;
  onlineAsrBindingId: string;
  inputSource: LocalSpeechInputSource;
  inputDeviceId: string;
  inputLanguage: LocalSpeechInputLanguage;
  maxRecordingSeconds: number;
  meetingMode: boolean;
  meetingSegmentSeconds: number;
  recognitionThreads: number;
  outputEnabled: boolean;
  synthesisMode: SpeechSynthesisMode;
  ttsModelId: LocalTtsModelId;
  onlineTtsModelRef: string;
  onlineTtsVoice: string;
  onlineTtsBindingId: string;
  onlineTtsVoiceSelection: OnlineSpeechVoiceSelection | null;
  realtimeEnabled: boolean;
  realtimeModelRef: string;
  realtimeBindingId: string;
  realtimeVoiceSelection: OnlineSpeechVoiceSelection | null;
  voiceId: number;
  speechRate: number;
  synthesisThreads: number;
}

export const defaultLocalSpeechSettings: LocalSpeechSettings = {
  inputEnabled: false,
  recognitionMode: 'local',
  asrModelId: LOCAL_ASR_DEFAULT_MODEL_ID,
  onlineAsrModelRef: '',
  onlineAsrBindingId: '',
  inputSource: 'microphone',
  inputDeviceId: '',
  inputLanguage: 'app',
  maxRecordingSeconds: 60,
  meetingMode: false,
  meetingSegmentSeconds: 30,
  recognitionThreads: 2,
  outputEnabled: false,
  synthesisMode: 'local',
  ttsModelId: LOCAL_TTS_MODEL_ID,
  onlineTtsModelRef: '',
  onlineTtsVoice: '',
  onlineTtsBindingId: '',
  onlineTtsVoiceSelection: null,
  realtimeEnabled: false,
  realtimeModelRef: '',
  realtimeBindingId: '',
  realtimeVoiceSelection: null,
  voiceId: LOCAL_TTS_DEFAULT_VOICE_ID,
  speechRate: 1,
  synthesisThreads: 2,
};

const clampNumber = (value: unknown, fallback: number, min: number, max: number): number => {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, numeric));
};

const clampInteger = (value: unknown, fallback: number, min: number, max: number): number =>
  Math.round(clampNumber(value, fallback, min, max));

export const normalizeLocalSpeechSettings = (value: unknown): LocalSpeechSettings => {
  const candidate = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const recognitionMode: SpeechRecognitionMode =
    candidate.recognitionMode === 'online' ? 'online' : defaultLocalSpeechSettings.recognitionMode;
  const synthesisMode: SpeechSynthesisMode =
    candidate.synthesisMode === 'online' ? 'online' : defaultLocalSpeechSettings.synthesisMode;
  const selectedInputLanguage =
    candidate.inputLanguage === 'auto' ||
    candidate.inputLanguage === 'zh' ||
    candidate.inputLanguage === 'en' ||
    candidate.inputLanguage === 'ja' ||
    candidate.inputLanguage === 'ko' ||
    candidate.inputLanguage === 'yue' ||
    candidate.inputLanguage === 'app'
      ? candidate.inputLanguage
      : defaultLocalSpeechSettings.inputLanguage;
  const inputLanguage =
    recognitionMode === 'online' && selectedInputLanguage === 'yue'
      ? defaultLocalSpeechSettings.inputLanguage
      : selectedInputLanguage;
  const inputSource =
    candidate.inputSource === 'system' ||
    candidate.inputSource === 'microphone-system' ||
    candidate.inputSource === 'microphone'
      ? candidate.inputSource
      : defaultLocalSpeechSettings.inputSource;
  const asrModelId = LOCAL_ASR_MODEL_IDS.includes(candidate.asrModelId as LocalAsrModelId)
    ? (candidate.asrModelId as LocalAsrModelId)
    : defaultLocalSpeechSettings.asrModelId;
  const ttsModelId = LOCAL_TTS_MODEL_IDS.includes(candidate.ttsModelId as LocalTtsModelId)
    ? (candidate.ttsModelId as LocalTtsModelId)
    : defaultLocalSpeechSettings.ttsModelId;
  const maximumVoiceId = getLocalTtsVoiceCount(ttsModelId) - 1;
  const onlineTtsVoiceSelection = normalizeOnlineSpeechVoiceSelection(
    candidate.onlineTtsVoiceSelection,
    typeof candidate.onlineTtsVoice === 'string' ? candidate.onlineTtsVoice : undefined,
  );

  return {
    inputEnabled:
      typeof candidate.inputEnabled === 'boolean'
        ? candidate.inputEnabled
        : defaultLocalSpeechSettings.inputEnabled,
    recognitionMode,
    asrModelId,
    onlineAsrModelRef:
      typeof candidate.onlineAsrModelRef === 'string' ? candidate.onlineAsrModelRef : '',
    onlineAsrBindingId:
      typeof candidate.onlineAsrBindingId === 'string' ? candidate.onlineAsrBindingId : '',
    inputSource,
    inputDeviceId: typeof candidate.inputDeviceId === 'string' ? candidate.inputDeviceId : '',
    inputLanguage,
    maxRecordingSeconds: clampInteger(
      candidate.maxRecordingSeconds,
      defaultLocalSpeechSettings.maxRecordingSeconds,
      LOCAL_SPEECH_MIN_RECORDING_SECONDS,
      LOCAL_SPEECH_MAX_RECORDING_SECONDS,
    ),
    meetingMode:
      typeof candidate.meetingMode === 'boolean'
        ? candidate.meetingMode
        : defaultLocalSpeechSettings.meetingMode,
    meetingSegmentSeconds: clampInteger(
      candidate.meetingSegmentSeconds,
      defaultLocalSpeechSettings.meetingSegmentSeconds,
      LOCAL_SPEECH_MIN_MEETING_SEGMENT_SECONDS,
      LOCAL_SPEECH_MAX_MEETING_SEGMENT_SECONDS,
    ),
    recognitionThreads: clampInteger(
      candidate.recognitionThreads,
      defaultLocalSpeechSettings.recognitionThreads,
      LOCAL_SPEECH_MIN_THREADS,
      LOCAL_SPEECH_MAX_THREADS,
    ),
    outputEnabled:
      typeof candidate.outputEnabled === 'boolean'
        ? candidate.outputEnabled
        : defaultLocalSpeechSettings.outputEnabled,
    synthesisMode,
    ttsModelId,
    onlineTtsModelRef:
      typeof candidate.onlineTtsModelRef === 'string' ? candidate.onlineTtsModelRef : '',
    onlineTtsVoice:
      onlineTtsVoiceSelection?.kind === 'preset' ? onlineTtsVoiceSelection.voiceId : '',
    onlineTtsBindingId:
      typeof candidate.onlineTtsBindingId === 'string' ? candidate.onlineTtsBindingId : '',
    onlineTtsVoiceSelection,
    realtimeEnabled: candidate.realtimeEnabled === true,
    realtimeModelRef:
      typeof candidate.realtimeModelRef === 'string' ? candidate.realtimeModelRef : '',
    realtimeBindingId:
      typeof candidate.realtimeBindingId === 'string' ? candidate.realtimeBindingId : '',
    realtimeVoiceSelection: normalizeOnlineSpeechVoiceSelection(candidate.realtimeVoiceSelection),
    voiceId: clampInteger(
      candidate.voiceId,
      getLocalTtsDefaultVoiceId(ttsModelId),
      0,
      maximumVoiceId,
    ),
    speechRate: clampNumber(
      candidate.speechRate,
      defaultLocalSpeechSettings.speechRate,
      LOCAL_SPEECH_MIN_RATE,
      LOCAL_SPEECH_MAX_RATE,
    ),
    synthesisThreads: clampInteger(
      candidate.synthesisThreads,
      defaultLocalSpeechSettings.synthesisThreads,
      LOCAL_SPEECH_MIN_THREADS,
      LOCAL_SPEECH_MAX_THREADS,
    ),
  };
};

export const resolveLocalSpeechInputLanguage = (
  setting: LocalSpeechInputLanguage,
  appLanguage: 'zh' | 'en',
): Exclude<LocalSpeechInputLanguage, 'app'> => (setting === 'app' ? appLanguage : setting);

export const getSpeechSynthesisSettingsKey = (value: unknown): string => {
  const settings = normalizeLocalSpeechSettings(value);
  return JSON.stringify([
    settings.outputEnabled,
    settings.synthesisMode,
    ...(settings.synthesisMode === 'local'
      ? [settings.ttsModelId, settings.voiceId, settings.speechRate, settings.synthesisThreads]
      : [
          settings.onlineTtsModelRef,
          settings.onlineTtsBindingId,
          settings.onlineTtsVoiceSelection,
        ]),
  ]);
};

export const getRealtimeVoiceSettingsKey = (value: unknown): string => {
  const settings = normalizeLocalSpeechSettings(value);
  return JSON.stringify([
    settings.realtimeEnabled,
    settings.realtimeModelRef,
    settings.realtimeBindingId,
    settings.realtimeVoiceSelection,
  ]);
};

export const reconcileLocalSpeechCatalog = (
  value: unknown,
  categories: { recognition?: unknown; synthesis?: unknown; realtime?: unknown },
): LocalSpeechSettings => {
  const settings = normalizeLocalSpeechSettings(value);
  const input = resolveOnlineSpeechModel(categories.recognition, settings.onlineAsrModelRef);
  const output = resolveOnlineSpeechModel(categories.synthesis, settings.onlineTtsModelRef);
  const realtime = resolveOnlineSpeechModel(categories.realtime, settings.realtimeModelRef);
  const outputBinding = resolveOnlineSpeechBinding(
    categories.synthesis,
    settings.onlineTtsModelRef,
    settings.onlineTtsBindingId,
    'tts',
  );
  const realtimeBinding = resolveOnlineSpeechBinding(
    categories.realtime,
    settings.realtimeModelRef,
    settings.realtimeBindingId,
    'realtime-voice',
  );
  const outputVoice = outputBinding
    ? resolveOnlineSpeechVoiceSelection(
        outputBinding.model,
        outputBinding.binding,
        settings.onlineTtsVoiceSelection,
      )
    : null;
  const realtimeVoice = realtimeBinding
    ? resolveOnlineSpeechVoiceSelection(
        realtimeBinding.model,
        realtimeBinding.binding,
        settings.realtimeVoiceSelection,
      )
    : null;
  return {
    ...settings,
    // Retain missing explicit identities while their model exists. Clearing them
    // would silently admit a legacy protocol after importing an older catalog.
    onlineAsrModelRef: input ? settings.onlineAsrModelRef : '',
    onlineAsrBindingId: input ? settings.onlineAsrBindingId : '',
    onlineTtsModelRef: output ? settings.onlineTtsModelRef : '',
    onlineTtsBindingId: output ? settings.onlineTtsBindingId : '',
    onlineTtsVoice: outputVoice?.kind === 'preset' ? outputVoice.voiceId : '',
    onlineTtsVoiceSelection: outputVoice,
    realtimeModelRef: realtime ? settings.realtimeModelRef : '',
    realtimeBindingId: realtime ? settings.realtimeBindingId : '',
    realtimeVoiceSelection: realtimeVoice,
  };
};
