export const LocalAsrIpc = {
  GetStatus: 'local-asr:status',
  Transcribe: 'local-asr:transcribe',
  StageAttachment: 'local-asr:stage-attachment',
} as const;

export const LOCAL_ASR_DEFAULT_MODEL_ID = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09';
export const LOCAL_ASR_MODEL_IDS = [
  LOCAL_ASR_DEFAULT_MODEL_ID,
  'sherpa-onnx-whisper-base',
] as const;
export type LocalAsrModelId = (typeof LOCAL_ASR_MODEL_IDS)[number];
export const LOCAL_ASR_MAX_AUDIO_BYTES = 20 * 1024 * 1024;

export interface LocalAsrStatus {
  available: boolean;
  supported: boolean;
  modelId: LocalAsrModelId;
}

export interface LocalAsrTranscribeResult {
  success: boolean;
  text?: string;
  error?: string;
}

export type LocalAsrLanguage = 'auto' | 'zh' | 'en' | 'ja' | 'ko' | 'yue';

export interface LocalAsrTranscribeOptions {
  modelId: LocalAsrModelId;
  language: LocalAsrLanguage;
  numThreads: number;
}

export const isLocalAsrLanguageSupported = (
  modelId: LocalAsrModelId,
  language: LocalAsrLanguage | 'app',
): boolean => language !== 'yue' || modelId.includes('sense-voice');

export const LOCAL_AUDIO_ATTACHMENT_EXTENSIONS = [
  'wav',
  'mp3',
  'm4a',
  'aac',
  'ogg',
  'opus',
  'flac',
  'webm',
  'mp4',
  'mov',
  'mkv',
] as const;
export const isLocalAudioAttachment = (filePath: string): boolean =>
  LOCAL_AUDIO_ATTACHMENT_EXTENSIONS.some(extension =>
    filePath.toLowerCase().endsWith(`.${extension}`),
  );
export type StageAudioAttachmentResult = {
  success: boolean;
  path?: string;
  /** First path for draft comparison when the same file version had to be copied again. */
  draftPath?: string;
  error?: string;
};
