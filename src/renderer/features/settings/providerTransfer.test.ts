import { describe, expect, test } from 'vitest';

import { EXPORT_FORMAT_TYPE } from '@/app/constants/app';
import {
  createProvidersExportPayload,
  mergeImportedProviders,
  parseProvidersImportPayload,
  PROVIDERS_EXPORT_VERSION,
} from '@/features/settings/providerTransfer';

const encryptedApiKey = {
  encrypted: 'encrypted',
  iv: 'iv',
  salt: 'salt',
};

const providerConfig = {
  enabled: true,
  apiKey: 'secret',
  baseUrl: 'https://api.example.com',
  apiFormat: 'openai' as const,
  models: [{ id: 'model', name: 'Model' }],
};

describe('provider transfer format', () => {
  test('exports version 3 providers as a list without internal keys', () => {
    const payload = createProvidersExportPayload([
      {
        key: 'custom_7',
        config: { ...providerConfig, displayName: 'DeepSeek' },
        apiKey: encryptedApiKey,
      },
    ]);

    expect(payload).toEqual({
      type: EXPORT_FORMAT_TYPE,
      version: PROVIDERS_EXPORT_VERSION,
      providers: [
        {
          ...providerConfig,
          apiKey: encryptedApiKey,
          displayName: 'DeepSeek',
        },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain('custom_7');
  });

  test('parses legacy version 2 and uses its display name instead of its internal key', () => {
    const providers = parseProvidersImportPayload({
      type: EXPORT_FORMAT_TYPE,
      version: 2,
      providers: {
        custom_0: { ...providerConfig, apiKey: encryptedApiKey, displayName: 'DeepSeek' },
      },
    });

    expect(providers).toEqual([
      { ...providerConfig, apiKey: encryptedApiKey, displayName: 'DeepSeek' },
    ]);
  });

  test('supplies the legacy default display name when version 2 omitted it', () => {
    const providers = parseProvidersImportPayload({
      type: EXPORT_FORMAT_TYPE,
      version: 2,
      providers: {
        custom_4: { ...providerConfig, apiKey: encryptedApiKey },
      },
    });

    expect(providers[0].displayName).toBe('Custom4');
  });

  test('rejects duplicate display names ignoring case', () => {
    expect(() =>
      parseProvidersImportPayload({
        type: EXPORT_FORMAT_TYPE,
        version: PROVIDERS_EXPORT_VERSION,
        providers: [
          { ...providerConfig, apiKey: encryptedApiKey, displayName: 'DeepSeek' },
          { ...providerConfig, apiKey: encryptedApiKey, displayName: 'deepseek' },
        ],
      }),
    ).toThrow('Duplicate provider display name');
  });
});

describe('mergeImportedProviders', () => {
  test('updates an existing custom provider with the same display name', () => {
    const existing = {
      builtin_models: { ...providerConfig, readonly: true },
      custom_3: { ...providerConfig, displayName: 'DeepSeek', baseUrl: 'https://old.example.com' },
    };

    const merged = mergeImportedProviders(existing, [
      { ...providerConfig, displayName: 'deepseek', baseUrl: 'https://new.example.com' },
    ]);

    expect(merged.custom_3.baseUrl).toBe('https://new.example.com');
    expect(merged.custom_0).toBeUndefined();
  });

  test('allocates the first unused internal key for a new display name', () => {
    const existing = {
      custom_0: { ...providerConfig, displayName: 'Existing' },
      custom_2: { ...providerConfig, displayName: 'Another' },
    };

    const merged = mergeImportedProviders(existing, [
      { ...providerConfig, displayName: 'DeepSeek' },
    ]);

    expect(merged.custom_1.displayName).toBe('DeepSeek');
    expect(merged.custom_0.displayName).toBe('Existing');
  });
});
