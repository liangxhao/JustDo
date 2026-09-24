import { describe, expect, test } from 'vitest';

import { EXPORT_FORMAT_TYPE } from '@/app/constants';
import {
  createProvidersExportPayload,
  mergeImportedOnlineModelProviders,
  mergeImportedProviders,
  parseModelProvidersImportPayload,
  PROVIDERS_EXPORT_VERSION,
} from '@/features/settings/models/providerTransfer';

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
  test('exports version 4 providers as a list without internal keys', () => {
    const payload = createProvidersExportPayload([
      {
        key: 'custom_7',
        config: {
          ...providerConfig,
          displayName: 'AcmeProxy',
          headers: { 'X-Tenant': encryptedApiKey },
        },
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
          headers: { 'X-Tenant': encryptedApiKey },
          displayName: 'AcmeProxy',
        },
      ],
      onlineModelProviders: {},
    });
    expect(JSON.stringify(payload)).not.toContain('custom_7');
    expect(parseModelProvidersImportPayload(payload).providers[0]?.headers).toEqual({
      'X-Tenant': encryptedApiKey,
    });
  });

  test('rejects imported provider headers that exceed limits or contain invalid plaintext values', () => {
    const payload = (headers: Record<string, string>) => ({
      type: EXPORT_FORMAT_TYPE,
      version: PROVIDERS_EXPORT_VERSION,
      onlineModelProviders: {},
      providers: [
        {
          ...providerConfig,
          apiKey: encryptedApiKey,
          displayName: 'AcmeProxy',
          headers,
        },
      ],
    });

    expect(() =>
      parseModelProvidersImportPayload(
        payload(Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`X-${index}`, 'v']))),
      ),
    ).toThrow('Invalid provider headers');
    expect(() =>
      parseModelProvidersImportPayload(payload({ 'X-Tenant': 'line-one\r\nline-two' })),
    ).toThrow('Invalid provider headers');
    expect(() => parseModelProvidersImportPayload(payload({ 'X-Tenant': '' }))).toThrow(
      'Invalid provider headers',
    );
  });

  test('rejects duplicate display names ignoring case', () => {
    expect(() =>
      parseModelProvidersImportPayload({
        type: EXPORT_FORMAT_TYPE,
        version: PROVIDERS_EXPORT_VERSION,
        onlineModelProviders: {},
        providers: [
          { ...providerConfig, apiKey: encryptedApiKey, displayName: 'AcmeProxy' },
          { ...providerConfig, apiKey: encryptedApiKey, displayName: 'acmeproxy' },
        ],
      }),
    ).toThrow('Duplicate provider display name');
  });

  test('rejects an application-reserved provider name during import', () => {
    expect(() =>
      parseModelProvidersImportPayload({
        type: EXPORT_FORMAT_TYPE,
        version: PROVIDERS_EXPORT_VERSION,
        onlineModelProviders: {},
        providers: [{ ...providerConfig, apiKey: encryptedApiKey, displayName: 'JustDo' }],
      }),
    ).toThrow('Invalid provider display name');
  });

  test('accepts an explicitly configured OpenClaw provider name during import', () => {
    expect(
      parseModelProvidersImportPayload({
        type: EXPORT_FORMAT_TYPE,
        version: PROVIDERS_EXPORT_VERSION,
        onlineModelProviders: {},
        providers: [{ ...providerConfig, apiKey: encryptedApiKey, displayName: 'OpenCode' }],
      }),
    ).toMatchObject({ providers: [{ displayName: 'OpenCode' }] });
  });

  test('exports and parses every non-language model category', () => {
    const imageProvider = {
      displayName: 'Image Lab',
      baseUrl: 'https://images.example.com/v1',
      apiKey: 'secret',
      defaultModel: 'image-1',
      models: [{ id: 'image-1', name: 'Image One' }],
    };
    const payload = createProvidersExportPayload([], {
      image: {
        defaultProviderId: 'image-lab',
        providers: [
          {
            key: 'image-lab',
            config: imageProvider,
            apiKey: encryptedApiKey,
          },
        ],
      },
      'speech-recognition': {
        providers: [
          {
            key: 'speech-lab',
            config: {
              displayName: 'Speech Lab',
              baseUrl: 'https://speech.example.com/v1',
              apiKey: 'secret',
              models: [{ id: 'asr-1', name: 'ASR One' }],
            },
            apiKey: encryptedApiKey,
          },
        ],
      },
    });

    expect(payload.onlineModelProviders.image).toEqual({
      defaultProvider: 'Image Lab',
      providers: [{ ...imageProvider, apiKey: encryptedApiKey }],
    });
    expect(parseModelProvidersImportPayload(payload).onlineModelProviders).toEqual(
      payload.onlineModelProviders,
    );
  });

  test.each([2, 3])('rejects obsolete version %s files', version => {
    expect(() =>
      parseModelProvidersImportPayload({
        type: EXPORT_FORMAT_TYPE,
        version,
        providers: [],
      }),
    ).toThrow('Unsupported providers file version');
  });

  test('rejects a default provider that is absent from its category', () => {
    expect(() =>
      parseModelProvidersImportPayload({
        type: EXPORT_FORMAT_TYPE,
        version: PROVIDERS_EXPORT_VERSION,
        providers: [],
        onlineModelProviders: {
          image: {
            defaultProvider: 'Missing Lab',
            providers: [
              {
                displayName: 'Image Lab',
                baseUrl: 'https://images.example.com/v1',
                apiKey: encryptedApiKey,
                defaultModel: 'image-1',
                models: [{ id: 'image-1', name: 'Image One' }],
              },
            ],
          },
        },
      }),
    ).toThrow('Invalid online model default provider');
  });

  test('rejects duplicate model and voice ids', () => {
    const payload = (models: unknown[]) => ({
      type: EXPORT_FORMAT_TYPE,
      version: PROVIDERS_EXPORT_VERSION,
      providers: [],
      onlineModelProviders: {
        'speech-synthesis': {
          providers: [
            {
              displayName: 'Speech Lab',
              baseUrl: 'https://speech.example.com/v1',
              apiKey: encryptedApiKey,
              models,
            },
          ],
        },
      },
    });

    expect(() =>
      parseModelProvidersImportPayload(
        payload([
          { id: 'tts-1', name: 'First' },
          { id: 'tts-1', name: 'Duplicate' },
        ]),
      ),
    ).toThrow('Duplicate online model id');
    expect(() =>
      parseModelProvidersImportPayload(
        payload([
          {
            id: 'tts-1',
            name: 'TTS One',
            voices: [
              { id: 'voice-1', name: 'First' },
              { id: 'voice-1', name: 'Duplicate' },
            ],
          },
        ]),
      ),
    ).toThrow('Invalid online model voices');
  });

  test('rejects an image default model that is absent from the provider', () => {
    expect(() =>
      parseModelProvidersImportPayload({
        type: EXPORT_FORMAT_TYPE,
        version: PROVIDERS_EXPORT_VERSION,
        providers: [],
        onlineModelProviders: {
          image: {
            providers: [
              {
                displayName: 'Image Lab',
                baseUrl: 'https://images.example.com/v1',
                apiKey: encryptedApiKey,
                defaultModel: 'missing',
                models: [{ id: 'image-1', name: 'Image One' }],
              },
            ],
          },
        },
      }),
    ).toThrow('Invalid online model default');
  });
});

