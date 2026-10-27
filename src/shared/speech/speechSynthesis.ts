import {
  isLocalTtsVoiceId,
  LOCAL_TTS_MODEL_IDS,
  type LocalTtsModelId,
  type LocalTtsSpeakResult,
} from './localTts';

export { SPEECH_SYNTHESIS_METHOD } from '../../../plugins/extensions/runtime-services/contracts/speech';

export const SpeechSynthesisIpc = {
  Speak: 'speech-synthesis:speak',
  PreviewBuiltin: 'speech-synthesis:preview-builtin',
  CancelBuiltinPreview: 'speech-synthesis:cancel-builtin-preview',
} as const;

export type SpeechSynthesisResult = LocalTtsSpeakResult;

export const MAX_BUILTIN_SPEECH_PREVIEW_TEXT_LENGTH = 300;

export interface BuiltinSpeechPreviewRequest {
  requestId: string;
  modelId: LocalTtsModelId;
  voiceId: number;
  text: string;
}

export interface BuiltinSpeechPreviewResult extends SpeechSynthesisResult {
  requestId: string;
}

export const isBuiltinSpeechPreviewRequestId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

/** Preview accepts catalog identities only; no settings, paths, or execution overrides. */
export function parseBuiltinSpeechPreviewRequest(value: unknown): BuiltinSpeechPreviewRequest {
  const input =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  if (
    !input ||
    Object.keys(input).some(key => !['requestId', 'modelId', 'voiceId', 'text'].includes(key)) ||
    !isBuiltinSpeechPreviewRequestId(input.requestId) ||
    !LOCAL_TTS_MODEL_IDS.includes(input.modelId as LocalTtsModelId) ||
    !isLocalTtsVoiceId(input.modelId as LocalTtsModelId, input.voiceId) ||
    typeof input.text !== 'string' ||
    !input.text.trim() ||
    input.text.trim().length > MAX_BUILTIN_SPEECH_PREVIEW_TEXT_LENGTH ||
    input.text.includes('\0')
  )
    throw new Error('Invalid builtin speech preview request.');
  return {
    requestId: input.requestId,
    modelId: input.modelId as LocalTtsModelId,
    voiceId: input.voiceId,
    text: input.text.trim(),
  };
}
