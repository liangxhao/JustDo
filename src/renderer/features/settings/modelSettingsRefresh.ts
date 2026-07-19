import { type AppConfig, getProviderDisplayName } from '@/app/config';
import type { Model } from '@/features/models/modelSlice';

type ProvidersConfig = NonNullable<AppConfig['providers']>;

export const mergeRefreshedBuiltinProvider = (
  currentProviders: ProvidersConfig,
  refreshedProviders: AppConfig['providers'],
): ProvidersConfig => {
  const refreshedBuiltinProvider = refreshedProviders?.builtin_models;
  if (!refreshedBuiltinProvider) {
    return currentProviders;
  }

  return {
    ...currentProviders,
    builtin_models: {
      ...refreshedBuiltinProvider,
      apiFormat: 'openai',
      models: refreshedBuiltinProvider.models?.map(model => ({
        ...model,
        supportsImage: model.supportsImage ?? false,
      })),
    },
  };
};

export const getEnabledProviderModels = (providers: AppConfig['providers']): Model[] =>
  Object.entries(providers ?? {}).flatMap(([providerName, providerConfig]) =>
    providerConfig.enabled
      ? (providerConfig.models ?? []).map(model => ({
          id: model.id,
          name: model.name,
          provider: getProviderDisplayName(providerName, providerConfig),
          providerKey: providerName,
          supportsImage: model.supportsImage ?? false,
          contextLength: model.contextLength,
          maxTokens: model.maxTokens,
        }))
      : [],
  );
