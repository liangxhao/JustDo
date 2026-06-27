import { app } from 'electron';
import { join } from 'path';

import { ProviderName, resolveCodingPlanBaseUrl } from '../../shared/providers';
import type { SqliteStore } from '../sqliteStore';
import type { CoworkApiConfig } from './coworkConfigStore';
import { type AnthropicApiFormat,normalizeProviderApiFormat } from './coworkFormatTransform';
import {
  configureCoworkOpenAICompatProxy,
  getCoworkOpenAICompatProxyBaseURL,
  getCoworkOpenAICompatProxyStatus,
  type OpenAICompatProxyTarget,
} from './coworkOpenAICompatProxy';

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
  apiFormat?: 'anthropic' | 'openai' | 'native';
  codingPlanEnabled?: boolean;
  models?: ProviderModel[];
  displayName?: string; // 用于 OpenClaw providerId
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
    codingPlanEnabled: boolean;
    supportsImage?: boolean;
    modelName?: string;
    displayName?: string; // 新增：用于 OpenClaw providerId
    contextLength?: number; // 用户配置的上下文窗口长度
    maxTokens?: number; // 用户配置的最大输出 token 数量
  };
};

// Store getter function injected from main.ts
let storeGetter: (() => SqliteStore | null) | null = null;

export function setStoreGetter(getter: () => SqliteStore | null): void {
  storeGetter = getter;
}

// Auth token getter injected from main.ts for server model provider
let authTokensGetter: (() => { accessToken: string; refreshToken: string } | null) | null = null;

export function setAuthTokensGetter(
  getter: () => { accessToken: string; refreshToken: string } | null,
): void {
  authTokensGetter = getter;
}

// Server base URL getter injected from main.ts
let serverBaseUrlGetter: (() => string) | null = null;

export function setServerBaseUrlGetter(getter: () => string): void {
  serverBaseUrlGetter = getter;
}

// Cached server model metadata (populated when auth:getModels is called)
// Keyed by modelId → { supportsImage }
let serverModelMetadataCache: Map<string, { supportsImage?: boolean }> = new Map();

export function updateServerModelMetadata(
  models: Array<{ modelId: string; supportsImage?: boolean }>,
): void {
  serverModelMetadataCache = new Map(
    models.map(m => [m.modelId, { supportsImage: m.supportsImage }]),
  );
}

export function clearServerModelMetadata(): void {
  serverModelMetadataCache.clear();
}

export function getAllServerModelMetadata(): Array<{ modelId: string; supportsImage?: boolean }> {
  return Array.from(serverModelMetadataCache.entries()).map(([modelId, meta]) => ({
    modelId,
    supportsImage: meta.supportsImage,
  }));
}

const getStore = (): SqliteStore | null => {
  if (!storeGetter) {
    return null;
  }
  return storeGetter();
};

type MatchedProvider = {
  providerName: string;
  providerConfig: ProviderConfig;
  modelId: string;
  apiFormat: AnthropicApiFormat;
  baseURL: string;
  supportsImage?: boolean;
  modelName?: string;
  contextLength?: number; // 用户配置的上下文窗口长度
  maxTokens?: number; // 用户配置的最大输出 token 数量
};

