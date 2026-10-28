import { describe, expect, it } from 'vitest';

import { transformAppConfigCredentials } from './appConfigCredentials';

describe('application credential protection', () => {
  it('removes builtin credentials from the provider and its duplicated API snapshot', () => {
    const config = {
      providers: { builtin_models: { apiKey: 'builtin-fixture-key' } },
      api: { key: 'builtin-fixture-key' },
    };
    expect(transformAppConfigCredentials(config)).toEqual({
      providers: { builtin_models: { apiKey: '' } }, api: { key: '' },
    });
  });

  it('preserves user-owned credentials without mutating the input', () => {
    const config = {
      providers: { builtin_models: { apiKey: 'builtin-fixture-key', models: [] }, custom: { apiKey: 'user-key' } },
      api: { key: 'user-api-key' },
    };
    const protectedConfig = transformAppConfigCredentials(config);
    expect(protectedConfig).toEqual({
      ...config, providers: { ...config.providers, builtin_models: { apiKey: '', models: [] } },
    });
    expect(transformAppConfigCredentials(protectedConfig)).toEqual(protectedConfig);
    expect(config.providers.builtin_models.apiKey).toBe('builtin-fixture-key');
  });

  it('clears a builtin selection snapshot even when the provider is unavailable', () => {
    expect(transformAppConfigCredentials({
      model: { defaultModelProvider: 'builtin_models' },
      api: { key: 'builtin-fixture-key' },
    })).toEqual({
      model: { defaultModelProvider: 'builtin_models' },
      api: { key: '' },
    });
  });
});
