import { normalizeOpenClawProviderId } from '@shared/providers';
import {
  MODEL_PROVIDER_HEADER_LIMITS,
  validateModelProviderHeaderName,
  validateModelProviderHeaderValue,
} from '@shared/providers/modelProviderHeaders';

import {
  type AppConfig,
  getProviderDisplayName,
  isCustomProvider,
  validateDisplayName,
} from '@/app/config';
import { EXPORT_FORMAT_TYPE } from '@/app/constants';
import type { NonLanguageModelKind } from '@/features/settings/models/nonLanguageModelUrls';
import type { PasswordEncryptedPayload } from '@/services/encryption';

type ProvidersConfig = NonNullable<AppConfig['providers']>;
type ProviderConfig = ProvidersConfig[string];
type OnlineModelProviders = NonNullable<AppConfig['onlineModelProviders']>;
type OnlineModelCategory = NonNullable<OnlineModelProviders[NonLanguageModelKind]>;
type OnlineModelProvider = OnlineModelCategory['providers'][string];

export const PROVIDERS_EXPORT_VERSION = 4;

export const TRANSFERRED_NON_LANGUAGE_MODEL_KINDS: readonly NonLanguageModelKind[] = [
  'speech-recognition',
  'speech-synthesis',
  'image',
  'video',
];

export type SerializedProviderConfig = Omit<
  ProviderConfig,
  'apiKey' | 'headers' | 'displayName' | 'identity' | 'readonly'
> & {
  apiKey: PasswordEncryptedPayload | string;
  headers?: Record<string, PasswordEncryptedPayload | string>;
  displayName: string;
};

export type SerializedOnlineModelProvider = Omit<OnlineModelProvider, 'apiKey'> & {
  apiKey: PasswordEncryptedPayload | string;
};

export interface SerializedOnlineModelCategory {
  defaultProvider?: string;
  providers: SerializedOnlineModelProvider[];
}

export interface ProvidersExportPayload {
  type: typeof EXPORT_FORMAT_TYPE;
  version: typeof PROVIDERS_EXPORT_VERSION;
  providers: SerializedProviderConfig[];
  onlineModelProviders: Partial<Record<NonLanguageModelKind, SerializedOnlineModelCategory>>;
}

export interface ParsedProvidersImportPayload {
  providers: SerializedProviderConfig[];
  onlineModelProviders: Partial<Record<NonLanguageModelKind, SerializedOnlineModelCategory>>;
}

export interface ExportedOnlineModelCategoryInput {
  defaultProviderId?: string;
  providers: Array<{
    key: string;
    config: OnlineModelProvider;
    apiKey: PasswordEncryptedPayload;
  }>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const normalizeDisplayName = (name: string): string => name.trim().toLowerCase();

const isPasswordEncryptedPayload = (value: unknown): value is PasswordEncryptedPayload =>
  isRecord(value) &&
  typeof value.encrypted === 'string' &&
  typeof value.iv === 'string' &&
  typeof value.salt === 'string';

const parseSerializedHeaders = (
  value: unknown,
): Record<string, PasswordEncryptedPayload | string> | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('Invalid provider headers');
  const entries = Object.entries(value);
  if (entries.length > MODEL_PROVIDER_HEADER_LIMITS.count) {
    throw new Error('Invalid provider headers');
  }
  const headers: Array<[string, PasswordEncryptedPayload | string]> = [];
  const seen = new Set<string>();
  for (const [rawName, headerValue] of entries) {
    const name = rawName.trim();
    const identity = name.toLowerCase();
    if (
      validateModelProviderHeaderName(name) ||
      seen.has(identity) ||
      (typeof headerValue !== 'string' && !isPasswordEncryptedPayload(headerValue)) ||
      (typeof headerValue === 'string' && validateModelProviderHeaderValue(headerValue))
    ) {
      throw new Error('Invalid provider headers');
    }
    seen.add(identity);
    headers.push([name, headerValue]);
  }
  return headers.length > 0 ? Object.fromEntries(headers) : undefined;
};

const parseProviderConfig = (value: unknown): SerializedProviderConfig => {
  if (!isRecord(value)) throw new Error('Invalid provider configuration');

  const displayName =
    typeof value.displayName === 'string' && value.displayName.trim()
      ? value.displayName.trim()
      : undefined;
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

  const { identity: _identity, readonly: _readonly, headers: rawHeaders, ...config } = value;
  const headers = parseSerializedHeaders(rawHeaders);
  return {
    ...(config as Omit<SerializedProviderConfig, 'displayName'>),
    ...(headers ? { headers } : {}),
    displayName,
  };
};