function getEffectiveProviderApiFormat(
  _providerName: string,
  apiFormat: unknown,
): AnthropicApiFormat {
  return normalizeProviderApiFormat(apiFormat);
}

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
      if (
        !providerConfig?.enabled ||
        !providerConfig.models ||
        providerConfig.models.length === 0
      ) {
        continue;
      }
      const fallbackModel = providerConfig.models.find(model => model.id?.trim());
      if (!fallbackModel) {
        continue;
      }
      return {
        providerName,
        providerConfig,
        modelId: fallbackModel.id.trim(),
      };
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
    if (
      preferredProvider?.enabled &&
      preferredProvider.models?.some(model => model.id === modelId)
    ) {
      providerEntry = [preferredProviderName, preferredProvider];
    }
  }

  if (!providerEntry) {
    providerEntry = Object.entries(providers).find(([, provider]) => {
      if (!provider?.enabled || !provider.models) {
        return false;
      }
      return provider.models.some(model => model.id === modelId);
    });
  }

  if (!providerEntry) {
    const fallback = resolveFallbackModel();
    if (fallback) {
      modelId = fallback.modelId;
      providerEntry = [fallback.providerName, fallback.providerConfig];
    } else {
      return { matched: null, error: `No enabled provider found for model: ${modelId}` };
    }
  }

  const [providerName, providerConfig] = providerEntry;
  let apiFormat = getEffectiveProviderApiFormat(providerName, providerConfig.apiFormat);
  let baseURL = providerConfig.baseUrl?.trim();

  if (providerConfig.codingPlanEnabled) {
    const resolved = resolveCodingPlanBaseUrl(providerName, true, apiFormat, baseURL ?? '');
    baseURL = resolved.baseUrl;
    apiFormat = resolved.effectiveFormat;
  }

  if (!baseURL) {
    return { matched: null, error: `Provider ${providerName} is missing base URL.` };
  }

  // Check for API key or OAuth credentials
  const hasApiKey = providerConfig.apiKey?.trim();
  const hasOAuthCreds = providerName === 'qwen' && (providerConfig as any).oauthCredentials;
  if (
    apiFormat === 'anthropic' &&
    providerRequiresApiKey(providerName) &&
    !providerConfig.apiKey?.trim() &&
    !hasApiKey &&
    !hasOAuthCreds
  ) {
    return {
      matched: null,
      error: `Provider ${providerName} requires API key for Anthropic-compatible mode.`,
    };
  }

  const matchedModel = providerConfig.models?.find(m => m.id === modelId);

  return {
    matched: {
      providerName,
      providerConfig,
      modelId,
      apiFormat,
      baseURL,
      supportsImage: matchedModel?.supportsImage,
      modelName: matchedModel?.name,
      contextLength: matchedModel?.contextLength,
      maxTokens: matchedModel?.maxTokens,
    },
  };
}

export function resolveCurrentApiConfig(
  target: OpenAICompatProxyTarget = 'local',
): ApiConfigResolution {
  const sqliteStore = getStore();
  if (!sqliteStore) {
    return {
      config: null,
      error: 'Store is not initialized.',
    };
  }

  const appConfig = sqliteStore.get<AppConfig>('app_config');
  if (!appConfig) {
    return {
      config: null,
      error: 'Application config not found.',
    };
  }

  const { matched, error } = resolveMatchedProvider(appConfig);
  if (!matched) {
    return {
      config: null,
      error,
    };
  }

  const resolvedBaseURL = matched.baseURL;
  let resolvedApiKey = matched.providerConfig.apiKey?.trim() || '';

  // Handle Qwen OAuth credentials
  if (
    matched.providerName === 'qwen' &&
    !resolvedApiKey &&
    (matched.providerConfig as any).oauthCredentials
  ) {
    const oauthCreds = (matched.providerConfig as any).oauthCredentials;
    // Check if token is still valid (with 5 minute buffer)
    const expiryBuffer = 5 * 60 * 1000;
    if (Date.now() < oauthCreds.expires - expiryBuffer) {
      resolvedApiKey = oauthCreds.access; // Use access token as API key
    } else {
      // Token expired, should refresh in background
      console.warn('Qwen OAuth token expired, please refresh credentials');
      resolvedApiKey = oauthCreds.access; // Still try to use it, server might refresh
    }
  }

  // Providers that don't require auth (e.g. Ollama) still need a non-empty
  // placeholder so downstream components (OpenClaw gateway, compat proxy)
  // don't reject the request with "No API key found for provider".
  const effectiveApiKey =
    resolvedApiKey || (!providerRequiresApiKey(matched.providerName) ? 'sk-JustDo-local' : '');

  if (matched.apiFormat === 'anthropic') {
    return {
      config: {
        apiKey: effectiveApiKey,
        baseURL: resolvedBaseURL,
        model: matched.modelId,
        apiType: 'anthropic',
      },
      providerMetadata: {
        providerName: matched.providerName,
        codingPlanEnabled: !!matched.providerConfig.codingPlanEnabled,
        supportsImage: matched.supportsImage,
        contextLength: matched.contextLength,
        maxTokens: matched.maxTokens,
      },
    };
  }

  const proxyStatus = getCoworkOpenAICompatProxyStatus();
  if (!proxyStatus.running) {
    return {
      config: null,
      error: 'OpenAI compatibility proxy is not running.',
    };
  }

  configureCoworkOpenAICompatProxy({
    baseURL: resolvedBaseURL,
    apiKey: resolvedApiKey || undefined,
    model: matched.modelId,
    provider: matched.providerName,
  });

  const proxyBaseURL = getCoworkOpenAICompatProxyBaseURL(target);
  if (!proxyBaseURL) {
    return {
      config: null,
      error: 'OpenAI compatibility proxy base URL is unavailable.',
    };
  }

  return {
    config: {
      apiKey: resolvedApiKey || 'JustDo-openai-compat',
      baseURL: proxyBaseURL,
      model: matched.modelId,
      apiType: 'openai',
    },
    providerMetadata: {
      providerName: matched.providerName,
      codingPlanEnabled: !!matched.providerConfig.codingPlanEnabled,
      contextLength: matched.contextLength,
      maxTokens: matched.maxTokens,
    },
  };
}