describe('mergeImportedProviders', () => {
  test('updates an existing custom provider with the same display name', () => {
    const existing = {
      builtin_models: { ...providerConfig, readonly: true },
      custom_3: { ...providerConfig, displayName: 'AcmeProxy', baseUrl: 'https://old.example.com' },
    };

    const merged = mergeImportedProviders(existing, [
      { ...providerConfig, displayName: 'acmeproxy', baseUrl: 'https://new.example.com' },
    ]);

    expect(merged.custom_3.baseUrl).toBe('https://new.example.com');
    expect(merged.acmeproxy).toBeUndefined();
  });

  test('uses the normalized display name as the key for a new provider', () => {
    const existing = {
      custom_0: { ...providerConfig, displayName: 'Existing' },
      custom_2: { ...providerConfig, displayName: 'Another' },
    };

    const merged = mergeImportedProviders(existing, [
      { ...providerConfig, displayName: 'AcmeProxy' },
    ]);

    expect(merged.acmeproxy.displayName).toBe('AcmeProxy');
    expect(merged.acmeproxy.identity).toEqual(expect.any(String));
    expect(merged.custom_0.displayName).toBe('Existing');
  });

  test('does not overwrite a provider whose key collides with a new display name', () => {
    const existing = {
      acme: { ...providerConfig, displayName: 'Renamed' },
    };

    const merged = mergeImportedProviders(existing, [{ ...providerConfig, displayName: 'Acme' }]);

    expect(merged.acme.displayName).toBe('Renamed');
    expect(merged['acme-2'].displayName).toBe('Acme');
  });
});

describe('mergeImportedOnlineModelProviders', () => {
  test('updates matching providers, adds new providers, and restores the imported default', () => {
    const existing = {
      image: {
        defaultProviderId: 'existing',
        providers: {
          existing: {
            displayName: 'Image Lab',
            baseUrl: 'https://old.example.com',
            apiKey: 'old',
            defaultModel: 'old-model',
            models: [{ id: 'old-model', name: 'Old' }],
          },
        },
      },
    };

    const merged = mergeImportedOnlineModelProviders(existing, {
      image: {
        defaultProvider: 'New Lab',
        providers: [
          {
            displayName: 'image lab',
            baseUrl: 'https://new.example.com',
            apiKey: 'updated',
            defaultModel: 'new-model',
            models: [{ id: 'new-model', name: 'New' }],
          },
          {
            displayName: 'New Lab',
            baseUrl: 'https://another.example.com',
            apiKey: 'new',
            defaultModel: 'another-model',
            models: [{ id: 'another-model', name: 'Another' }],
          },
        ],
      },
    });

    expect(merged.image?.providers.existing.baseUrl).toBe('https://new.example.com');
    expect(merged.image?.providers['new lab'].apiKey).toBe('new');
    expect(merged.image?.defaultProviderId).toBe('new lab');
  });
});
