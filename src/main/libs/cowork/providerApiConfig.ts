import { ProviderName } from '../../../shared/providers';
import type { SqliteStore } from '../../data/sqliteStore';
import type { CoworkApiConfig } from './coworkConfigStore';

type ProviderModel = {
  id: string;
  name?: string;
  supportsImage?: boolean;
  contextLength?: number;
  maxTokens?: number;
};

type ProviderConfig = {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  apiFormat?: 'openai';
  models?: ProviderModel[];
  displayName?: string;
};

type AppConfig = {
  model?: {
    defaultModel?: string;
    defaultModelProvider?: string;
  };
  providers?: Record<string, ProviderConfig>;
};

export type ApiConfigResolution = {
  config: CoworkApiConfig | null;
  error?: string;
  providerMetadata?: {
    providerName: string;
    supportsImage?: boolean;
    modelName?: string;
    displayName?: string;
    contextLength?: number;
    maxTokens?: number;
  };
};

let storeGetter: (() => SqliteStore | null) | null = null;

export function setStoreGetter(getter: () => SqliteStore | null): void {
  storeGetter = getter;
}

const getStore = (): SqliteStore | null => storeGetter?.() ?? null;

type MatchedProvider = {
  providerName: string;
  providerConfig: ProviderConfig;
  modelId: string;
  baseURL: string;
  supportsImage?: boolean;
  modelName?: string;
  contextLength?: number;
  maxTokens?: number;
};

function providerRequiresApiKey(providerName: string): boolean {
  return providerName !== ProviderName.Ollama;
}

function resolveMatchedProvider(appConfig: AppConfig): {
  matched: MatchedProvider | null;
  error?: string;
} {
  const providers = appConfig.providers ?? {};

  const resolveFallbackModel = (): {
    providerName: string;
    providerConfig: ProviderConfig;
    modelId: string;
  } | null => {
    for (const [providerName, providerConfig] of Object.entries(providers)) {
      if (!providerConfig?.enabled || !providerConfig.models?.length) {
        continue;
      }
      const fallbackModel = providerConfig.models.find(model => model.id?.trim());
      if (fallbackModel) {
        return {
          providerName,
          providerConfig,
          modelId: fallbackModel.id.trim(),
        };
      }
    }
    return null;
  };

  const configuredModelId = appConfig.model?.defaultModel?.trim();
  let modelId = configuredModelId || '';
  if (!modelId) {
    const fallback = resolveFallbackModel();
    if (!fallback) {
      return { matched: null, error: 'No available model configured in enabled providers.' };
    }
    modelId = fallback.modelId;
  }

  let providerEntry: [string, ProviderConfig] | undefined;
  const preferredProviderName = appConfig.model?.defaultModelProvider?.trim();

  if (preferredProviderName) {
    const preferredProvider = providers[preferredProviderName];
    if (preferredProvider?.enabled && preferredProvider.models?.some(model => model.id === modelId)) {
      providerEntry = [preferredProviderName, preferredProvider];
    }
  }

  providerEntry ??= Object.entries(providers).find(([, provider]) => {
    return !!provider?.enabled && !!provider.models?.some(model => model.id === modelId);
  });

  if (!providerEntry) {
    const fallback = resolveFallbackModel();
    if (!fallback) {
      return { matched: null, error: `No enabled provider found for model: ${modelId}` };
    }
    modelId = fallback.modelId;
    providerEntry = [fallback.providerName, fallback.providerConfig];
  }

  const [providerName, providerConfig] = providerEntry;
  const baseURL = providerConfig.baseUrl?.trim();
  if (!baseURL) {
    return { matched: null, error: `Provider ${providerName} is missing base URL.` };
  }

  if (providerRequiresApiKey(providerName) && !providerConfig.apiKey?.trim()) {
    return { matched: null, error: `Provider ${providerName} requires API key.` };
  }

  const matchedModel = providerConfig.models?.find(model => model.id === modelId);

  return {
    matched: {
      providerName,
      providerConfig,
      modelId,
      baseURL,
      supportsImage: matchedModel?.supportsImage,
      modelName: matchedModel?.name,
      contextLength: matchedModel?.contextLength,
      maxTokens: matchedModel?.maxTokens,
    },
  };
}

export function resolveCurrentApiConfig(): ApiConfigResolution {
  const sqliteStore = getStore();
  if (!sqliteStore) {
    return { config: null, error: 'Store is not initialized.' };
  }

  const appConfig = sqliteStore.get<AppConfig>('app_config');
  if (!appConfig) {
    return { config: null, error: 'Application config not found.' };
  }

  const { matched, error } = resolveMatchedProvider(appConfig);
  if (!matched) {
    return { config: null, error };
  }

  const apiKey = matched.providerConfig.apiKey?.trim() || '';
  const effectiveApiKey = apiKey || (!providerRequiresApiKey(matched.providerName) ? 'sk-justdo-local' : '');

  return {
    config: {
      apiKey: effectiveApiKey,
      baseURL: matched.baseURL,
      model: matched.modelId,
      apiType: 'openai',
    },
    providerMetadata: {
      providerName: matched.providerName,
      supportsImage: matched.supportsImage,
      modelName: matched.modelName,
      displayName: matched.providerConfig.displayName?.trim(),
      contextLength: matched.contextLength,
      maxTokens: matched.maxTokens,
    },
  };
}