export function getCurrentApiConfig(
  target: OpenAICompatProxyTarget = 'local',
): CoworkApiConfig | null {
  return resolveCurrentApiConfig(target).config;
}

/**
 * Resolve the raw API config directly from the app config,
 * without requiring the OpenAI compatibility proxy.
 * Used by OpenClaw config sync which has its own model routing.
 */
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
  let apiKey = matched.providerConfig.apiKey?.trim() || '';
  let effectiveBaseURL = matched.baseURL;
  let effectiveApiFormat = matched.apiFormat;

  // Handle Qwen OAuth credentials for OpenClaw gateway
  if (
    matched.providerName === 'qwen' &&
    !apiKey &&
    (matched.providerConfig as any).oauthCredentials
  ) {
    const oauthCreds = (matched.providerConfig as any).oauthCredentials;
    // Check if token is still valid (with 5 minute buffer)
    const expiryBuffer = 5 * 60 * 1000;
    if (Date.now() < oauthCreds.expires - expiryBuffer) {
      apiKey = oauthCreds.access; // Use access token as API key

      // Use OAuth resourceUrl as baseURL if available
      if (oauthCreds.resourceUrl) {
        effectiveBaseURL = normalizeQwenBaseUrl(oauthCreds.resourceUrl);
        effectiveApiFormat = 'openai'; // OAuth endpoints use OpenAI format

        // Map specific model IDs to OAuth endpoint model names
        matched.modelId = mapQwenModelToOAuthModel(matched.modelId, matched.supportsImage);
      }
    } else {
      // Token expired, should refresh in background
      console.warn('Qwen OAuth token expired for OpenClaw gateway, please refresh credentials');
      apiKey = oauthCreds.access; // Still try to use it, server might refresh

      if (oauthCreds.resourceUrl) {
        effectiveBaseURL = normalizeQwenBaseUrl(oauthCreds.resourceUrl);
        effectiveApiFormat = 'openai';

        // Map specific model IDs to OAuth endpoint model names
        matched.modelId = mapQwenModelToOAuthModel(matched.modelId, matched.supportsImage);
      }
    }
  }

  console.log(
    '[ClaudeSettings] resolved raw API config:',
    JSON.stringify({
      ...matched,
      providerConfig: { ...matched.providerConfig, apiKey: apiKey ? '***' : '' },
    }),
  );
  // OpenClaw's gateway requires a non-empty apiKey for every provider — even
  // local servers (Ollama, vLLM, etc.) that don't enforce auth.  When the user
  // leaves the key blank we supply a placeholder so the gateway doesn't reject
  // the request with "No API key found for provider".
  const effectiveApiKey =
    apiKey || (!providerRequiresApiKey(matched.providerName) ? 'sk-JustDo-local' : '');
  return {
    config: {
      apiKey: effectiveApiKey,
      baseURL: effectiveBaseURL,
      model: matched.modelId,
      apiType: effectiveApiFormat === 'anthropic' ? 'anthropic' : 'openai',
    },
    providerMetadata: {
      providerName: matched.providerName,
      codingPlanEnabled: !!matched.providerConfig.codingPlanEnabled,
      supportsImage: matched.supportsImage,
      modelName: matched.modelName,
      displayName: matched.providerConfig.displayName?.trim(), // 新增：用于 OpenClaw providerId
      contextLength: matched.contextLength,
      maxTokens: matched.maxTokens,
    },
  };
}

function normalizeQwenBaseUrl(value: string | undefined): string {
  const DEFAULT_BASE_URL = 'https://portal.qwen.ai/v1';
  const raw = value?.trim() || DEFAULT_BASE_URL;
  const withProtocol = raw.startsWith('http') ? raw : `https://${raw}`;
  return withProtocol.endsWith('/v1') ? withProtocol : `${withProtocol.replace(/\/+$/, '')}/v1`;
}

