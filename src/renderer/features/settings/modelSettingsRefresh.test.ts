import { describe, expect, test } from 'vitest';

import type { AppConfig } from '@/app/config';
import {
  getEnabledProviderModels,
  mergeRefreshedBuiltinProvider,
} from '@/features/settings/modelSettingsRefresh';

type ProvidersConfig = NonNullable<AppConfig['providers']>;

const provider = (
  models: Array<{ id: string; name: string; supportsImage?: boolean }>,
  enabled = true,
): ProvidersConfig[string] => ({
  enabled,
  apiKey: '',
  baseUrl: 'https://example.com/v1',
  apiFormat: 'openai',
  models,
});

describe('model settings refresh', () => {
  test('replaces the built-in model list while preserving unsaved custom provider changes', () => {
    const currentProviders: ProvidersConfig = {
      builtin_models: provider([{ id: 'old-model', name: 'Old model' }]),
      custom_0: {
        ...provider([{ id: 'custom-model', name: 'Custom model' }]),
        displayName: 'Unsaved name',
      },
    };
    const refreshedProviders: ProvidersConfig = {
      builtin_models: provider([{ id: 'new-model', name: 'New model' }]),
    };

    const result = mergeRefreshedBuiltinProvider(currentProviders, refreshedProviders);

    expect(result.builtin_models.models).toEqual([
      { id: 'new-model', name: 'New model', supportsImage: false },
    ]);
    expect(result.custom_0).toBe(currentProviders.custom_0);
  });

  test('builds the global selector list from the refreshed enabled providers', () => {
    const providers: ProvidersConfig = {
      builtin_models: provider([{ id: 'new-model', name: 'New model', supportsImage: true }]),
      custom_0: provider([{ id: 'disabled-model', name: 'Disabled model' }], false),
    };

    expect(getEnabledProviderModels(providers)).toEqual([
      expect.objectContaining({
        id: 'new-model',
        providerKey: 'builtin_models',
        supportsImage: true,
      }),
    ]);
  });
});
