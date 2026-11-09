import {
  normalizeSpeechServiceBaseUrl,
  SPEECH_PROTOCOL_IDS,
} from '../../../../../plugins/sdk/speech-protocols';
import { normalizeLocalSpeechExtensionSettings } from '../../../../shared/speech/localSpeechExtensionSettings';
import { normalizeLocalSpeechSettings } from '../../../../shared/speech/localSpeechSettings';
import { LOCAL_TTS_PROVIDER_ID } from '../../../../shared/speech/localTts';
import {
  type OnlineSpeechVoiceSelection,
  resolveOnlineSpeechBinding,
  resolveOnlineSpeechVoiceSelection,
} from '../../../../shared/speech/onlineSpeechModels';
import { saveExtensionSecrets } from '../../../plugins/extensions/extensionSecretFile';
import { resolveOnlineReplySpeechProfile } from '../../../speech/onlineReplySpeechProfile';
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
  realtimeModels?: unknown;
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
  const online = (kind: 'stt' | 'tts', reference: string, bindingId: string, selectedVoice?: OnlineSpeechVoiceSelection | null) => {
    const category = kind === 'stt' ? settings.recognitionModels : settings.synthesisModels;
    const selection = resolveOnlineSpeechBinding(category, reference, bindingId, kind === 'stt' ? 'stt-tool' : 'tts');
    if (
      !selection ||
      selection.model.id.length > 256 ||
      selection.provider.apiKey.length > 16384 ||
      /[\r\n\0]/.test(selection.provider.apiKey)
    )
      return null;
    const voiceSelection = kind === 'tts' ? resolveOnlineSpeechVoiceSelection(selection.model, selection.binding, selectedVoice) : null;
    if (kind === 'tts' && !voiceSelection) return null;
    try {
      const baseUrl = normalizeSpeechServiceBaseUrl(selection.provider.baseUrl, selection.binding);
      if (baseUrl.length > 2048) return null;
      return {
        baseUrl,
        model: selection.model.id,
        apiKey: selection.provider.apiKey.trim(),
        protocolId: selection.binding.protocolId,
        ...(kind === 'tts' ? {
          voicePolicy: selection.binding.voicePolicy ?? 'preset', voiceSelection,
          ...(voiceSelection?.kind === 'preset' ? { speakerVoice: voiceSelection.voiceId } : {}),
        } : {}),
      };
    } catch {
      return null;
    }
  };
  const withSecret = <T extends { apiKey: string; baseUrl: string }>(
    target: T,
    owner: string,
    scope: string,
  ) => {
    if (!target.apiKey) return target;
    const field = buildSpeechCredentialSlot(scope, target.baseUrl, target.apiKey);
    const secret = saveExtensionSecrets(config, stateDir, owner, { [field]: target.apiKey });
    secretsChanged ||= secret.changed;
    return { ...target, apiKey: secret.references[field] };
  };

  const inputSelection =
    voice.inputEnabled &&
    voice.recognitionMode === 'online' &&
    voice.onlineAsrModelRef
      ? resolveOnlineSpeechBinding(settings.recognitionModels, voice.onlineAsrModelRef, voice.onlineAsrBindingId, 'composer-asr')
      : null;
  const inputProfile = inputSelection?.binding.protocolId === SPEECH_PROTOCOL_IDS.TRANSCRIPTION_REALTIME
    ? withSecret(
        {
          baseUrl: inputSelection.provider.baseUrl.trim(),
          model: inputSelection.model.id,
          apiKey: inputSelection.provider.apiKey.trim(),
          protocolId: inputSelection.binding.protocolId,
          configurationId: buildSpeechCredentialSlot('composerAsr', inputSelection.provider.baseUrl.trim(), inputSelection.provider.apiKey.trim()),
        },
        'openai',
        'composerAsr',
      )
    : null;

  const sttSelection =
    extensions.sttMode === 'online' ? online('stt', extensions.onlineSttModelRef, extensions.onlineSttBindingId) : null;
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
      ? online('tts', extensions.onlineTtsModelRef, extensions.onlineTtsBindingId, extensions.onlineTtsVoiceSelection)
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

  const reply = resolveOnlineReplySpeechProfile(voice, settings.synthesisModels);
  const realtime = voice.realtimeEnabled
    ? resolveOnlineSpeechBinding(settings.realtimeModels, voice.realtimeModelRef, voice.realtimeBindingId, 'realtime-voice')
    : null;
  const realtimeVoice = realtime
    ? resolveOnlineSpeechVoiceSelection(realtime.model, realtime.binding, voice.realtimeVoiceSelection)
    : null;
  const realtimeProfile = realtime && realtimeVoice?.kind === 'preset' && realtime.binding.inputTranscriptionModel
    ? withSecret({
      baseUrl: realtime.provider.baseUrl.trim(), model: realtime.model.id,
      speakerVoice: realtimeVoice.voiceId, apiKey: realtime.provider.apiKey.trim(),
      protocolId: realtime.binding.protocolId, inputTranscriptionModel: realtime.binding.inputTranscriptionModel,
      configurationId: buildSpeechCredentialSlot('realtimeVoice', realtime.provider.baseUrl.trim(), realtime.provider.apiKey.trim()),
    }, 'openai', 'realtimeVoice')
    : null;
  const nextPlugins = record(config.plugins);
  const nextEntries = record(nextPlugins.entries);
  const runtime = record(nextEntries['runtime-services']);
  const openai = record(nextEntries.openai);
  const { realtimeVoice: previousRealtimeValue, ...retainedOpenaiConfig } = record(openai.config);
  const previousRealtime = record(previousRealtimeValue);
  config.plugins = {
    ...nextPlugins,
    entries: {
      ...nextEntries,
      openai: {
        ...openai,
        config: {
          ...retainedOpenaiConfig,
          transcription: inputProfile,
          ...(realtimeProfile ? { realtimeVoice: realtimeProfile } : {}),
        },
      },
      'runtime-services': {
        ...runtime,
        config: {
          ...record(runtime.config),
          replySpeech: reply ? withSecret(reply, 'runtime-services', 'replySpeech') : null,
        },
      },
    },
  };
  if (realtimeProfile) {
    const talk = record(config.talk);
    config.talk = {
      ...talk,
      realtime: {
        ...record(talk.realtime),
        provider: 'openai', transport: 'gateway-relay', consultRouting: 'force-agent-consult',
        model: realtimeProfile.model, speakerVoice: realtimeProfile.speakerVoice,
      },
    };
  } else if (typeof previousRealtime.model === 'string' && typeof previousRealtime.speakerVoice === 'string') {
    const talk = record(config.talk);
    const managed = { provider: 'openai', transport: 'gateway-relay', consultRouting: 'force-agent-consult',
      model: previousRealtime.model, speakerVoice: previousRealtime.speakerVoice };
    const retained = { ...record(talk.realtime) };
    for (const [field, value] of Object.entries(managed)) {
      if (retained[field] === value) delete retained[field];
    }
    if (Object.keys(retained).length) config.talk = { ...talk, realtime: retained };
    else {
      const retainedTalk = { ...talk };
      delete retainedTalk.realtime;
      config.talk = retainedTalk;
    }
  }
  if (reply || inputProfile || realtimeProfile || ttsSelection) {
    config.plugins = mergeOpenClawPluginConfig(record(config.plugins), {
      openai: { enabled: true },
    });
  }
  return secretsChanged;
}
