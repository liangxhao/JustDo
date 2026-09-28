import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { mainProcessFetch } from '../core/network/mainProcessFetch';
import type { SqliteStore } from '../data/sqliteStore';
import {
  clearActiveBuiltinModelCredential,
  setActiveBuiltinModelCredential,
} from './builtinModelCredential';
import { BuiltinModelAccess, syncBuiltinModelProvider } from './builtinModelProvider';

vi.mock('../core/network/mainProcessFetch', () => ({
  mainProcessFetch: vi.fn((url: string, init: RequestInit) => globalThis.fetch(url, init)),
}));

const createCredential = () => {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const accessToken = [
    encode({ alg: 'RS256', kid: 'login-key-1' }),
    encode({
      iss: 'https://login.example.test',
      aud: 'justdo-litellm',
      sub: 'user-123',
      iat: nowSeconds,
      exp: nowSeconds + 300,
      jti: 'token-1',
    }),
    'test-signature',
  ].join('.');
  return { accessToken, userAccount: 'user-123', expiresAt: nowSeconds + 300 };
};

describe('syncBuiltinModelProvider', () => {
  test.each([
    { selected: 'retired', listed: ['disabled', 'first', 'second'], expected: 'first' },
    { selected: 'second', listed: ['disabled', 'first', 'second'], expected: 'second' },
    { selected: 'disabled', listed: ['disabled', 'first'], expected: 'first' },
    { selected: 'retired', listed: ['disabled'], expected: 'retired' },
    { selected: 'retired', listed: [], expected: 'retired' },
  ])(
    'restores $selected to $expected from the refreshed enabled catalog',
    async ({ selected, listed, expected }) => {
      const config = {
        model: { defaultModel: selected, defaultModelProvider: 'builtin_models' },
        providers: {
          builtin_models: {
            enabled: true,
            apiKey: '',
            baseUrl: 'https://example.test/v1',
            models: [
              { id: 'retired', name: 'Retired' },
              { id: 'disabled', name: 'Disabled', enabled: false },
            ],
          },
        },
      };
      const set = vi.fn();
      const store = { get: vi.fn(() => config), set } as unknown as SqliteStore;
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({ data: listed.map(id => ({ id })) }),
          })
          .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) }),
      );

      await syncBuiltinModelProvider(store, { access: BuiltinModelAccess.Enabled });

      expect(set.mock.calls[0][1].model).toEqual({
        defaultModel: expected,
        defaultModelProvider: 'builtin_models',
      });
    },
  );

  test('does not replace a selected model when catalog loading fails', async () => {
    const config = {
      model: { defaultModel: 'selected', defaultModelProvider: 'builtin_models' },
      providers: {
        custom: {
          enabled: true,
          apiKey: 'test',
          baseUrl: 'https://example.test/v1',
          models: [{ id: 'other', name: 'Other' }],
        },
      },
    };
    const set = vi.fn();
    const store = { get: vi.fn(() => config), set } as unknown as SqliteStore;
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    await syncBuiltinModelProvider(store, { access: BuiltinModelAccess.Enabled });

    expect(set.mock.calls[0][1].model).toEqual(config.model);
  });

  test('uses the first ready configured provider when the built-in catalog becomes empty', async () => {
    const config = {
      model: { defaultModel: 'retired', defaultModelProvider: 'builtin_models' },
      providers: {
        builtin_models: {
          enabled: true,
          apiKey: '',
          baseUrl: 'https://example.test/v1',
          models: [{ id: 'retired', name: 'Retired' }],
          embeddingModels: [{ id: 'retired-embedding', name: 'Retired embedding' }],
        },
        custom: {
          enabled: true,
          apiKey: 'test',
          baseUrl: 'https://custom.test/v1',
          models: [{ id: 'first', name: 'First' }],
        },
      },
    };
    const set = vi.fn();
    const store = { get: vi.fn(() => config), set } as unknown as SqliteStore;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) }),
    );

    await syncBuiltinModelProvider(store, { access: BuiltinModelAccess.Enabled });

    expect(set.mock.calls[0][1].model).toEqual({
      defaultModel: 'first',
      defaultModelProvider: 'custom',
    });
    expect(set.mock.calls[0][1].providers.builtin_models).toMatchObject({
      models: [],
      embeddingModels: [],
    });
  });

  beforeEach(() => {
    vi.mocked(mainProcessFetch).mockClear();
    setActiveBuiltinModelCredential(createCredential());
  });

  afterEach(() => {
    clearActiveBuiltinModelCredential();
    vi.unstubAllGlobals();
  });

  test('retains cached models and enabled flags when refreshing the built-in provider fails', async () => {
    const appConfig = {
      providers: {
        builtin_models: {
          enabled: true,
          apiKey: 'cached-key',
          baseUrl: 'https://cached.example.com/v1',
          models: [{ id: 'cached-model', name: 'Cached model', enabled: false }],
          embeddingModels: [{ id: 'cached-embedding', name: 'Cached embedding' }],
        },
      },
    };
    const set = vi.fn();
    const store = {
      get: vi.fn(() => appConfig),
      set,
    } as unknown as SqliteStore;
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network unavailable')));

    await syncBuiltinModelProvider(store, { access: BuiltinModelAccess.Enabled });

    expect(mainProcessFetch).toHaveBeenCalledWith(
      expect.stringContaining('/models'),
      expect.objectContaining({ redirect: 'error' }),
    );

    expect(set).toHaveBeenCalledWith(
      'app_config',
      expect.objectContaining({
        providers: expect.objectContaining({
          builtin_models: expect.objectContaining({
            apiKey: '',
            models: appConfig.providers.builtin_models.models,
            embeddingModels: appConfig.providers.builtin_models.embeddingModels,
          }),
        }),
      }),
    );
  });

  test('keeps embedding models out of the chat list and sorts them by id', async () => {
    const set = vi.fn();
    const store = {
      get: vi.fn(() => ({})),
      set,
    } as unknown as SqliteStore;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: 'chat-model' }, { id: 'embedding-z' }, { id: 'embedding-a' }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { model_name: 'chat-model', model_info: { mode: 'chat' } },
            { model_name: 'embedding-z', model_info: { mode: 'embedding' } },
            { model_name: 'embedding-a', model_info: { mode: 'embedding' } },
          ],
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    await syncBuiltinModelProvider(store, { access: BuiltinModelAccess.Enabled });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, requestInit] of fetchMock.mock.calls) {
      expect(requestInit?.headers).toEqual({
        Authorization: 'Bearer access-jwt-auth',
        'X-ACCESS-JWT': expect.stringMatching(/^[^.]+\.[^.]+\.[^.]+$/),
        'X-User-Account': 'user-123',
      });
    }
    const savedConfig = set.mock.calls[0]?.[1];
    expect(savedConfig.providers.builtin_models.apiKey).toBe('');
    expect(JSON.stringify(savedConfig)).not.toContain('test-signature');
    expect(savedConfig.providers.builtin_models.models).toEqual([
      expect.objectContaining({ id: 'chat-model' }),
    ]);
    expect(savedConfig.providers.builtin_models.embeddingModels).toEqual([
      expect.objectContaining({ id: 'embedding-a' }),
      expect.objectContaining({ id: 'embedding-z' }),
    ]);
  });

  test('preserves an unchecked built-in model when refreshing the catalog', async () => {
    const set = vi.fn();
    const store = {
      get: vi.fn(() => ({
        providers: {
          builtin_models: {
            enabled: true,
            apiKey: 'cached-key',
            baseUrl: 'https://cached.example.com/v1',
            models: [{ id: 'chat-model', name: 'Old name', enabled: false }],
          },
        },
      })),
      set,
    } as unknown as SqliteStore;
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: [{ id: 'chat-model' }] }),
        })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) }),
    );

    await syncBuiltinModelProvider(store, { access: BuiltinModelAccess.Enabled });

    expect(set.mock.calls[0]?.[1].providers.builtin_models.models).toEqual([
      expect.objectContaining({ id: 'chat-model', enabled: false }),
    ]);
  });

  test('removes the built-in provider without fetching when access is disabled', async () => {
    const appConfig = {
      model: {
        defaultModel: 'cached-model',
        defaultModelProvider: 'builtin_models',
      },
      providers: {
        builtin_models: {
          enabled: true,
          apiKey: 'cached-key',
          baseUrl: 'https://cached.example.com/v1',
          models: [{ id: 'cached-model', name: 'Cached model' }],
          embeddingModels: [{ id: 'cached-embedding', name: 'Cached embedding' }],
        },
        custom_0: {
          enabled: true,
          apiKey: 'custom-key',
          baseUrl: 'https://custom.example.com/v1',
          models: [{ id: 'custom-model', name: 'Custom model' }],
        },
      },
    };
    const set = vi.fn();
    const store = {
      get: vi.fn(() => appConfig),
      set,
    } as unknown as SqliteStore;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await syncBuiltinModelProvider(store, { access: BuiltinModelAccess.Disabled });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(set).toHaveBeenCalledWith('app_config', {
      ...appConfig,
      providers: {
        custom_0: appConfig.providers.custom_0,
      },
    });
  });

  test('removes the built-in provider without fetching when the user credential is missing', async () => {
    clearActiveBuiltinModelCredential();
    const appConfig = {
      api: { key: 'cached-key', baseUrl: 'https://cached.example.com/v1' },
      model: {
        defaultModel: 'cached-model',
        defaultModelProvider: 'builtin_models',
      },
      providers: {
        builtin_models: {
          enabled: true,
          apiKey: 'cached-key',
          baseUrl: 'https://cached.example.com/v1',
          models: [{ id: 'cached-model', name: 'Cached model' }],
        },
      },
    };
    const set = vi.fn();
    const store = {
      get: vi.fn(() => appConfig),
      set,
    } as unknown as SqliteStore;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await syncBuiltinModelProvider(store, { access: BuiltinModelAccess.Enabled });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(set).toHaveBeenCalledWith('app_config', {
      ...appConfig,
      api: { ...appConfig.api, key: '' },
      providers: {},
    });
  });

  test('fails closed when the access option is missing at runtime', async () => {
    const set = vi.fn();
    const store = {
      get: vi.fn(() => ({
        providers: {
          builtin_models: {
            enabled: true,
            apiKey: 'cached-key',
            baseUrl: 'https://cached.example.com/v1',
            models: [{ id: 'cached-model', name: 'Cached model' }],
          },
        },
      })),
      set,
    } as unknown as SqliteStore;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await syncBuiltinModelProvider(store, undefined as unknown as { access: BuiltinModelAccess });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(set.mock.calls[0]?.[1].providers).toEqual({});
  });

  test('does not restore the provider when an older refresh finishes after disable', async () => {
    let resolveModelsResponse:
      ((value: { ok: true; json: () => Promise<unknown> }) => void) | null = null;
    const modelsResponse = new Promise<{ ok: true; json: () => Promise<unknown> }>(resolve => {
      resolveModelsResponse = resolve;
    });
    const set = vi.fn();
    const store = {
      get: vi.fn(() => ({
        providers: {
          builtin_models: {
            enabled: true,
            apiKey: 'cached-key',
            baseUrl: 'https://cached.example.com/v1',
            models: [{ id: 'cached-model', name: 'Cached model' }],
          },
        },
      })),
      set,
    } as unknown as SqliteStore;
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(modelsResponse)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) });
    vi.stubGlobal('fetch', fetchMock);

    const refreshPromise = syncBuiltinModelProvider(store, {
      access: BuiltinModelAccess.Enabled,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const firstRequestSignal = fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal;

    await syncBuiltinModelProvider(store, { access: BuiltinModelAccess.Disabled });
    expect(firstRequestSignal.aborted).toBe(true);

    resolveModelsResponse?.({
      ok: true,
      json: async () => ({ data: [{ id: 'late-model' }] }),
    });
    await refreshPromise;

    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0]?.[1].providers).toEqual({});
  });

  test('preserves model selection and provider edits made while the catalog is loading', async () => {
    let resolveModels!: (value: unknown) => void;
    const response = new Promise(resolve => {
      resolveModels = resolve;
    });
    let config = {
      model: { defaultModel: 'old', defaultModelProvider: 'builtin_models' },
      providers: {
        builtin_models: {
          enabled: true,
          apiKey: '',
          baseUrl: 'https://example.test/v1',
          models: [{ id: 'chat', name: 'Chat', enabled: true }],
        },
      },
    };
    const store = {
      get: vi.fn(() => config),
      set: vi.fn((_key, value) => {
        config = value;
      }),
    } as unknown as SqliteStore;
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) });
    vi.stubGlobal('fetch', fetchMock);

    const refreshing = syncBuiltinModelProvider(store, { access: BuiltinModelAccess.Enabled });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const selectedModel = { defaultModel: 'selected', defaultModelProvider: 'custom' };
    const customProvider = {
      enabled: true,
      apiKey: 'test',
      baseUrl: 'https://custom.test/v1',
      models: [{ id: 'selected', name: 'Selected', enabled: true }],
    };
    config = {
      model: selectedModel,
      providers: {
        ...config.providers,
        ...{ custom: customProvider },
        builtin_models: {
          ...config.providers.builtin_models,
          models: [{ id: 'chat', name: 'Chat', enabled: false }],
        },
      },
    };
    resolveModels({ ok: true, json: async () => ({ data: [{ id: 'chat' }] }) });
    await refreshing;

    expect(config.model).toEqual(selectedModel);
    expect(config.providers).toMatchObject({ custom: customProvider });
    expect(config.providers.builtin_models.models).toEqual([
      expect.objectContaining({ id: 'chat', enabled: false }),
    ]);
  });

  test('retains the latest cached catalog when a pending refresh fails', async () => {
    let rejectModels!: (error: Error) => void;
    const response = new Promise((_resolve, reject) => {
      rejectModels = reject;
    });
    let config = {
      model: { defaultModel: 'chat', defaultModelProvider: 'builtin_models' },
      providers: {
        builtin_models: {
          enabled: true,
          apiKey: 'legacy-key',
          baseUrl: 'https://example.test/v1',
          models: [{ id: 'chat', name: 'Chat', enabled: true }],
          embeddingModels: [{ id: 'embedding', name: 'Embedding' }],
        },
      },
    };
    const store = {
      get: vi.fn(() => config),
      set: vi.fn((_key, value) => {
        config = value;
      }),
    } as unknown as SqliteStore;
    const fetchMock = vi.fn().mockReturnValue(response);
    vi.stubGlobal('fetch', fetchMock);

    const refreshing = syncBuiltinModelProvider(store, { access: BuiltinModelAccess.Enabled });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    config.providers.builtin_models.models[0].enabled = false;
    config.providers.builtin_models.embeddingModels = [{ id: 'latest', name: 'Latest' }];
    rejectModels(new Error('offline'));
    await refreshing;

    expect(config.model).toEqual({ defaultModel: 'chat', defaultModelProvider: 'builtin_models' });
    expect(config.providers.builtin_models).toMatchObject({
      apiKey: '',
      models: [{ id: 'chat', name: 'Chat', enabled: false }],
      embeddingModels: [{ id: 'latest', name: 'Latest' }],
    });
  });
});
