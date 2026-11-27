import { isDeepStrictEqual } from 'node:util';

import { isJustDoCustomProviderKey } from '../../../shared/providers';
import { normalizeLocalSpeechExtensionSettings } from '../../../shared/speech/localSpeechExtensionSettings';
import { normalizeLocalSpeechSettings } from '../../../shared/speech/localSpeechSettings';
import { isRecord } from './configShape';

type RuntimeAppConfig = {
  api?: unknown;
  developerMode?: unknown;
  controlUiEnabled?: unknown;
  browserMode?: unknown;
  model?: unknown;
  providers?: unknown;
  onlineModelProviders?: {
    decision?: unknown;
    video?: unknown;
    'speech-recognition'?: unknown;
    'speech-synthesis'?: unknown;
    'realtime-voice'?: unknown;
  };
  localSpeechExtensions?: unknown;
  language?: unknown;
  voice?: unknown;
};

export const getOpenClawAppConfigSignature = (config: unknown): string => {
  const appConfig = (config ?? {}) as RuntimeAppConfig;
  const voice = normalizeLocalSpeechSettings(appConfig.voice);
  return JSON.stringify({
    api: appConfig.api,
    controlUiEnabled: appConfig.developerMode === true && appConfig.controlUiEnabled === true,
    browserMode: appConfig.browserMode,
    model: appConfig.model,
    providers: appConfig.providers,
    decisionModels: appConfig.onlineModelProviders?.decision,
    nativeVideoModels: appConfig.onlineModelProviders?.video,
    recognitionModels: appConfig.onlineModelProviders?.['speech-recognition'],
    synthesisModels: appConfig.onlineModelProviders?.['speech-synthesis'],
    realtimeModels: appConfig.onlineModelProviders?.['realtime-voice'],
    localSpeechExtensions: normalizeLocalSpeechExtensionSettings(appConfig.localSpeechExtensions),
    // Match Main's language projection so persisting the initial Chinese
    // preference does not reapply an already equivalent Gateway configuration.
    language: appConfig.language === 'en' ? 'en' : 'zh',
    voice: {
      inputEnabled: voice.inputEnabled,
      recognitionMode: voice.recognitionMode,
      outputEnabled: voice.outputEnabled,
      synthesisMode: voice.synthesisMode,
      ttsModelId: voice.ttsModelId,
      voiceId: voice.voiceId,
      speechRate: voice.speechRate,
      synthesisThreads: voice.synthesisThreads,
      onlineAsrModelRef: voice.onlineAsrModelRef,
      onlineAsrBindingId: voice.onlineAsrBindingId,
      onlineTtsModelRef: voice.onlineTtsModelRef,
      onlineTtsVoice: voice.onlineTtsVoice,
      onlineTtsBindingId: voice.onlineTtsBindingId,
      onlineTtsVoiceSelection: voice.onlineTtsVoiceSelection,
      realtimeEnabled: voice.realtimeEnabled,
      realtimeModelRef: voice.realtimeModelRef,
      realtimeBindingId: voice.realtimeBindingId,
      realtimeVoiceSelection: voice.realtimeVoiceSelection,
    },
  });
};

export type LanguageModelCatalogAddition = { providerKey: string; modelIds: readonly string[] };

/** Identify settings changes that can use the existing native provider's catalog. */
export function getLanguageModelCatalogAdditions(
  previous: unknown,
  next: unknown,
): readonly LanguageModelCatalogAddition[] | undefined {
  if (!isRecord(previous) || !isRecord(next)) return;
  const previousProviders = previous.providers;
  const nextProviders = next.providers;
  if (!isRecord(previousProviders) || !isRecord(nextProviders)) return;
  const providerKeys = Object.keys(previousProviders);
  if (!isDeepStrictEqual(providerKeys, Object.keys(nextProviders)) ||
      getOpenClawAppConfigSignature(previous) !==
        getOpenClawAppConfigSignature({ ...next, providers: previousProviders })) return;

  const additions: LanguageModelCatalogAddition[] = [];
  for (const providerKey of providerKeys) {
    const previousProvider = previousProviders[providerKey];
    const nextProvider = nextProviders[providerKey];
    if (isDeepStrictEqual(previousProvider, nextProvider)) continue;

    if (!isJustDoCustomProviderKey(providerKey) || !isRecord(previousProvider) || !isRecord(nextProvider) ||
        previousProvider.enabled !== true ||
        typeof previousProvider.baseUrl !== 'string' || !previousProvider.baseUrl.trim() ||
        typeof previousProvider.apiKey !== 'string' || !previousProvider.apiKey.trim()) return;

    const { models: previousModels, ...previousConnection } = previousProvider;
    const { models: nextModels, ...nextConnection } = nextProvider;
    if (!Array.isArray(previousModels) || !Array.isArray(nextModels) ||
        nextModels.length <= previousModels.length ||
        !isDeepStrictEqual(previousConnection, nextConnection) ||
        !isDeepStrictEqual(previousModels, nextModels.slice(0, previousModels.length))) return;

    const seenIds = new Set<string>();
    const modelIds: string[] = [];
    let hasExistingEnabledModel = false;
    for (const [index, model] of nextModels.entries()) {
      if (!isRecord(model) || typeof model.id !== 'string' || !model.id ||
          model.id.trim() !== model.id || seenIds.has(model.id)) return;
      seenIds.add(model.id);
      const enabled = model.enabled === undefined || model.enabled === true;
      if (index < previousModels.length) {
        hasExistingEnabledModel ||= enabled;
      } else {
        if (!enabled) return;
        modelIds.push(model.id);
      }
    }
    if (!hasExistingEnabledModel) return;
    additions.push({ providerKey, modelIds });
  }
  return additions.length > 0 ? additions : undefined;
}
