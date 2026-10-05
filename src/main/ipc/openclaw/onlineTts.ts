import { ipcMain } from 'electron';

import {
  type OnlineTtsConfiguration,
  type OnlineTtsConfigurationUpdate,
  OnlineTtsIpc,
  type OnlineTtsStatus,
} from '../../../shared/speech/onlineTts';
import type { OpenClawRuntimeAdapter } from '../../engine/openclaw/openclawRuntimeAdapter';

interface Dependencies {
  getRuntime: () => OpenClawRuntimeAdapter | null;
  requestGateway: <T>(method: string, params?: unknown) => Promise<T>;
  runConfigMutationExclusive?: <T>(operation: () => Promise<T>) => Promise<T>;
}

type TtsCatalog = {
  active?: unknown;
  providers?: unknown;
};

const MAX_PROVIDER_ID_LENGTH = 64;
const MAX_BASE_URL_LENGTH = 2_048;
const MAX_MODEL_ID_LENGTH = 256;
const MAX_VOICE_ID_LENGTH = 256;
const MAX_API_KEY_LENGTH = 16_384;
const SUPPORTED_PROVIDER_IDS = new Set(['openai']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const parseProviders = (catalog: TtsCatalog): OnlineTtsConfiguration['providers'] => {
  const byId = new Map<string, OnlineTtsConfiguration['providers'][number]>();
  if (!Array.isArray(catalog.providers)) return [];
  for (const value of catalog.providers) {
    if (!isRecord(value) || typeof value.id !== 'string' || !SUPPORTED_PROVIDER_IDS.has(value.id)) {
      continue;
    }
    byId.set(value.id, {
      id: value.id,
      label: typeof value.name === 'string' ? value.name : value.id,
      configured: value.configured === true,
    });
  }
  return [...byId.values()];
};

const readTtsConfig = (config: unknown): Record<string, unknown> =>
  isRecord(config) && isRecord(config.tts) ? config.tts : {};

const readProviderFields = (
  providerConfig: Record<string, unknown>,
): { baseUrl?: string; model?: string; voice?: string } => {
  return {
    ...(typeof providerConfig.baseUrl === 'string' ? { baseUrl: providerConfig.baseUrl } : {}),
    ...(typeof providerConfig.model === 'string'
      ? { model: providerConfig.model }
      : {}),
    ...(typeof providerConfig.voice === 'string'
      ? { voice: providerConfig.voice }
      : {}),
  };
};

const resolveConfiguration = (
  catalog: TtsCatalog,
  config: unknown,
): OnlineTtsConfiguration => {
  const providers = parseProviders(catalog);
  const tts = readTtsConfig(config);
  const configuredProvider = typeof tts.provider === 'string' ? tts.provider : undefined;
  const selectedProvider = providers.some(provider => provider.id === configuredProvider)
    ? configuredProvider
    : providers[0]?.id;
  const providerConfigs = isRecord(tts.providers) ? tts.providers : {};
  const selectedConfig =
    selectedProvider && isRecord(providerConfigs[selectedProvider])
      ? providerConfigs[selectedProvider]
      : {};
  const fields = readProviderFields(selectedConfig);
  const selectedCatalogProvider = providers.find(provider => provider.id === selectedProvider);
  const activeOnlineProvider =
    typeof catalog.active === 'string' && SUPPORTED_PROVIDER_IDS.has(catalog.active)
      ? catalog.active
      : undefined;
  const available =
    selectedProvider !== undefined &&
    activeOnlineProvider === selectedProvider &&
    selectedCatalogProvider?.configured === true &&
    Boolean(fields.baseUrl?.trim() && fields.model?.trim() && fields.voice?.trim());
  return {
    available,
    providers,
    ...(activeOnlineProvider ? { provider: activeOnlineProvider } : {}),
    ...(selectedProvider ? { selectedProvider } : {}),
    ...fields,
    credentialConfigured: selectedCatalogProvider?.configured === true,
  };
};

export function registerOnlineTtsHandlers({
  getRuntime,
  requestGateway,
  runConfigMutationExclusive,
}: Dependencies): void {
  const requireRuntime = (): void => {
    if (!getRuntime()) throw new Error('OpenClaw Gateway is unavailable.');
  };

  const loadConfiguration = async (): Promise<OnlineTtsConfiguration> => {
    requireRuntime();
    const [catalog, snapshot] = await Promise.all([
      requestGateway<TtsCatalog>('tts.providers', {}),
      requestGateway<{ config?: unknown }>('config.get'),
    ]);
    return resolveConfiguration(catalog, snapshot.config);
  };

  ipcMain.handle(OnlineTtsIpc.GetStatus, async (): Promise<OnlineTtsStatus> => {
    try {
      const configuration = await loadConfiguration();
      return {
        available: configuration.available,
        ...(configuration.provider ? { provider: configuration.provider } : {}),
      };
    } catch (error) {
      return {
        available: false,
        error: error instanceof Error ? error.name : 'GatewayError',
      };
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
      const provider = typeof update?.provider === 'string' ? update.provider.trim() : '';
      const baseUrl = typeof update?.baseUrl === 'string' ? update.baseUrl.trim() : '';
      const apiKey = typeof update?.apiKey === 'string' ? update.apiKey.trim() : '';
      const model = typeof update?.model === 'string' ? update.model.trim() : '';
      const voice = typeof update?.voice === 'string' ? update.voice.trim() : '';
      let parsedBaseUrl: URL;
      try {
        parsedBaseUrl = new URL(baseUrl);
      } catch {
        throw new Error('Invalid online speech service URL.');
      }
      if (
        !SUPPORTED_PROVIDER_IDS.has(provider) ||
        provider.length > MAX_PROVIDER_ID_LENGTH ||
        !baseUrl ||
        baseUrl.length > MAX_BASE_URL_LENGTH ||
        !['http:', 'https:'].includes(parsedBaseUrl.protocol) ||
        Boolean(parsedBaseUrl.username || parsedBaseUrl.password) ||
        apiKey.length > MAX_API_KEY_LENGTH ||
        !model ||
        model.length > MAX_MODEL_ID_LENGTH ||
        !voice ||
        voice.length > MAX_VOICE_ID_LENGTH
      ) {
        throw new Error('Invalid online speech configuration.');
      }
      const catalog = await requestGateway<TtsCatalog>('tts.providers', {});
      const selectedProvider = parseProviders(catalog).find(candidate => candidate.id === provider);
      if (!selectedProvider) throw new Error('Unknown online speech provider.');
      if (!apiKey && !selectedProvider.configured) {
        throw new Error('Online speech API key is required.');
      }
      const mutate = async (): Promise<void> => {
      const snapshot = await requestGateway<{ hash?: unknown; config?: unknown }>('config.get');
      if (typeof snapshot.hash !== 'string' || !snapshot.hash) {
        throw new Error('Online speech configuration is unavailable.');
      }
      const existingTts = readTtsConfig(snapshot.config);
      const existingProvider = typeof existingTts.provider === 'string' ? existingTts.provider : '';
      const existingProviders = isRecord(existingTts.providers) ? existingTts.providers : {};
      const existingProviderConfig = isRecord(existingProviders[provider])
        ? existingProviders[provider]
        : {};
      const existingBaseUrl =
        typeof existingProviderConfig.baseUrl === 'string'
          ? existingProviderConfig.baseUrl.trim()
          : '';
      if (!apiKey && (existingProvider !== provider || existingBaseUrl !== baseUrl)) {
        throw new Error('Online speech API key is required when changing the service URL.');
      }
      const providerConfig = { baseUrl, ...(apiKey ? { apiKey } : {}), model, voice };
      await requestGateway('config.patch', {
        raw: JSON.stringify({
          tts: {
            enabled: true,
            auto: 'off',
            provider,
            maxTextLength: 10_000,
            providers: { [provider]: providerConfig },
          },
          plugins: { entries: { [provider]: { enabled: true } } },
        }),
        baseHash: snapshot.hash,
      });
      };
      await (runConfigMutationExclusive ? runConfigMutationExclusive(mutate) : mutate());
    },
  );

  ipcMain.handle(OnlineTtsIpc.ClearConfiguration, async (): Promise<void> => {
    requireRuntime();
    const mutate = async (): Promise<void> => {
    const snapshot = await requestGateway<{ hash?: unknown }>('config.get');
    if (typeof snapshot.hash !== 'string' || !snapshot.hash) {
      throw new Error('Online speech configuration is unavailable.');
    }
    await requestGateway('config.patch', {
      raw: JSON.stringify({ tts: null }),
      baseHash: snapshot.hash,
    });
    };
    await (runConfigMutationExclusive ? runConfigMutationExclusive(mutate) : mutate());
  });
}
