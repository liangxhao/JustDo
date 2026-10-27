import { normalizeLocalSpeechExtensionSettings } from '../../../../shared/speech/localSpeechExtensionSettings';
import { normalizeLocalSpeechSettings } from '../../../../shared/speech/localSpeechSettings';
import { LOCAL_TTS_PROVIDER_ID } from '../../../../shared/speech/localTts';
import {
  getOnlineSpeechModelOptions,
  getOnlineSpeechVoiceOptions,
  normalizeOnlineSpeechBaseUrl,
  resolveOnlineSpeechModel,
} from '../../../../shared/speech/onlineSpeechModels';
import { saveExtensionSecrets } from '../../../plugins/extensions/extensionSecretFile';
import { mergeOpenClawPluginConfig } from '../plugins/pluginProjection';
import {
  buildLocalSpeechExtensionSttConfig,
  buildLocalSpeechExtensionTtsConfig,
} from './localSpeechExtensionConfig';
import { normalizeNativeTtsConfig } from './nativeTtsConfig';
import { buildSpeechCredentialSlot } from './speechCredentialSlot';

export interface ManagedSpeechModelSettings {
  extensions: unknown;
  voice: unknown;
  recognitionModels: unknown;
  synthesisModels: unknown;
  language: 'zh' | 'en';
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function applyManagedSpeechModelConfiguration(
  config: Record<string, unknown>,
  settings: ManagedSpeechModelSettings,
  stateDir: string,
): boolean {
  const extensions = normalizeLocalSpeechExtensionSettings(settings.extensions);
  const voice = normalizeLocalSpeechSettings(settings.voice);
  let secretsChanged = false;
  const online = (kind: 'stt' | 'tts', reference: string, selectedVoice?: string) => {
    const category = kind === 'stt' ? settings.recognitionModels : settings.synthesisModels;
    if (
      !getOnlineSpeechModelOptions(category, {
        fileTranscription: true,
        requireVoice: kind === 'tts',
      }).some(option => option.value === reference)
    )
      return null;
    const selection = resolveOnlineSpeechModel(category, reference);
    if (
      !selection ||
      selection.model.id.length > 256 ||
      selection.provider.apiKey.length > 16384 ||
      /[\r\n\0]/.test(selection.provider.apiKey)
    )
      return null;
    if (
      kind === 'tts' &&
      (!selectedVoice ||
        selectedVoice.length > 256 ||
        !getOnlineSpeechVoiceOptions(selection.model).some(
          option => option.value === selectedVoice,
        ))
    )
      return null;
    try {
      const baseUrl = normalizeOnlineSpeechBaseUrl(selection.provider.baseUrl, kind);
      if (baseUrl.length > 2048) return null;
      return {
        baseUrl,
        model: selection.model.id,
        apiKey: selection.provider.apiKey.trim(),
        ...(kind === 'tts' ? { speakerVoice: selectedVoice } : {}),
      };
    } catch {
      return null;
    }
  };
  const withSecret = (
    target: Record<string, unknown> & { apiKey: string; baseUrl: string },
    owner: string,
    scope: string,
  ) => {
    if (!target.apiKey) return target;
    const field = buildSpeechCredentialSlot(scope, target.baseUrl, target.apiKey);
    const secret = saveExtensionSecrets(config, stateDir, owner, { [field]: target.apiKey });
    secretsChanged ||= secret.changed;
    return { ...target, apiKey: secret.references[field] };
  };

  const sttSelection =
    extensions.sttMode === 'online' ? online('stt', extensions.onlineSttModelRef) : null;
  const sttConfig =
    extensions.sttMode === 'online'
      ? {
          mode: 'online',
          language: settings.language,
          ...(sttSelection ? withSecret(sttSelection, 'stt-local-cli', 'stt') : {}),
        }
      : (buildLocalSpeechExtensionSttConfig(extensions, settings.language) ?? { mode: 'local' });
  const plugins = record(config.plugins);
  const entries = record(plugins.entries);
  config.plugins = {
    ...plugins,
    entries: {
      ...entries,
      'stt-local-cli': { ...record(entries['stt-local-cli']), config: sttConfig },
    },
  };

  const ttsSelection =
    extensions.ttsMode === 'online'
      ? online('tts', extensions.onlineTtsModelRef, extensions.onlineTtsVoice)
      : null;
  const local =
    extensions.ttsMode === 'local' ? buildLocalSpeechExtensionTtsConfig(extensions) : null;
  const toolProvider =
    extensions.ttsMode === 'online'
      ? {
          mode: 'online',
          ...(ttsSelection ? withSecret(ttsSelection, LOCAL_TTS_PROVIDER_ID, 'tts') : {}),
        }
      : record(record(local?.providers)[LOCAL_TTS_PROVIDER_ID]);
  const previous = normalizeNativeTtsConfig(config.tts) ?? {};
  config.tts = {
    ...previous,
    auto: 'off',
    provider: LOCAL_TTS_PROVIDER_ID,
    persona: 'assistant-speech',
    providers: { ...record(previous.providers), [LOCAL_TTS_PROVIDER_ID]: toolProvider },
    personas: {
      ...record(previous.personas),
      'assistant-speech': {
        provider: LOCAL_TTS_PROVIDER_ID,
        fallbackPolicy: 'fail',
        providers: { [LOCAL_TTS_PROVIDER_ID]: toolProvider },
      },
    },
  };

  const reply =
    voice.synthesisMode === 'online'
      ? online('tts', voice.onlineTtsModelRef, voice.onlineTtsVoice)
      : null;
  const nextPlugins = record(config.plugins);
  const nextEntries = record(nextPlugins.entries);
  const runtime = record(nextEntries['runtime-services']);
  config.plugins = {
    ...nextPlugins,
    entries: {
      ...nextEntries,
      'runtime-services': {
        ...runtime,
        config: {
          ...record(runtime.config),
          replySpeech: reply ? withSecret(reply, 'runtime-services', 'replySpeech') : null,
        },
      },
    },
  };
  if (reply) {
    config.plugins = mergeOpenClawPluginConfig(record(config.plugins), {
      openai: { enabled: true },
    });
  }
  return secretsChanged;
}
