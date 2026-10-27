import { LOCAL_ASR_DEFAULT_MODEL_ID, LOCAL_ASR_MODEL_IDS, type LocalAsrModelId } from './localAsr';
import {
  getLocalTtsDefaultVoiceId,
  getLocalTtsVoiceCount,
  LOCAL_TTS_DEFAULT_VOICE_ID,
  LOCAL_TTS_MODEL_ID,
  LOCAL_TTS_MODEL_IDS,
  type LocalTtsModelId,
} from './localTts';

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
  voiceId: number;
  speechRate: number;
  synthesisThreads: number;
}

export const defaultLocalSpeechSettings: LocalSpeechSettings = {
  inputEnabled: false,
  recognitionMode: 'local',
  asrModelId: LOCAL_ASR_DEFAULT_MODEL_ID,
  onlineAsrModelRef: '',
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

  return {
    inputEnabled:
      typeof candidate.inputEnabled === 'boolean'
        ? candidate.inputEnabled
        : defaultLocalSpeechSettings.inputEnabled,
    recognitionMode,
    asrModelId,
    onlineAsrModelRef:
      typeof candidate.onlineAsrModelRef === 'string' ? candidate.onlineAsrModelRef : '',
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
    onlineTtsVoice: typeof candidate.onlineTtsVoice === 'string' ? candidate.onlineTtsVoice : '',
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
