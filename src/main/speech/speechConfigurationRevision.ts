import {
  getRealtimeVoiceSettingsKey,
  getSpeechSynthesisSettingsKey,
  normalizeLocalSpeechSettings,
} from '../../shared/speech/localSpeechSettings';
import {
  resolveOnlineSpeechBinding,
  resolveOnlineSpeechVoiceSelection,
} from '../../shared/speech/onlineSpeechModels';

type Scope = 'input' | 'output' | 'realtime';
const scopes: Scope[] = ['input', 'output', 'realtime'];
const revisions: Record<Scope, number> = { input: 0, output: 0, realtime: 0 };
const listeners: Record<Scope, Set<() => void>> = {
  input: new Set(),
  output: new Set(),
  realtime: new Set(),
};
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function keys(value: unknown): Record<Scope, string> {
  const config = record(value);
  const catalogs = record(config.onlineModelProviders);
  const settings = normalizeLocalSpeechSettings(config.voice);
  const connection = (
    kind: string,
    reference: string,
    bindingId: string,
    purpose: 'composer-asr' | 'tts' | 'realtime-voice',
  ) => {
    const selected = resolveOnlineSpeechBinding(catalogs[kind], reference, bindingId, purpose);
    const voice =
      purpose === 'composer-asr'
        ? undefined
        : purpose === 'tts'
          ? settings.onlineTtsVoiceSelection
          : settings.realtimeVoiceSelection;
    return selected
      ? [
          selected.model.id,
          selected.binding,
          selected.provider.baseUrl,
          selected.provider.apiKey,
          purpose === 'composer-asr'
            ? undefined
            : resolveOnlineSpeechVoiceSelection(selected.model, selected.binding, voice),
        ]
      : null;
  };
  return {
    input: JSON.stringify([
      settings.inputEnabled,
      settings.recognitionMode,
      settings.asrModelId,
      settings.inputSource,
      settings.inputDeviceId,
      settings.inputLanguage,
      settings.recognitionThreads,
      settings.maxRecordingSeconds,
      settings.onlineAsrModelRef,
      settings.onlineAsrBindingId,
      settings.recognitionMode === 'online'
        ? connection(
            'speech-recognition',
            settings.onlineAsrModelRef,
            settings.onlineAsrBindingId,
            'composer-asr',
          )
        : null,
    ]),
    output: JSON.stringify([
      getSpeechSynthesisSettingsKey(settings),
      settings.synthesisMode === 'online'
        ? connection(
            'speech-synthesis',
            settings.onlineTtsModelRef,
            settings.onlineTtsBindingId,
            'tts',
          )
        : null,
    ]),
    realtime: JSON.stringify([
      getRealtimeVoiceSettingsKey(settings),
      settings.inputDeviceId,
      connection(
        'realtime-voice',
        settings.realtimeModelRef,
        settings.realtimeBindingId,
        'realtime-voice',
      ),
    ]),
  };
}

/** Monotonic, memory-only epochs: returning A → B → A never admits an old A result. */
export function advanceSpeechConfigurationRevision(next: unknown, previous: unknown): void {
  const before = keys(previous);
  const after = keys(next);
  for (const scope of scopes) {
    if (before[scope] === after[scope]) continue;
    revisions[scope] += 1;
    for (const listener of listeners[scope]) listener();
  }
}

export const getSpeechConfigurationRevision = (scope: Scope): number => revisions[scope];
export function onSpeechConfigurationChanged(scope: Scope, listener: () => void): () => void {
  listeners[scope].add(listener);
  return () => {
    listeners[scope].delete(listener);
  };
}