const validateUniqueProviderNames = (providers: Array<{ displayName: string }>): void => {
  const names = new Set<string>();
  for (const provider of providers) {
    const normalizedName = normalizeDisplayName(provider.displayName);
    if (names.has(normalizedName)) throw new Error('Duplicate provider display name');
    names.add(normalizedName);
  }
};

const parseOnlineModel = (value: unknown): OnlineModelProvider['models'][number] => {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !value.id.trim() ||
    typeof value.name !== 'string' ||
    !value.name.trim()
  ) {
    throw new Error('Invalid online model configuration');
  }
  if (value.voices !== undefined) {
    if (!Array.isArray(value.voices)) throw new Error('Invalid online model voices');
    const voiceIds = new Set<string>();
    for (const voice of value.voices) {
      if (
        !isRecord(voice) ||
        typeof voice.id !== 'string' ||
        !voice.id.trim() ||
        typeof voice.name !== 'string' ||
        !voice.name.trim() ||
        voiceIds.has(voice.id)
      ) {
        throw new Error('Invalid online model voices');
      }
      voiceIds.add(voice.id);
    }
  }
  return value as unknown as OnlineModelProvider['models'][number];
};

const parseOnlineModelProvider = (
  value: unknown,
  kind: NonLanguageModelKind,
): SerializedOnlineModelProvider => {
  if (
    !isRecord(value) ||
    typeof value.displayName !== 'string' ||
    !validateDisplayName(value.displayName).valid ||
    typeof value.baseUrl !== 'string' ||
    !('apiKey' in value) ||
    !Array.isArray(value.models)
  ) {
    throw new Error('Invalid online model provider configuration');
  }
  if (value.defaultModel !== undefined && typeof value.defaultModel !== 'string') {
    throw new Error('Invalid online model default');
  }
  const models = value.models.map(parseOnlineModel);
  const modelIds = new Set<string>();
  for (const model of models) {
    if (modelIds.has(model.id)) throw new Error('Duplicate online model id');
    modelIds.add(model.id);
  }
  if (
    (kind === 'image' || kind === 'video') &&
    (typeof value.defaultModel !== 'string' || !modelIds.has(value.defaultModel))
  ) {
    throw new Error('Invalid online model default');
  }
  return {
    displayName: value.displayName.trim(),
    baseUrl: value.baseUrl,
    apiKey: value.apiKey as PasswordEncryptedPayload | string,
    ...(typeof value.defaultModel === 'string' ? { defaultModel: value.defaultModel } : {}),
    models,
  };
};

const parseOnlineModelCategories = (
  value: unknown,
): ParsedProvidersImportPayload['onlineModelProviders'] => {
  if (!isRecord(value)) throw new Error('Invalid online model providers');
  const categories: ParsedProvidersImportPayload['onlineModelProviders'] = {};
  for (const kind of TRANSFERRED_NON_LANGUAGE_MODEL_KINDS) {
    const category = value[kind];
    if (category === undefined) continue;
    if (!isRecord(category) || !Array.isArray(category.providers)) {
      throw new Error('Invalid online model category');
    }
    if (category.defaultProvider !== undefined && typeof category.defaultProvider !== 'string') {
      throw new Error('Invalid online model default provider');
    }
    const providers = category.providers.map(provider => parseOnlineModelProvider(provider, kind));
    validateUniqueProviderNames(providers);
    if (
      typeof category.defaultProvider === 'string' &&
      !providers.some(
        provider =>
          normalizeDisplayName(provider.displayName) ===
          normalizeDisplayName(category.defaultProvider as string),
      )
    ) {
      throw new Error('Invalid online model default provider');
    }
    categories[kind] = {
      providers,
      ...(typeof category.defaultProvider === 'string'
        ? { defaultProvider: category.defaultProvider }
        : {}),
    };
  }
  return categories;
};