export function getCurrentApiConfig(): CoworkApiConfig | null {
  return resolveCurrentApiConfig().config;
}

export function resolveRawApiConfig(): ApiConfigResolution {
  const sqliteStore = getStore();
  if (!sqliteStore) {
    console.debug('[ClaudeSettings] resolveRawApiConfig: store is null, storeGetter not set yet');
    return { config: null, error: 'Store is not initialized.' };
  }
  const appConfig = sqliteStore.get<AppConfig>('app_config');
  if (!appConfig) {
    console.debug('[ClaudeSettings] resolveRawApiConfig: app_config not found in store');
    return { config: null, error: 'Application config not found.' };
  }

  const { matched, error } = resolveMatchedProvider(appConfig);
  if (!matched) {
    const providerKeys = Object.keys(appConfig.providers ?? {});
    const defaultModel = appConfig.model?.defaultModel;
    const defaultProvider = appConfig.model?.defaultModelProvider;
    console.debug(
      `[ClaudeSettings] resolveRawApiConfig: no matched provider, error=${error}, providers=[${providerKeys.join(',')}], defaultModel=${defaultModel}, defaultProvider=${defaultProvider}`,
    );
    return { config: null, error };
  }

  const apiKey = matched.providerConfig.apiKey?.trim() || '';
  const effectiveApiKey = apiKey || (!providerRequiresApiKey(matched.providerName) ? 'sk-justdo-local' : '');
  console.log(
    '[ClaudeSettings] resolved raw API config:',
    JSON.stringify({
      ...matched,
      providerConfig: { ...matched.providerConfig, apiKey: apiKey ? '***' : '' },
    }),
  );

  return {
    config: {
      apiKey: effectiveApiKey,
      baseURL: matched.baseURL,
      model: matched.modelId,
      apiType: 'openai',
    },
    providerMetadata: {
      providerName: matched.providerName,
      supportsImage: matched.supportsImage,
      modelName: matched.modelName,
      displayName: matched.providerConfig.displayName?.trim(),
      contextLength: matched.contextLength,
      maxTokens: matched.maxTokens,
    },
  };
}

export function resolveAllProviderApiKeys(): Record<string, string> {
  const result: Record<string, string> = {};
  const sqliteStore = getStore();
  if (!sqliteStore) return result;
  const appConfig = sqliteStore.get<AppConfig>('app_config');
  const providers = appConfig?.providers ?? {};

  for (const [providerName, providerConfig] of Object.entries(providers)) {
    if (!providerConfig?.enabled) continue;
    const apiKey = providerConfig.apiKey?.trim();
    if (!apiKey && providerRequiresApiKey(providerName)) continue;
    const envName = providerName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    result[envName] = apiKey || 'sk-justdo-local';
  }

  return result;
}

export function buildEnvForConfig(config: CoworkApiConfig): Record<string, string> {
  const baseEnv = { ...process.env } as Record<string, string>;

  baseEnv.ANTHROPIC_AUTH_TOKEN = config.apiKey;
  baseEnv.ANTHROPIC_API_KEY = config.apiKey;
  baseEnv.ANTHROPIC_BASE_URL = config.baseURL;
  baseEnv.ANTHROPIC_MODEL = config.model;
  return baseEnv;
}

export type ProviderRawConfig = {
  providerName: string;
  baseURL: string;
  apiKey: string;
  apiType: 'openai';
  models: ProviderModel[];
  displayName?: string;
};

export function resolveAllEnabledProviderConfigs(): ProviderRawConfig[] {
  const sqliteStore = getStore();
  if (!sqliteStore) return [];
  const appConfig = sqliteStore.get<AppConfig>('app_config');
  const providers = appConfig?.providers ?? {};

  const result: ProviderRawConfig[] = [];

  for (const [providerName, providerConfig] of Object.entries(providers)) {
    if (!providerConfig?.enabled) continue;

    const apiKey = providerConfig.apiKey?.trim() || '';
    if (!apiKey && providerRequiresApiKey(providerName)) continue;

    const baseURL = providerConfig.baseUrl?.trim() || '';
    if (!baseURL) continue;

    const models = (providerConfig.models ?? []).filter(model => model.id?.trim());
    if (models.length === 0) continue;

    result.push({
      providerName,
      baseURL,
      apiKey: apiKey || 'sk-justdo-local',
      apiType: 'openai',
      models,
      displayName: providerConfig.displayName?.trim(),
    });
  }

  return result;
}

export function getProviderDisplayNameMap(): Record<string, string> {
  const result: Record<string, string> = {};
  const sqliteStore = getStore();
  if (!sqliteStore) return result;
  const appConfig = sqliteStore.get<AppConfig>('app_config');
  const providers = appConfig?.providers ?? {};

  for (const [providerName, providerConfig] of Object.entries(providers)) {
    if (!providerName.startsWith('custom_')) continue;
    const displayName = providerConfig.displayName?.trim();
    if (displayName) {
      result[providerName] = displayName;
    }
  }

  return result;
}
