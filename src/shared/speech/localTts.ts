export const LocalTtsIpc = {
  GetStatus: 'local-tts:status',
} as const;

export const LOCAL_TTS_PROVIDER_ID = 'tts-local-cli';
export const LOCAL_TTS_MODEL_ID = 'kokoro-int8-multi-lang-v1_1';
export const LOCAL_TTS_MODEL_IDS = [
  LOCAL_TTS_MODEL_ID,
  'vits-icefall-zh-aishell3',
  'vits-piper-en_US-lessac-medium-int8',
] as const;
export type LocalTtsModelId = (typeof LOCAL_TTS_MODEL_IDS)[number];
export const LOCAL_TTS_RUNTIME_VERSION = '1.13.7';
export const LOCAL_TTS_DEFAULT_VOICE_ID = 3;

const LOCAL_TTS_VOICE_COUNTS: Readonly<Record<LocalTtsModelId, number>> = {
  'kokoro-int8-multi-lang-v1_1': 103,
  'vits-icefall-zh-aishell3': 174,
  'vits-piper-en_US-lessac-medium-int8': 1,
};

export const getLocalTtsVoiceCount = (modelId: LocalTtsModelId): number =>
  LOCAL_TTS_VOICE_COUNTS[modelId];

export const getLocalTtsDefaultVoiceId = (modelId: LocalTtsModelId): number =>
  modelId === LOCAL_TTS_MODEL_ID ? LOCAL_TTS_DEFAULT_VOICE_ID : 0;

export const isLocalTtsVoiceId = (modelId: LocalTtsModelId, value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= 0 &&
  value < getLocalTtsVoiceCount(modelId);

export interface LocalTtsStatus {
  available: boolean;
  supported: boolean;
  modelId: LocalTtsModelId;
}

export interface LocalTtsSpeakResult {
  audioBase64: string;
  provider: string;
  outputFormat?: string;
  mimeType?: string;
  fileExtension?: string;
}
