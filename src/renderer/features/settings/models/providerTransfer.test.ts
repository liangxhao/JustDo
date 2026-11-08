import { describe, expect, test } from 'vitest';

import { EXPORT_FORMAT_TYPE } from '@/app/constants';
import { getNonLanguageModelCategoryValidationError } from '@/features/settings/models/nonLanguageModelConfig';
import {
  createProvidersExportPayload,
  mergeImportedOnlineModelProviders,
  mergeImportedProviders,
  parseModelProvidersImportPayload,
  PROVIDERS_EXPORT_VERSION,
} from '@/features/settings/models/providerTransfer';
import {
  decryptWithPassword,
  encryptWithPassword,
} from '@/features/settings/models/providerTransferCrypto';

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

test('round-trips provider-level speech protocols and per-model parameters using a version that older readers reject', () => {
  const config = {
    displayName: 'Private speech',
    baseUrl: 'http://speech.internal/v1',
    apiKey: 'private-placeholder',
    protocolId: 'openai-speech-http' as const,
    models: [
      { id: 'first', name: 'First', voicePolicy: 'preset' as const },
      {
        id: 'second',
        name: 'Second',
        voicePolicy: 'preset' as const,
        voices: [{ id: 'v', name: 'Voice' }],
      },
    ],
  };
  const payload = createProvidersExportPayload([], {
    'speech-synthesis': {
      providers: [{ key: 'speech', config, apiKey: encryptedApiKey }],
    },
  });
  expect(payload.version).toBe(5);
  const parsed =
    parseModelProvidersImportPayload(payload).onlineModelProviders['speech-synthesis']!
      .providers[0];
  expect(parsed).toEqual({ ...config, apiKey: encryptedApiKey });
  expect(JSON.stringify(payload)).not.toContain('private-placeholder');
  const invalid = structuredClone(payload);
  (
    invalid.onlineModelProviders['speech-synthesis']!.providers[0] as { protocolId: string }
  ).protocolId = 'unknown';
  expect(() => parseModelProvidersImportPayload(invalid)).toThrow();
});

test('continues importing version 4 catalogs without guessing one provider protocol for old ASR bindings', () => {
  const provider = {
    displayName: 'Legacy ASR',
    baseUrl: 'http://speech.internal/v1',
    apiKey: encryptedApiKey,
    models: [{ id: 'asr', name: 'ASR' }],
  };
  const parsed = parseModelProvidersImportPayload({
    type: EXPORT_FORMAT_TYPE,
    version: 4,
    providers: [],
    onlineModelProviders: { 'speech-recognition': { providers: [provider] } },
  });
  expect(parsed.onlineModelProviders['speech-recognition']!.providers[0]).toEqual(provider);
  expect(parsed.onlineModelProviders['speech-recognition']!.providers[0]).not.toHaveProperty(
    'protocolId',
  );
});

test.each(['category', 'provider', 'model', 'binding', 'voice'] as const)(
  'rejects retired fields on %s before import or export serialization',
  level => {
    const voice = { id: 'voice', name: 'Voice' };
    const binding = { id: 'speech', protocolId: 'openai-speech-http' as const };
    const model = { id: 'reader', name: 'Reader', voices: [voice], bindings: [binding] };
    const provider = {
      displayName: 'Speech',
      baseUrl: 'http://speech.internal/v1',
      apiKey: encryptedApiKey,
      models: [model],
    };
    const category = { providers: [provider] };
    Object.assign({ category, provider, model, binding, voice }[level], {
      compatibilityProfile: undefined,
    });
    for (const version of [4, PROVIDERS_EXPORT_VERSION]) {
      expect(() =>
        parseModelProvidersImportPayload({
          type: EXPORT_FORMAT_TYPE,
          version,
          providers: [],
          onlineModelProviders: { 'speech-synthesis': category },
        }),
      ).toThrow();
    }
    const exportCategory = {
      ...category,
      providers: [{ key: 'speech', config: { ...provider, apiKey: '' }, apiKey: encryptedApiKey }],
    };
    expect(() =>
      createProvidersExportPayload([], { 'speech-synthesis': exportCategory }),
    ).toThrow();
  },
);

test.each(['chat-audio-transcription', 'chat-audio-speech'])(
  'rejects the retired protocol %s without treating it as legacy',
  protocolId => {
    const kind = protocolId.endsWith('transcription') ? 'speech-recognition' : 'speech-synthesis';
    expect(() =>
      parseModelProvidersImportPayload({
        type: EXPORT_FORMAT_TYPE,
        version: PROVIDERS_EXPORT_VERSION,
        providers: [],
        onlineModelProviders: {
          [kind]: {
            providers: [
              {
                displayName: 'Speech',
                baseUrl: 'http://speech.internal/v1',
                apiKey: encryptedApiKey,
                protocolId,
                models: [{ id: 'custom/model', name: 'Model' }],
              },
            ],
          },
        },
      }),
    ).toThrow();
  },
);

