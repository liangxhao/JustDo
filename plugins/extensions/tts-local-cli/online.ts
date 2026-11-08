import type { SpeechSynthesisRequest } from 'openclaw/plugin-sdk/speech-core';

import {
  normalizeSpeechServiceBaseUrl,
  resolveSpeechProtocolSelection,
  resolveSpeechVoiceSelection,
  SPEECH_PROTOCOL_IDS,
  type SpeechProtocolSelection,
  type SpeechVoicePolicy,
  type SpeechVoiceSelection,
} from '../../sdk/speech-protocols/index.js';

export type OnlineSpeechConfig = SpeechProtocolSelection & {
  mode: 'online';
  baseUrl: string;
  model: string;
  apiKey: string;
  voicePolicy: SpeechVoicePolicy;
  voiceSelection: SpeechVoiceSelection;
  speakerVoice?: string;
};

export function readOnlineSpeechConfig(value: unknown): OnlineSpeechConfig {
  const input = value as Partial<OnlineSpeechConfig> | null;
  if (
    !input ||
    input.mode !== 'online' ||
    typeof input.model !== 'string' ||
    !input.model.trim() ||
    input.model.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(input.model)
  )
    throw new Error(
      'The selected online speech model is unavailable. Configure it in model settings.',
    );
  const selection = resolveSpeechProtocolSelection(
    input,
    'speech',
    SPEECH_PROTOCOL_IDS.SPEECH_HTTP,
  );
  const baseUrl = normalizeSpeechServiceBaseUrl(input.baseUrl, selection);
  const voicePolicy = input.voicePolicy === undefined ? 'preset' : input.voicePolicy;
  const voiceSelection = resolveSpeechVoiceSelection(
    input.voiceSelection,
    selection,
    voicePolicy,
    input.speakerVoice,
  );
  if (input.apiKey !== undefined && typeof input.apiKey !== 'string')
    throw new Error('The speech service credential has not been resolved.');
  return {
    mode: 'online',
    ...selection,
    baseUrl,
    model: input.model.trim(),
    apiKey: input.apiKey ?? '',
    voicePolicy,
    voiceSelection,
    speakerVoice: voiceSelection.voiceId,
  };
}

/** Delegate the wire contract through the public registry, preserving this tool's native gate/identity. */
export async function synthesizeOnlineSpeech(req: SpeechSynthesisRequest) {
  const config = readOnlineSpeechConfig(req.providerConfig);
  const { getSpeechProvider } = await import('openclaw/plugin-sdk/speech-core');
  const provider = getSpeechProvider('openai', req.cfg);
  if (
    !provider ||
    provider.id !== 'openai' ||
    !(await provider.isConfigured({
      cfg: req.cfg,
      providerConfig: config,
      timeoutMs: req.timeoutMs,
    }))
  )
    throw new Error('The configured speech protocol adapter is unavailable.');
  return provider.synthesize({ ...req, providerConfig: config });
}
