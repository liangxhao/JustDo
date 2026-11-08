import { ipcMain } from 'electron';

import {
  normalizeSpeechServiceBaseUrl,
  resolveSpeechProtocolSelection,
  resolveSpeechVoiceSelection,
  SPEECH_PROTOCOL_IDS,
} from '../../../../plugins/sdk/speech-protocols';
import type { LocalSpeechSettings } from '../../../shared/speech/localSpeechSettings';
import {
  normalizeOnlineSpeechVoiceSelection,
  resolveOnlineSpeechBinding,
  resolveOnlineSpeechVoiceSelection,
} from '../../../shared/speech/onlineSpeechModels';
import {
  type OnlineTtsConfiguration,
  type OnlineTtsConfigurationUpdate,
  OnlineTtsIpc,
  type OnlineTtsStatus,
} from '../../../shared/speech/onlineTts';
import type { OpenClawRuntimeAdapter } from '../../engine/openclaw/openclawRuntimeAdapter';
import { buildSpeechCredentialSlot } from '../../openclaw/config/speech/speechCredentialSlot';
import {
  EXTENSION_SECRET_PROVIDER,
  saveExtensionSecrets,
} from '../../plugins/extensions/extensionSecretFile';
import {
  resolveOnlineReplySpeechProfile,
  withReplySpeechConfigurationId,
} from '../../speech/onlineReplySpeechProfile';
import { getSpeechConfigurationRevision } from '../../speech/speechConfigurationRevision';

interface Dependencies {
  getSettings: () => LocalSpeechSettings;
  getRuntime: () => OpenClawRuntimeAdapter | null;
  getModelCategory: () => unknown;
  getStateDir: () => string;
  requestGateway: <T>(method: string, params?: unknown) => Promise<T>;
  runConfigMutationExclusive?: <T>(operation: () => Promise<T>) => Promise<T>;
}

type TtsCatalog = { providers?: unknown };
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const readReplyProfile = (config: unknown): Record<string, unknown> => {
  const entries = record(record(record(config).plugins).entries);
  const runtimeServices = record(entries['runtime-services']);
  return record(record(runtimeServices.config).replySpeech);
};

const parseProviders = (catalog: TtsCatalog): OnlineTtsConfiguration['providers'] =>
  Array.isArray(catalog.providers) && catalog.providers.some(value => record(value).id === 'openai')
    ? [{ id: 'openai', label: 'OpenAI', configured: false }]
    : [];

