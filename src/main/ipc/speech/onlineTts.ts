import { ipcMain } from 'electron';

import {
  getOnlineSpeechVoiceOptions,
  normalizeOnlineSpeechBaseUrl,
  resolveOnlineSpeechModel,
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

interface Dependencies {
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
    requireRuntime();
    const [catalog, snapshot] = await Promise.all([
      requestGateway<TtsCatalog>('tts.providers', {}),
      requestGateway<{ config?: unknown }>('config.get'),
    ]);
    const providers = parseProviders(catalog);
    const profile = readReplyProfile(snapshot.config);
    const baseUrl = typeof profile.baseUrl === 'string' ? profile.baseUrl.trim() : '';
    const model = typeof profile.model === 'string' ? profile.model.trim() : '';
    const voice = typeof profile.speakerVoice === 'string' ? profile.speakerVoice.trim() : '';
    const configured = Boolean(baseUrl && model && voice);
    const available = configured && providers.length > 0;
    return {
      available,
      providers: providers.map(provider => ({ ...provider, configured })),
      ...(providers.length ? { selectedProvider: 'openai' } : {}),
      ...(available ? { provider: 'openai' } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(model ? { model } : {}),
      ...(voice ? { voice } : {}),
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
        typeof update.voice !== 'string' ||
        !update.voice.trim() ||
        update.voice.length > 256 ||
        Object.keys(update).some(key => key !== 'modelRef' && key !== 'voice')
      )
        throw new Error('Invalid online speech configuration.');
      const mutate = async () => {
        const selection = resolveOnlineSpeechModel(getModelCategory(), update.modelRef);
        const voice = update.voice.trim();
        if (
          !selection ||
          !getOnlineSpeechVoiceOptions(selection.model).some(option => option.value === voice)
        )
          throw new Error('The selected online speech model or voice is unavailable.');
        const baseUrl = normalizeOnlineSpeechBaseUrl(selection.provider.baseUrl, 'tts');
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
                      baseUrl,
                      model: selection.model.id,
                      speakerVoice: voice,
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