/**
 * Map JustDo model IDs to OAuth endpoint model names
 * OAuth endpoint only supports 'coder-model' and 'vision-model'
 */
function mapQwenModelToOAuthModel(modelId: string, supportsImage?: boolean): string {
  // If the model supports image input, use vision-model
  if (supportsImage) {
    return 'vision-model';
  }

  // For all other models (including qwen3.5-plus, qwen3-coder-plus), use coder-model
  return 'coder-model';
}
/**
 * Collect apiKeys for ALL configured providers (not just the currently selected one).
 * Used by OpenClaw config sync to pre-register all apiKeys as env vars at gateway
 * startup, so switching between providers doesn't require a process restart.
 *
 * Returns a map of env-var-safe provider name → apiKey.
 */
export function resolveAllProviderApiKeys(): Record<string, string> {
  const result: Record<string, string> = {};

  // All configured custom providers
  const sqliteStore = getStore();
  if (!sqliteStore) return result;
  const appConfig = sqliteStore.get<AppConfig>('app_config');
  if (!appConfig?.providers) return result;

  for (const [providerName, providerConfig] of Object.entries(appConfig.providers)) {
    if (!providerConfig?.enabled) continue;
    const apiKey = providerConfig.apiKey?.trim();
    if (!apiKey && providerRequiresApiKey(providerName)) continue;
    const envName = providerName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    result[envName] = apiKey || 'sk-JustDo-local';
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
  apiType: 'anthropic' | 'openai';
  codingPlanEnabled: boolean;
  models: Array<{
    id: string;
    name?: string;
    supportsImage?: boolean;
    contextLength?: number;
    maxTokens?: number;
  }>;
  displayName?: string; // 新增：用于 OpenClaw 配置中的 providerId
};

export function resolveAllEnabledProviderConfigs(): ProviderRawConfig[] {
  const sqliteStore = getStore();
  if (!sqliteStore) return [];
  const appConfig = sqliteStore.get<AppConfig>('app_config');
  if (!appConfig?.providers) return [];

  const result: ProviderRawConfig[] = [];

  for (const [providerName, providerConfig] of Object.entries(appConfig.providers)) {
    if (!providerConfig?.enabled) continue;

    const apiKey = providerConfig.apiKey?.trim() || '';
    if (!apiKey && providerRequiresApiKey(providerName)) continue;

    const baseURL = providerConfig.baseUrl?.trim() || '';

    let effectiveBaseURL = baseURL;
    let effectiveApiFormat = getEffectiveProviderApiFormat(providerName, providerConfig.apiFormat);

    if (providerConfig.codingPlanEnabled) {
      const resolved = resolveCodingPlanBaseUrl(
        providerName,
        true,
        effectiveApiFormat,
        effectiveBaseURL,
      );
      effectiveBaseURL = resolved.baseUrl;
      effectiveApiFormat = resolved.effectiveFormat;
    }

    if (!effectiveBaseURL) continue;

    const models = (providerConfig.models ?? []).filter(m => m.id?.trim());
    if (models.length === 0) continue;

    // 获取 displayName（仅对 custom provider 有意义）
    const displayName = providerConfig.displayName?.trim();

    result.push({
      providerName,
      baseURL: effectiveBaseURL,
      apiKey: apiKey || 'sk-JustDo-local',
      apiType: effectiveApiFormat === 'anthropic' ? 'anthropic' : 'openai',
      codingPlanEnabled: !!providerConfig.codingPlanEnabled,
      models,
      displayName,
    });
  }

  return result;
}

/**
 * 获取所有 custom provider 的 displayName 映射
 * 用于 openclaw.json 中将 custom_0 等转换为用户设置的显示名称
 */
export function getProviderDisplayNameMap(): Record<string, string> {
  const result: Record<string, string> = {};
  const sqliteStore = getStore();
  if (!sqliteStore) return result;
  const appConfig = sqliteStore.get<AppConfig>('app_config');
  if (!appConfig?.providers) return result;

  for (const [providerName, providerConfig] of Object.entries(appConfig.providers)) {
    // 只处理 custom_* provider
    if (!providerName.startsWith('custom_')) continue;
    const displayName = providerConfig.displayName?.trim();
    if (displayName) {
      result[providerName] = displayName;
    }
  }

  return result;
}