export function registerOnlineTtsHandlers({
  getSettings,
  getRuntime,
  getModelCategory,
  getStateDir,
  requestGateway,
  runConfigMutationExclusive,
}: Dependencies): void {
  const requireRuntime = () => {
    if (!getRuntime()) throw new Error('OpenClaw Gateway is unavailable.');
  };
  const loadConfiguration = async (): Promise<OnlineTtsConfiguration> => {
    const expected = resolveOnlineReplySpeechProfile(getSettings(), getModelCategory());
    if (!expected) throw new Error('Reply speech is not configured.');
    const runtime = getRuntime();
    const client = runtime?.getGatewayClient();
    if (!runtime || !client) throw new Error('OpenClaw Gateway is unavailable.');
    const generation = runtime.getGatewayClientGeneration();
    const revision = getSpeechConfigurationRevision('output');
    const [catalog, snapshot] = await Promise.all([
      client.request<TtsCatalog>('tts.providers', {}, { timeoutMs: 5000 }),
      client.request<{
        config?: unknown;
        configRevisionHash?: unknown;
        appliedConfigHash?: unknown;
      }>('config.get', {}, { timeoutMs: 5000 }),
    ]);
    if (
      getRuntime() !== runtime ||
      runtime.getGatewayClient() !== client ||
      runtime.getGatewayClientGeneration() !== generation ||
      getSpeechConfigurationRevision('output') !== revision ||
      resolveOnlineReplySpeechProfile(getSettings(), getModelCategory())?.configurationId !==
        expected.configurationId
    )
      throw new Error('Online speech configuration or connection changed.');
    if (
      typeof snapshot.configRevisionHash !== 'string' ||
      !snapshot.configRevisionHash.trim() ||
      snapshot.appliedConfigHash !== snapshot.configRevisionHash
    )
      throw new Error('Speech settings have not finished applying.');
    const providers = parseProviders(catalog);
    const profile = readReplyProfile(snapshot.config);
    if (profile.configurationId !== expected.configurationId)
      throw new Error('Speech settings have not finished applying.');
    const baseUrl = typeof profile.baseUrl === 'string' ? profile.baseUrl.trim() : '';
    const model = typeof profile.model === 'string' ? profile.model.trim() : '';
    let voiceSelection;
    try {
      const protocol = resolveSpeechProtocolSelection(
        profile,
        'speech',
        SPEECH_PROTOCOL_IDS.SPEECH_HTTP,
      );
      normalizeSpeechServiceBaseUrl(baseUrl, protocol);
      voiceSelection = resolveSpeechVoiceSelection(
        profile.voiceSelection,
        protocol,
        profile.voicePolicy ?? 'preset',
        profile.speakerVoice,
      );
    } catch {
      voiceSelection = undefined;
    }
    const voice = voiceSelection?.kind === 'preset' ? voiceSelection.voiceId : '';
    const configured = Boolean(
      baseUrl === expected.baseUrl && model === expected.model &&
      profile.protocolId === expected.protocolId &&
      profile.voicePolicy === expected.voicePolicy &&
      voice === expected.speakerVoice && profile.speakerVoice === expected.speakerVoice &&
      voiceSelection,
    );
    const available = configured && providers.length > 0;
    return {
      available,
      providers: providers.map(provider => ({ ...provider, configured })),
      ...(providers.length ? { selectedProvider: 'openai' } : {}),
      ...(available ? { provider: 'openai' } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(model ? { model } : {}),
      ...(voice ? { voice } : {}),
      ...(voiceSelection ? { voiceSelection } : {}),
      credentialConfigured: Boolean(profile.apiKey),
    };
  };
  ipcMain.handle(OnlineTtsIpc.GetStatus, async (): Promise<OnlineTtsStatus> => {
    try {
      const configuration = await loadConfiguration();
      return {
        available: configuration.available,
        ...(configuration.provider ? { provider: configuration.provider } : {}),
      };
    } catch (error) {
      return { available: false, error: error instanceof Error ? error.name : 'GatewayError' };
    }
  });
  ipcMain.handle(OnlineTtsIpc.GetConfiguration, async (): Promise<OnlineTtsConfiguration> => {
    try {
      return await loadConfiguration();
    } catch (error) {
      return {
        available: false,
        providers: [],
        credentialConfigured: false,
        error: error instanceof Error ? error.name : 'GatewayError',
      };
    }
  });
  ipcMain.handle(
    OnlineTtsIpc.SaveConfiguration,
    async (_event, update: OnlineTtsConfigurationUpdate): Promise<void> => {
      requireRuntime();
      if (
        !update ||
        typeof update.modelRef !== 'string' ||
        update.modelRef.length > 512 ||
        (update.voice !== undefined &&
          (typeof update.voice !== 'string' || update.voice.length > 256)) ||
        (update.bindingId !== undefined &&
          (typeof update.bindingId !== 'string' || update.bindingId.length > 64)) ||
        Object.keys(update).some(
          key => !['modelRef', 'bindingId', 'voice', 'voiceSelection'].includes(key),
        )
      )
        throw new Error('Invalid online speech configuration.');
      const mutate = async () => {
        const selection = resolveOnlineSpeechBinding(
          getModelCategory(),
          update.modelRef,
          update.bindingId ?? '',
          'tts',
        );
        const voiceSelection = selection
          ? resolveOnlineSpeechVoiceSelection(
              selection.model,
              selection.binding,
              normalizeOnlineSpeechVoiceSelection(update.voiceSelection, update.voice),
            )
          : null;
        if (!selection || !voiceSelection)
          throw new Error('The selected online speech model or voice is unavailable.');
        const baseUrl = normalizeSpeechServiceBaseUrl(
          selection.provider.baseUrl,
          selection.binding,
        );
        const catalog = await requestGateway<TtsCatalog>('tts.providers', {});
        if (!parseProviders(catalog).length) throw new Error('Unknown online speech provider.');
        const snapshot = await requestGateway<{ hash?: unknown; config?: unknown }>('config.get');
        if (typeof snapshot.hash !== 'string' || !snapshot.hash)
          throw new Error('Online speech configuration is unavailable.');
        const nativeConfig = record(snapshot.config);
        const apiKey = selection.provider.apiKey.trim();
        const slot = buildSpeechCredentialSlot('replySpeech', baseUrl, apiKey);
        const references: Record<string, Record<string, string>> = apiKey
          ? saveExtensionSecrets(nativeConfig, getStateDir(), 'runtime-services', {
              [slot]: apiKey,
            }).references
          : {};
        await requestGateway('config.patch', {
          raw: JSON.stringify({
            ...(apiKey
              ? {
                  secrets: {
                    providers: {
                      [EXTENSION_SECRET_PROVIDER]: record(record(nativeConfig.secrets).providers)[
                        EXTENSION_SECRET_PROVIDER
                      ],
                    },
                  },
                }
              : {}),
            plugins: {
              entries: {
                'runtime-services': {
                  config: {
                    replySpeech: {
                      ...withReplySpeechConfigurationId({
                        baseUrl,
                        model: selection.model.id,
                        protocolId: selection.binding.protocolId,
                        voicePolicy: selection.binding.voicePolicy ?? 'preset',
                        voiceSelection,
                        speakerVoice: voiceSelection.voiceId,
                        apiKey,
                      }),
                      apiKey: references[slot] ?? '',
                    },
                  },
                },
                openai: { enabled: true },
              },
            },
          }),
          baseHash: snapshot.hash,
        });
      };
      await (runConfigMutationExclusive ? runConfigMutationExclusive(mutate) : mutate());
    },
  );
  ipcMain.handle(OnlineTtsIpc.ClearConfiguration, async (): Promise<void> => {
    requireRuntime();
    const mutate = async () => {
      const snapshot = await requestGateway<{ hash?: unknown }>('config.get');
      if (typeof snapshot.hash !== 'string' || !snapshot.hash)
        throw new Error('Online speech configuration is unavailable.');
      await requestGateway('config.patch', {
        raw: JSON.stringify({
          plugins: { entries: { 'runtime-services': { config: { replySpeech: null } } } },
        }),
        baseHash: snapshot.hash,
      });
    };
    await (runConfigMutationExclusive ? runConfigMutationExclusive(mutate) : mutate());
  });
}