export const createProvidersExportPayload = (
  providers: Array<{
    key: string;
    config: Omit<ProviderConfig, 'headers'> & {
      headers?: Record<string, PasswordEncryptedPayload>;
    };
    apiKey: PasswordEncryptedPayload;
  }>,
  onlineModelProviders: Partial<
    Record<NonLanguageModelKind, ExportedOnlineModelCategoryInput>
  > = {},
): ProvidersExportPayload => ({
  type: EXPORT_FORMAT_TYPE,
  version: PROVIDERS_EXPORT_VERSION,
  providers: providers.map(({ key, config, apiKey }) => {
    const { identity: _identity, readonly: _readonly, ...exportedConfig } = config;
    return {
      ...exportedConfig,
      apiKey,
      displayName: getProviderDisplayName(key, config).trim(),
    };
  }),
  onlineModelProviders: Object.fromEntries(
    TRANSFERRED_NON_LANGUAGE_MODEL_KINDS.flatMap(kind => {
      const category = onlineModelProviders[kind];
      if (!category) return [];
      const defaultProvider = category.defaultProviderId
        ? category.providers.find(provider => provider.key === category.defaultProviderId)?.config
            .displayName
        : undefined;
      return [
        [
          kind,
          {
            providers: category.providers.map(({ config, apiKey }) => ({
              ...config,
              apiKey,
              displayName: config.displayName.trim(),
            })),
            ...(defaultProvider ? { defaultProvider } : {}),
          },
        ],
      ];
    }),
  ),
});

export const parseModelProvidersImportPayload = (
  payload: unknown,
): ParsedProvidersImportPayload => {
  if (!isRecord(payload) || payload.type !== EXPORT_FORMAT_TYPE) {
    throw new Error('Invalid providers file');
  }

  if (payload.version !== PROVIDERS_EXPORT_VERSION) {
    throw new Error('Unsupported providers file version');
  }
  if (!Array.isArray(payload.providers) || payload.onlineModelProviders === undefined) {
    throw new Error('Invalid providers file');
  }

  const parsedProviders = payload.providers.map(provider => parseProviderConfig(provider));
  const onlineModelProviders = parseOnlineModelCategories(payload.onlineModelProviders);
  validateUniqueProviderNames(parsedProviders);
  return { providers: parsedProviders, onlineModelProviders };
};

const getAvailableProviderId = (
  providers: Record<string, unknown>,
  displayName: string,
): string => {
  const base = normalizeOpenClawProviderId(displayName) || 'custom';
  if (!providers[base]) return base;
  let index = 2;
  while (providers[`${base}-${index}`]) index += 1;
  return `${base}-${index}`;
};

export const mergeImportedProviders = (
  existingProviders: ProvidersConfig,
  importedProviders: ProviderConfig[],
): ProvidersConfig => {
  const mergedProviders = { ...existingProviders };
  const providerKeyByName = new Map<string, string>();

  for (const [key, config] of Object.entries(existingProviders)) {
    if (isCustomProvider(key)) {
      providerKeyByName.set(normalizeDisplayName(getProviderDisplayName(key, config)), key);
    }
  }

  for (const config of importedProviders) {
    const displayName = config.displayName?.trim();
    if (!displayName) throw new Error('Imported provider display name is required');
    const normalizedName = normalizeDisplayName(displayName);
    const key =
      providerKeyByName.get(normalizedName) ?? getAvailableProviderId(mergedProviders, displayName);
    mergedProviders[key] = {
      ...config,
      displayName,
      identity: mergedProviders[key]?.identity ?? crypto.randomUUID(),
    };
    providerKeyByName.set(normalizedName, key);
  }

  return mergedProviders;
};

export const mergeImportedOnlineModelProviders = (
  existing: OnlineModelProviders,
  imported: Partial<
    Record<
      NonLanguageModelKind,
      Omit<SerializedOnlineModelCategory, 'providers'> & { providers: OnlineModelProvider[] }
    >
  >,
): OnlineModelProviders => {
  const merged: OnlineModelProviders = structuredClone(existing);
  for (const kind of TRANSFERRED_NON_LANGUAGE_MODEL_KINDS) {
    const importedCategory = imported[kind];
    if (!importedCategory) continue;
    const existingCategory = merged[kind] ?? { providers: {} };
    const providers = { ...existingCategory.providers };
    const providerIdByName = new Map(
      Object.entries(providers).map(([id, provider]) => [
        normalizeDisplayName(provider.displayName),
        id,
      ]),
    );
    for (const provider of importedCategory.providers) {
      const normalizedName = normalizeDisplayName(provider.displayName);
      const id =
        providerIdByName.get(normalizedName) ??
        getAvailableProviderId(providers, provider.displayName);
      providers[id] = provider;
      providerIdByName.set(normalizedName, id);
    }
    const defaultProviderId = importedCategory.defaultProvider
      ? providerIdByName.get(normalizeDisplayName(importedCategory.defaultProvider))
      : existingCategory.defaultProviderId;
    merged[kind] = {
      providers,
      ...(defaultProviderId ? { defaultProviderId } : {}),
    };
  }
  return merged;
};
