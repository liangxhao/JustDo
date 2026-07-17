import {
  type AppConfig,
  getCustomProviderDefaultName,
  getProviderDisplayName,
  isCustomProvider,
  validateDisplayName,
} from '@/app/config';
import { EXPORT_FORMAT_TYPE } from '@/app/constants/app';
import type { PasswordEncryptedPayload } from '@/services/encryption';

type ProvidersConfig = NonNullable<AppConfig['providers']>;
type ProviderConfig = ProvidersConfig[string];

export const PROVIDERS_EXPORT_VERSION = 3;

export type SerializedProviderConfig = Omit<
  ProviderConfig,
  'apiKey' | 'displayName' | 'readonly'
> & {
  apiKey: PasswordEncryptedPayload | string;
  displayName: string;
};

export interface ProvidersExportPayload {
  type: typeof EXPORT_FORMAT_TYPE;
  version: typeof PROVIDERS_EXPORT_VERSION;
  providers: SerializedProviderConfig[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const normalizeDisplayName = (name: string): string => name.trim().toLowerCase();

const parseProviderConfig = (
  value: unknown,
  fallbackDisplayName?: string,
): SerializedProviderConfig => {
  if (!isRecord(value)) {
    throw new Error('Invalid provider configuration');
  }

  const displayName =
    typeof value.displayName === 'string' && value.displayName.trim()
      ? value.displayName.trim()
      : fallbackDisplayName;
  if (!displayName || !validateDisplayName(displayName).valid) {
    throw new Error('Invalid provider display name');
  }
  if (
    typeof value.enabled !== 'boolean' ||
    typeof value.baseUrl !== 'string' ||
    !('apiKey' in value)
  ) {
    throw new Error('Invalid provider configuration');
  }

  const { readonly: _readonly, ...config } = value;
  return {
    ...(config as Omit<SerializedProviderConfig, 'displayName'>),
    displayName,
  };
};

export const createProvidersExportPayload = (
  providers: Array<{ key: string; config: ProviderConfig; apiKey: PasswordEncryptedPayload }>,
): ProvidersExportPayload => ({
  type: EXPORT_FORMAT_TYPE,
  version: PROVIDERS_EXPORT_VERSION,
  providers: providers.map(({ key, config, apiKey }) => {
    const { readonly: _readonly, ...exportedConfig } = config;
    return {
      ...exportedConfig,
      apiKey,
      displayName: getProviderDisplayName(key, config).trim(),
    };
  }),
});

export const parseProvidersImportPayload = (payload: unknown): SerializedProviderConfig[] => {
  if (!isRecord(payload) || payload.type !== EXPORT_FORMAT_TYPE) {
    throw new Error('Invalid providers file');
  }

  let parsedProviders: SerializedProviderConfig[];
  if (payload.version === PROVIDERS_EXPORT_VERSION && Array.isArray(payload.providers)) {
    parsedProviders = payload.providers.map(provider => parseProviderConfig(provider));
  } else if (payload.version === 2 && isRecord(payload.providers)) {
    parsedProviders = Object.entries(payload.providers).map(([key, provider]) => {
      if (!isCustomProvider(key)) {
        throw new Error('Invalid legacy provider key');
      }
      return parseProviderConfig(provider, getCustomProviderDefaultName(key));
    });
  } else {
    throw new Error('Unsupported providers file version');
  }

  const names = new Set<string>();
  for (const provider of parsedProviders) {
    const normalizedName = normalizeDisplayName(provider.displayName);
    if (names.has(normalizedName)) {
      throw new Error('Duplicate provider display name');
    }
    names.add(normalizedName);
  }
  return parsedProviders;
};

export const mergeImportedProviders = (
  existingProviders: ProvidersConfig,
  importedProviders: ProviderConfig[],
): ProvidersConfig => {
  const mergedProviders = { ...existingProviders };
  const usedKeys = new Set(Object.keys(existingProviders));
  const providerKeyByName = new Map<string, string>();

  for (const [key, config] of Object.entries(existingProviders)) {
    if (isCustomProvider(key)) {
      providerKeyByName.set(normalizeDisplayName(getProviderDisplayName(key, config)), key);
    }
  }

  const allocateProviderKey = (): string => {
    let index = 0;
    while (usedKeys.has(`custom_${index}`)) {
      index += 1;
    }
    const key = `custom_${index}`;
    usedKeys.add(key);
    return key;
  };

  for (const config of importedProviders) {
    const displayName = config.displayName?.trim();
    if (!displayName) {
      throw new Error('Imported provider display name is required');
    }
    const normalizedName = normalizeDisplayName(displayName);
    const key = providerKeyByName.get(normalizedName) ?? allocateProviderKey();
    mergedProviders[key] = { ...config, displayName };
    providerKeyByName.set(normalizedName, key);
  }

  return mergedProviders;
};
