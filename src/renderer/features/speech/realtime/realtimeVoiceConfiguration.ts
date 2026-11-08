import { getRealtimeVoiceSettingsKey, normalizeLocalSpeechSettings } from '@shared/speech/localSpeechSettings';
import { resolveOnlineSpeechBinding, resolveOnlineSpeechVoiceSelection } from '@shared/speech/onlineSpeechModels';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Only the effective selection may end a call; catalog presentation edits are unrelated. */
export function getRealtimeVoiceConfigurationKey(value: unknown): string {
  const config = record(value);
  const settings = normalizeLocalSpeechSettings(config.voice);
  const selected = resolveOnlineSpeechBinding(record(config.onlineModelProviders)['realtime-voice'],
    settings.realtimeModelRef, settings.realtimeBindingId, 'realtime-voice');
  const voice = selected ? resolveOnlineSpeechVoiceSelection(selected.model, selected.binding,
    settings.realtimeVoiceSelection) : null;
  return JSON.stringify([getRealtimeVoiceSettingsKey(settings), settings.inputDeviceId, selected ? [
    selected.providerId, selected.provider.baseUrl.trim(), selected.provider.apiKey,
    selected.model.id, selected.binding, voice,
  ] : null]);
}
