import { normalizeLocalSpeechExtensionSettings } from '../../../shared/speech/localSpeechExtensionSettings';
import { normalizeLocalSpeechSettings } from '../../../shared/speech/localSpeechSettings';

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
      onlineTtsModelRef: voice.onlineTtsModelRef,
      onlineTtsVoice: voice.onlineTtsVoice,
    },
  });
};
