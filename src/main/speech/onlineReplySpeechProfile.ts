import { createHash } from 'node:crypto';

import { normalizeSpeechServiceBaseUrl } from '../../../plugins/sdk/speech-protocols';
import type { LocalSpeechSettings } from '../../shared/speech/localSpeechSettings';
import {
  resolveOnlineSpeechBinding,
  resolveOnlineSpeechVoiceSelection,
} from '../../shared/speech/onlineSpeechModels';

/** Identifies the complete managed request profile without sending credentials over IPC/RPC. */
export const withReplySpeechConfigurationId = <T extends Record<string, unknown>>(
  profile: T,
): T & { configurationId: string } => {
  if (Object.prototype.hasOwnProperty.call(profile, 'compatibilityProfile'))
    throw new Error('Unsupported speech configuration field.');
  const voice = profile.voiceSelection as { kind?: unknown; voiceId?: unknown } | undefined;
  const configurationId = createHash('sha256')
    .update(
      JSON.stringify([
        profile.baseUrl,
        profile.model,
        profile.apiKey,
        profile.protocolId,
        profile.voicePolicy,
        voice?.kind,
        voice?.voiceId,
        profile.speakerVoice,
      ]),
    )
    .digest('hex');
  return { ...profile, configurationId };
};

export function resolveOnlineReplySpeechProfile(settings: LocalSpeechSettings, category: unknown) {
  if (!settings.outputEnabled || settings.synthesisMode !== 'online') return null;
  const selected = resolveOnlineSpeechBinding(
    category,
    settings.onlineTtsModelRef,
    settings.onlineTtsBindingId,
    'tts',
  );
  if (
    !selected ||
    selected.model.id.length > 256 ||
    selected.provider.apiKey.length > 16384 ||
    /[\r\n\0]/.test(selected.provider.apiKey)
  )
    return null;
  const voiceSelection = resolveOnlineSpeechVoiceSelection(
    selected.model,
    selected.binding,
    settings.onlineTtsVoiceSelection,
  );
  if (!voiceSelection) return null;
  try {
    const baseUrl = normalizeSpeechServiceBaseUrl(selected.provider.baseUrl, selected.binding);
    if (baseUrl.length > 2048) return null;
    return withReplySpeechConfigurationId({
      baseUrl,
      model: selected.model.id,
      apiKey: selected.provider.apiKey.trim(),
      protocolId: selected.binding.protocolId,
      voicePolicy: selected.binding.voicePolicy ?? 'preset',
      voiceSelection,
      speakerVoice: voiceSelection.voiceId,
    });
  } catch {
    return null;
  }
}
