import { normalizeOpenClawProviderId, validateCustomProviderDisplayName } from '@shared/providers';

import type { AppConfig } from '@/app/config';
import { i18nService } from '@/services/i18n';

import {
  type NonLanguageModelKind,
  normalizeNonLanguageModelBaseUrl,
} from './nonLanguageModelUrls';

export type NonLanguageModelProviders = NonNullable<AppConfig['onlineModelProviders']>;
export type NonLanguageModelCategory = NonNullable<NonLanguageModelProviders[NonLanguageModelKind]>;

export const NON_LANGUAGE_MODEL_KINDS: readonly NonLanguageModelKind[] = [
  'speech-recognition',
  'speech-synthesis',
  'image',
  'video',
];

export const createEmptyNonLanguageModelCategory = (): NonLanguageModelCategory => ({
  providers: {},
});

export const normalizeNonLanguageModelCategory = (
  kind: NonLanguageModelKind,
  category: NonLanguageModelCategory,
): NonLanguageModelCategory => {
  const supportsCatalogDefault = kind === 'image' || kind === 'video';
  const providerIds = Object.keys(category.providers);
  const defaultProviderId =
    supportsCatalogDefault &&
    category.defaultProviderId &&
    category.providers[category.defaultProviderId]
      ? category.defaultProviderId
      : supportsCatalogDefault
        ? providerIds[0]
        : undefined;
  return {
    providers: Object.fromEntries(
      Object.entries(category.providers).map(([id, provider]) => [
        id,
        supportsCatalogDefault
          ? {
              ...provider,
              baseUrl: normalizeNonLanguageModelBaseUrl(kind, provider.baseUrl),
            }
          : {
              displayName: provider.displayName,
              baseUrl: normalizeNonLanguageModelBaseUrl(kind, provider.baseUrl),
              apiKey: provider.apiKey,
              models: provider.models.map(model => ({
                id: model.id,
                name: model.name,
                ...(kind === 'speech-synthesis' && model.voices?.length
                  ? { voices: model.voices }
                  : {}),
              })),
            },
      ]),
    ),
    ...(defaultProviderId ? { defaultProviderId } : {}),
  };
};

const getProviderValidationError = (
  kind: NonLanguageModelKind,
  category: NonLanguageModelCategory,
  providerId: string,
): string => {
  const provider = category.providers[providerId];
  if (!provider?.displayName.trim()) return i18nService.t('customModelProviderNameRequired');
  const nameValidation = validateCustomProviderDisplayName(provider.displayName);
  if (!nameValidation.valid) {
    return i18nService.t(
      nameValidation.reason === 'reserved' ? 'providerNameReserved' : 'providerNameInvalid',
    );
  }
  const normalizedName = normalizeOpenClawProviderId(provider.displayName);
  const duplicateName = Object.entries(category.providers).some(
    ([id, candidate]) =>
      id !== providerId && normalizeOpenClawProviderId(candidate.displayName) === normalizedName,
  );
  if (duplicateName) return i18nService.t('providerNameExists');
  try {
    const url = new URL(normalizeNonLanguageModelBaseUrl(kind, provider.baseUrl));
    const protocols =
      kind === 'speech-recognition' ? ['http:', 'https:', 'ws:', 'wss:'] : ['http:', 'https:'];
    if (!protocols.includes(url.protocol) || url.username || url.password) throw new Error();
  } catch {
    return i18nService.t('customModelProviderUrlInvalid');
  }
  if (kind === 'image' || kind === 'video') {
    if (!provider.defaultModel) return i18nService.t('customModelDefaultRequired');
    if (!provider.models.some(model => model.id === provider.defaultModel)) {
      return i18nService.t('customModelDefaultRequired');
    }
  }
  return '';
};

const MEDIA_MODEL_KINDS = ['image', 'video'] as const;

const getMediaRuntimeConfigurationSignature = (category: NonLanguageModelCategory): string => {
  const providerId = category.defaultProviderId;
  const provider = providerId ? category.providers[providerId] : undefined;
  if (!provider?.defaultModel) return 'null';
  return JSON.stringify({
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey.trim() || 'local',
    model: provider.defaultModel,
  });
};

const syncMediaRuntimeConfiguration = async (
  kind: (typeof MEDIA_MODEL_KINDS)[number],
  category: NonLanguageModelCategory,
): Promise<void> => {
  const providerId = category.defaultProviderId;
  const provider = providerId ? category.providers[providerId] : undefined;
  if (!provider?.defaultModel) {
    await window.electron.mediaGenerationModels.saveConfiguration(kind, {
      primary: '',
      fallbacks: [],
    });
    return;
  }
  await window.electron.mediaGenerationModels.saveConfiguration(kind, {
    primary: `openai/${provider.defaultModel}`,
    fallbacks: [],
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey.trim() || 'local',
  });
};

export const getNonLanguageModelCategoryValidationError = (
  kind: NonLanguageModelKind,
  category: NonLanguageModelCategory,
  activeProviderId?: string,
): string => {
  const providerIds = Object.keys(category.providers);
  const orderedProviderIds =
    activeProviderId && category.providers[activeProviderId]
      ? [activeProviderId, ...providerIds.filter(providerId => providerId !== activeProviderId)]
      : providerIds;
  for (const providerId of orderedProviderIds) {
    const provider = category.providers[providerId];
    const error = getProviderValidationError(kind, category, providerId);
    if (!error) continue;
    return providerId === activeProviderId
      ? error
      : i18nService
          .t('customModelProviderInvalid')
          .replace('{provider}', provider.displayName || providerId)
          .replace('{error}', error);
  }
  return '';
};

export const commitNonLanguageModelConfigurations = async (
  current: NonLanguageModelProviders,
  draft: NonLanguageModelProviders,
  persist: (normalized: NonLanguageModelProviders) => Promise<void>,
): Promise<NonLanguageModelProviders> => {
  const normalized = { ...draft };
  const changedRuntimeKinds: Array<(typeof MEDIA_MODEL_KINDS)[number]> = [];
  for (const kind of NON_LANGUAGE_MODEL_KINDS) {
    const category = draft[kind];
    if (!category) continue;
    normalized[kind] = normalizeNonLanguageModelCategory(kind, category);
  }

  try {
    for (const kind of MEDIA_MODEL_KINDS) {
      const normalizedCategory = normalized[kind];
      if (!normalizedCategory) continue;
      const currentCategory = normalizeNonLanguageModelCategory(
        kind,
        current[kind] ?? createEmptyNonLanguageModelCategory(),
      );
      if (
        getMediaRuntimeConfigurationSignature(currentCategory) !==
        getMediaRuntimeConfigurationSignature(normalizedCategory)
      ) {
        changedRuntimeKinds.push(kind);
        await syncMediaRuntimeConfiguration(kind, normalizedCategory);
      }
    }
    await persist(normalized);
    return normalized;
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const kind of changedRuntimeKinds.reverse()) {
      try {
        await syncMediaRuntimeConfiguration(
          kind,
          normalizeNonLanguageModelCategory(
            kind,
            current[kind] ?? createEmptyNonLanguageModelCategory(),
          ),
        );
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new Error(i18nService.t('nonLanguageModelRollbackFailed'));
    }
    throw error;
  }
};
