import type { AppConfig } from '@/app/config';

type ProvidersConfig = NonNullable<AppConfig['providers']>;

export const mergeRefreshedBuiltinProvider = (
  currentProviders: ProvidersConfig,
  refreshedProviders: AppConfig['providers'],
): ProvidersConfig => {
  const refreshedBuiltinProvider = refreshedProviders?.builtin_models;
  if (!refreshedBuiltinProvider) {
    // Keep the settings entry without retaining revoked models or credentials.
    return {
      ...currentProviders,
      builtin_models: {
        enabled: false,
        readonly: true,
        apiKey: '',
        baseUrl: '',
        apiFormat: 'openai',
        models: [],
      },
    };
  }

  const currentEnabledById = new Map(
    (currentProviders.builtin_models?.models ?? []).map(model => [
      model.id,
      model.enabled !== false,
    ]),
  );

  return {
    ...currentProviders,
    builtin_models: {
      ...refreshedBuiltinProvider,
      apiFormat: 'openai',
      models: refreshedBuiltinProvider.models?.map(model => ({
        ...model,
        enabled: currentEnabledById.get(model.id) ?? model.enabled ?? true,
        supportsImage: model.supportsImage ?? false,
      })),
    },
  };
};
