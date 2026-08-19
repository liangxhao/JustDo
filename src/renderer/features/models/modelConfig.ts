import type { AppConfig } from '@/app/config';
import { getProviderDisplayName } from '@/app/config';
import type { Model } from '@/features/models/modelSlice';

export const BUILTIN_MODELS_UPDATED_EVENT = 'builtin-models-updated';

export const getEnabledProviderModels = (providers: AppConfig['providers']): Model[] =>
  Object.entries(providers ?? {}).flatMap(([providerName, providerConfig]) =>
    providerConfig.enabled
      ? (providerConfig.models ?? [])
          .filter(model => model.enabled !== false)
          .map(model => ({
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