describe('provider transfer format', () => {
  test('preserves speech bindings and realtime parameters, and rejects unknown protocol metadata on import', () => {
    const bindings = [
      { id: 'recorded', protocolId: 'openai-transcription-http' },
      { id: 'live', protocolId: 'openai-transcription-realtime' },
    ];
    const payload = {
      type: EXPORT_FORMAT_TYPE,
      version: PROVIDERS_EXPORT_VERSION,
      providers: [],
      onlineModelProviders: {
        'speech-recognition': {
          providers: [
            {
              displayName: 'Speech LAN',
              baseUrl: 'http://speech.lan/v1',
              apiKey: encryptedApiKey,
              models: [{ id: 'group/model', name: 'Model', bindings }],
            },
          ],
        },
        'realtime-voice': {
          providers: [
            {
              displayName: 'Voice LAN',
              baseUrl: 'ws://voice.lan/v1',
              apiKey: encryptedApiKey,
              models: [
                {
                  id: 'conversation',
                  name: 'Conversation',
                  bindings: [
                    {
                      id: 'talk',
                      protocolId: 'openai-voice-realtime',
                      inputTranscriptionModel: 'internal/asr',
                    },
                  ],
                  voices: [{ id: 'speaker', name: 'Speaker' }],
                },
              ],
            },
          ],
        },
      },
    };
    const parsed = parseModelProvidersImportPayload(payload);
    expect(
      parsed.onlineModelProviders['speech-recognition']?.providers[0].models[0].bindings,
    ).toEqual(bindings);
    expect(
      parsed.onlineModelProviders['realtime-voice']?.providers[0].models[0].bindings?.[0]
        .inputTranscriptionModel,
    ).toBe('internal/asr');
    payload.onlineModelProviders[
      'speech-recognition'
    ].providers[0].models[0].bindings[0].protocolId = 'unknown';
    expect(() => parseModelProvidersImportPayload(payload)).toThrow();
  });
  test('exports current providers as a list without internal keys', () => {
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
          { id: 'custom-speech-model', name: 'First' },
          { id: 'custom-speech-model', name: 'Duplicate' },
        ]),
      ),
    ).toThrow('Duplicate online model id');
    expect(() =>
      parseModelProvidersImportPayload(
        payload([
          {
            id: 'custom-speech-model',
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
  test.each(['decision', 'image', 'video'] as const)(
    'preserves the complete %s default selection when an import does not specify one',
    kind => {
      const provider = {
        displayName: 'Model API',
        baseUrl: 'http://models.test/v1',
        apiKey: 'test-key',
        defaultModel: 'model/selected',
        models: [
          { id: 'model/selected', name: 'Selected' },
          { id: 'model/other', name: 'Other' },
        ],
        ...(kind === 'video' ? { nativeVideoProvider: 'video-openai' as const } : {}),
      };
      const current = { [kind]: { defaultProviderId: 'provider', providers: { provider } } };
      const merged = mergeImportedOnlineModelProviders(current, {
        [kind]: { providers: [{ ...provider, defaultModel: 'model/other' }] },
      });

      expect(merged[kind]?.defaultProviderId).toBe('provider');
      expect(merged[kind]?.providers.provider.defaultModel).toBe('model/selected');
      expect(provider.defaultModel).toBe('model/selected');

      const removed = mergeImportedOnlineModelProviders(current, {
        [kind]: {
          providers: [
            { ...provider, defaultModel: 'model/other', models: provider.models.slice(1) },
          ],
        },
      });
      expect(removed[kind]?.defaultProviderId).toBeUndefined();
      expect(removed[kind]?.providers.provider.models).toEqual(provider.models.slice(1));

      const explicitlySelected = mergeImportedOnlineModelProviders(current, {
        [kind]: {
          defaultProvider: 'Model API',
          providers: [{ ...provider, defaultModel: 'model/other' }],
        },
      });
      expect(explicitlySelected[kind]?.defaultProviderId).toBe('provider');
      expect(explicitlySelected[kind]?.providers.provider.defaultModel).toBe('model/other');
    },
  );

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

test.each([true, false])('round-trips a decision catalog with default selected=%s', selected => {
  const payload = createProvidersExportPayload([], {
    decision: {
      ...(selected ? { defaultProviderId: 'lan' } : {}),
      providers: [
        {
          key: 'lan',
          config: {
            displayName: 'LAN',
            baseUrl: 'http://inference.corp/v1',
            apiKey: 'plaintext-test-value',
            defaultModel: 'kev-latest',
            models: [{ id: 'kev-latest', name: 'Kev' }],
          },
          apiKey: encryptedApiKey,
        },
      ],
    },
  });
  const parsed = parseModelProvidersImportPayload(payload);
  expect(parsed.onlineModelProviders?.decision).toEqual(payload.onlineModelProviders?.decision);
  expect(parsed.onlineModelProviders?.decision?.providers[0].apiKey).toEqual(encryptedApiKey);
});

test.each(['kie', 'zai', 'novita'])(
  'rejects importing unsupported video provider %s',
  nativeVideoProvider => {
    expect(() =>
      parseModelProvidersImportPayload({
        type: EXPORT_FORMAT_TYPE,
        version: PROVIDERS_EXPORT_VERSION,
        providers: [],
        onlineModelProviders: {
          video: {
            defaultProvider: 'Video API',
            providers: [
              {
                displayName: 'Video API',
                nativeVideoProvider,
                baseUrl: 'http://video.lan/v1',
                apiKey: encryptedApiKey,
                defaultModel: 'internal-video',
                models: [{ id: 'internal-video', name: 'Video' }],
              },
            ],
          },
        },
      }),
    ).toThrow('Invalid native video provider');
  },
);

test('round-trips the intranet video adapter and custom model with encrypted credentials', () => {
  const payload = createProvidersExportPayload([], {
    video: {
      defaultProviderId: 'lan',
      providers: [
        {
          key: 'lan',
          config: {
            displayName: 'OpenAI-compatible',
            nativeVideoProvider: 'video-openai',
            baseUrl: 'http://video.lan:8091/v1',
            apiKey: 'plaintext-test-value',
            defaultModel: 'Wan-AI/internal-video',
            models: [{ id: 'Wan-AI/internal-video', name: 'Wan-AI/internal-video' }],
          },
          apiKey: encryptedApiKey,
        },
      ],
    },
  });
  expect(
    parseModelProvidersImportPayload(payload).onlineModelProviders.video?.providers[0],
  ).toMatchObject({
    nativeVideoProvider: 'video-openai',
    defaultModel: 'Wan-AI/internal-video',
    apiKey: encryptedApiKey,
  });
  expect(JSON.stringify(payload)).not.toContain('plaintext-test-value');
});

test.each([
  { nativeVideoProvider: 'video-openai' as const, defaultModel: '', models: [] },
  {
    nativeVideoProvider: 'video-openai' as const,
    defaultModel: undefined,
    models: [{ id: 'video-discovered', name: 'Discovered video' }],
  },
])(
  'round-trips an unselected $nativeVideoProvider catalog with portable credential encryption',
  async draft => {
    const password = 'synthetic-export-password';
    const config = {
      displayName: 'Video models',
      baseUrl: '',
      apiKey: '',
      ...draft,
    };
    const payload = createProvidersExportPayload([], {
      video: {
        providers: [
          { key: 'draft-video', config, apiKey: await encryptWithPassword('', password) },
        ],
      },
    });

    const parsed = parseModelProvidersImportPayload(JSON.parse(JSON.stringify(payload)));
    const category = parsed.onlineModelProviders.video!;
    const decryptedProviders = await Promise.all(
      category.providers.map(async provider => ({
        ...provider,
        apiKey:
          typeof provider.apiKey === 'string'
            ? provider.apiKey
            : await decryptWithPassword(provider.apiKey, password),
      })),
    );
    const imported = mergeImportedOnlineModelProviders(
      {},
      {
        video: { ...category, providers: decryptedProviders },
      },
    ).video!;

    expect(Object.values(imported.providers)).toEqual([config]);
    expect(imported.defaultProviderId).toBeUndefined();
    expect(getNonLanguageModelCategoryValidationError('video', imported)).toBe('');
    expect(
      getNonLanguageModelCategoryValidationError('video', {
        ...imported,
        defaultProviderId: Object.keys(imported.providers)[0],
      }),
    ).toBeTruthy();

    const selectedPayload = structuredClone(payload);
    selectedPayload.onlineModelProviders.video!.defaultProvider = config.displayName;
    expect(() => parseModelProvidersImportPayload(selectedPayload)).toThrow(
      'Invalid online model default',
    );
  },
);
