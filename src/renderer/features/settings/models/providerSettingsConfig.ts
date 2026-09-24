import { normalizeOpenClawProviderId } from '@shared/providers';

import {
  type AppConfig,
  defaultConfig,
  getCustomProviderDefaultName,
  isBuiltinModelsProvider,
  isCustomProvider,
} from '@/app/config';
import { i18nService } from '@/services/i18n';

export type ProviderType = string;

export type ProvidersConfig = NonNullable<AppConfig['providers']>;

export type ProviderConfig = ProvidersConfig[string];

export type ProviderConnectionTestResult = {
  success: boolean;
  message: string;
  provider: ProviderType;
  providerName: string;
  baseUrl?: string;
  modelLabel?: string;
  modelId?: string;
  log?: string;
  isRunning?: boolean;
  modelResults?: ModelConnectionTestResult[];
};

export type ModelConnectionTestResult = {
  success: boolean;
  modelLabel: string;
  modelId: string;
  detail: string;
  log?: string;
  status?: 'pending' | 'testing' | 'success' | 'failed';
};

export type ModelConnectionTestStatus = 'success' | 'failed';

export const providerRequiresApiKey = (provider: ProviderType) => provider !== 'builtin_models';

export const isProviderReadOnly = (provider: ProviderType, config?: ProviderConfig): boolean =>
  provider === 'builtin_models' || config?.readonly === true;

export const getProviderDefaultBaseUrl = (provider: ProviderType): string | null =>
  defaultConfig.providers?.[provider]?.baseUrl ?? null;

export const resolveBaseUrl = (provider: ProviderType, baseUrl: string): string => {
  if (baseUrl.trim()) {
    return baseUrl;
  }
  return getProviderDefaultBaseUrl(provider) || '';
};

export const toConnectivityRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export const getConnectivityErrorMessage = (data: unknown): string | null => {
  const record = toConnectivityRecord(data);
  if (!record) {
    return typeof data === 'string' && data.trim() ? data : null;
  }

  const error = toConnectivityRecord(record.error);
  if (typeof error?.message === 'string' && error.message.trim()) {
    return error.message;
  }

  if (typeof record.message === 'string' && record.message.trim()) {
    return record.message;
  }

  return null;
};

export const getDefaultProviders = (): ProvidersConfig => {
  const providers = (defaultConfig.providers ?? {}) as ProvidersConfig;
  const entries = Object.entries(providers) as Array<[string, ProviderConfig]>;
  const secureSuffix = i18nService.t('modelSuffixSecure');
  return Object.fromEntries(
    entries.map(([providerKey, providerConfig]) => [
      providerKey,
      {
        ...providerConfig,
        models: providerConfig.models?.map(model => ({
          ...model,
          name: model.name.replace('(Secure)', secureSuffix),
          enabled: model.enabled ?? true,
          supportsImage: model.supportsImage ?? false,
        })),
      },
    ]),
  ) as ProvidersConfig;
};

export const normalizeProvidersForSettings = (providers: ProvidersConfig): ProvidersConfig =>
  Object.fromEntries(
    Object.entries(providers).map(([providerKey, providerConfig]) => [
      providerKey,
      {
        ...providerConfig,
        apiFormat: 'openai',
        models: providerConfig.models?.map(model => ({
          ...model,
          enabled: model.enabled ?? true,
          supportsImage: model.supportsImage ?? false,
        })),
      },
    ]),
  ) as ProvidersConfig;

export const normalizeProvidersForSave = (providers: ProvidersConfig): ProvidersConfig =>
  Object.fromEntries(
    Object.entries(providers).map(([providerKey, providerConfig]) => [
      isCustomProvider(providerKey)
        ? normalizeOpenClawProviderId(
            providerConfig.displayName?.trim() || getCustomProviderDefaultName(providerKey),
          )
        : providerKey,
      {
        ...providerConfig,
        ...(isBuiltinModelsProvider(providerKey) ? { headers: undefined } : {}),
        displayName:
          isCustomProvider(providerKey) && !providerConfig.displayName?.trim()
            ? getCustomProviderDefaultName(providerKey)
            : providerConfig.displayName?.trim(),
        apiFormat: 'openai',
        baseUrl: resolveBaseUrl(providerKey, providerConfig.baseUrl),
      },
    ]),
  ) as ProvidersConfig;

export const getDefaultActiveProvider = (): ProviderType => {
  const providers = (defaultConfig.providers ?? {}) as ProvidersConfig;
  const firstEnabledProvider = Object.keys(providers).find(
    providerKey => providers[providerKey]?.enabled,
  );
  return firstEnabledProvider ?? 'builtin_models';
};

export const getCustomProviderKeysInOrder = (providers: ProvidersConfig): string[] =>
  Object.keys(providers).filter(isCustomProvider);

export const getNextCustomProvider = (
  providers: ProvidersConfig,
): { key: string; name: string } => {
  const usedKeys = new Set(Object.keys(providers));
  let index = 1;
  while (true) {
    const name = index === 1 ? 'Custom' : `Custom ${index}`;
    const key = normalizeOpenClawProviderId(name);
    if (!usedKeys.has(key)) return { key, name };
    index += 1;
  }
};
