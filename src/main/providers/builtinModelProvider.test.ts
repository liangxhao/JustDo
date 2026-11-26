import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { startLocalModelServer } from '../../../tests/fixtures/localModelServer';
import { mainProcessFetch } from '../core/network/mainProcessFetch';
import type { SqliteStore } from '../data/sqliteStore';
import { BuiltinModelAuthCoordinator } from './builtinModelAuthCoordinator';
import {
  clearActiveBuiltinModelCredential,
  getActiveBuiltinModelCredential,
  setActiveBuiltinModelCredential,
  setActiveBuiltinModelDevelopmentApiKey,
} from './builtinModelCredential';
import { BuiltinModelCredentialMonitor } from './builtinModelCredentialMonitor';
import { BuiltinModelLifecycle } from './builtinModelLifecycle';
import { BuiltinModelAccess, syncBuiltinModelProvider } from './builtinModelProvider';

const testProviderConfig = vi.hoisted(() => ({ enabled: true, baseUrl: 'http://127.0.0.1:1/v1' }));
vi.mock('../../config/builtinModels', () => ({ BUILTIN_MODEL_PROVIDER_CONFIG: testProviderConfig }));

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
  test.each(['', 'https://models.example.test/v1#', 'https://models.example.test/v1?tenant=example'])(
    'does not fetch or expose cached models for an unusable URL %j',
    async baseUrl => {
      testProviderConfig.baseUrl = baseUrl;
      const config = { providers: { builtin_models: {
        enabled: true, apiKey: '', baseUrl: 'https://models.example.test/v1',
        models: [{ id: 'cached-chat', name: 'Cached chat' }],
      } } };
      const set = vi.fn();
      const store = { get: () => config, set } as unknown as SqliteStore;
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      await syncBuiltinModelProvider(store, { access: BuiltinModelAccess.Enabled });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(set.mock.calls[0][1].providers).not.toHaveProperty('builtin_models');
    },
  );

  test('discovers models from a real loopback fake provider without persisting credentials', async () => {
    const local = await startLocalModelServer();
    try {
      testProviderConfig.baseUrl = local.baseUrl;
      const set = vi.fn();
      const store = { get: () => ({}), set } as unknown as SqliteStore;
      await syncBuiltinModelProvider(store, { access: BuiltinModelAccess.Enabled });
      expect(local.requests.map(request => request.path)).toEqual(['/v1/models', '/v1/model/info']);
      const saved = set.mock.calls[0][1];
      expect(saved.providers.builtin_models.models).toEqual([expect.objectContaining({ id: 'local-chat' })]);
      expect(saved.providers.builtin_models.embeddingModels).toEqual([expect.objectContaining({ id: 'local-embedding' })]);
      expect(local.requests[0].headers['x-user-account']).toBe('user-123');
      expect(local.requests[0].headers['x-access-jwt']).toContain('test-signature');
      for (const request of local.requests) {
        expect(request.headers.authorization).toBe(`Bearer ${request.headers['x-access-jwt']}`);
      }
      expect(JSON.stringify(saved)).not.toContain('test-signature');
    } finally {
      await local.close();
    }
  });

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

  test.each([
    { error: 'not a directory' },
    { data: [{ id: 'unrelated' }, { name: 'missing id' }] },
  ])('retains the last catalog when required discovery returns an invalid list', async payload => {
    const model = { defaultModel: 'selected', defaultModelProvider: 'builtin_models' };
    const builtin = {
      apiKey: '',
      enabled: true,
      baseUrl: testProviderConfig.baseUrl,
      models: [{ id: 'selected', name: 'Selected', enabled: true }],
      embeddingModels: [{ id: 'embedding', name: 'Embedding' }],
    };
    const set = vi.fn();
    const store = { get: () => ({ model, providers: { builtin_models: builtin } }), set } as unknown as SqliteStore;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => payload }));

    const retryNeeded = await syncBuiltinModelProvider(store, { access: BuiltinModelAccess.Enabled });

    expect(set.mock.calls[0][1]).toMatchObject({ model, providers: { builtin_models: builtin } });
    expect(retryNeeded).toBe(false);
    const [line] = vi.mocked(console.warn).mock.calls[0];
    expect(JSON.parse(String(line).slice('[BuiltinModelAuth] '.length))).toMatchObject({
      event: 'discovery.failed', reason: 'response-invalid-shape',
    });
  });

  test('repairs an empty catalog after a required startup discovery failure with the same credential', async () => {
    vi.useFakeTimers();
    const credential = setActiveBuiltinModelDevelopmentApiKey('fixture-key')!;
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('offline at startup'))
      .mockRejectedValueOnce(new Error('still offline'))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: 'recovered-model' }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) });
    vi.stubGlobal('fetch', fetchMock);
    let config = {};
    const store = { get: () => config, set: (_key: string, next: object) => { config = next; } } as unknown as SqliteStore;
    const notifyCatalogChanged = vi.fn();
    const lifecycle = new BuiltinModelLifecycle({
      getStore: () => store,
      syncOpenClawConfig: vi.fn(async () => ({ success: true })),
      notifyCatalogChanged,
      notifyRuntimeModelsChanged: vi.fn(),
      scheduleCatalogRetry: () => monitor.scheduleCatalogRetry(),
    });
    const coordinator = new BuiltinModelAuthCoordinator({
      exchange: async () => credential,
      getActiveBinding: () => ({ credential, authSessionId: 'session' }),
      needsCatalogRetry: () => lifecycle.needsCatalogRetry(),
      login: () => lifecycle.refreshAfterLogin(),
      rotate: () => lifecycle.refreshAfterCredentialRotation(),
      logout: () => lifecycle.refreshAfterLogout(),
    });
    const monitor = new BuiltinModelCredentialMonitor({
      userInfoPath: 'fixture',
      refresh: () => coordinator.refreshInBackground(),
      needsCatalogRetry: () => lifecycle.needsCatalogRetry(),
      watchFile: vi.fn(),
      unwatchFile: vi.fn(),
    });
    try {
      await lifecycle.loadStartupCatalog(BuiltinModelAccess.Enabled);
      expect(config).toMatchObject({ providers: { builtin_models: { models: [] } } });
      coordinator.initialize(credential);
      monitor.start(credential);

      await vi.advanceTimersByTimeAsync(90_000);

      expect(config).toMatchObject({
        providers: { builtin_models: { models: [{ id: 'recovered-model' }] } },
      });
      expect(fetchMock.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
        '/v1/models', '/v1/models', '/v1/models', '/v1/model/info',
      ]);
      expect(notifyCatalogChanged).toHaveBeenCalledTimes(2);
    } finally {
      monitor.stop();
      vi.useRealTimers();
    }
  });

  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    testProviderConfig.baseUrl = 'http://127.0.0.1:1/v1';
    vi.mocked(mainProcessFetch).mockClear();
    setActiveBuiltinModelCredential(createCredential());
  });

  afterEach(() => {
    clearActiveBuiltinModelCredential();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test('records required discovery HTTP failure on one line without reading its response body', async () => {
    const json = vi.fn();
    const text = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json, text }));
    const config = { providers: { builtin_models: { models: [{ id: 'cached', enabled: false }] } } };
    const set = vi.fn();
    const store = { get: () => config, set } as unknown as SqliteStore;

    await syncBuiltinModelProvider(store, { access: BuiltinModelAccess.Enabled });

    expect(json).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    expect(set.mock.calls[0][1].providers.builtin_models.models).toEqual(config.providers.builtin_models.models);
    const [line] = vi.mocked(console.warn).mock.calls[0];
    expect(vi.mocked(console.warn).mock.calls[0]).toHaveLength(1);
    expect(line).not.toMatch(/[\r\n]|user-123|test-signature|https?:\/\//);
    expect(JSON.parse(String(line).slice('[BuiltinModelAuth] '.length))).toEqual(expect.objectContaining({
      event: 'discovery.failed', discoveryStage: 'models', httpStatus: 401, reason: 'http-rejected',
    }));
  });

  test('logs optional model-info rejection while accepting the required model list', async () => {
    const json = vi.fn();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: 'chat-model' }] }) })
      .mockResolvedValueOnce({ ok: false, status: 404, json }));
    const set = vi.fn();
    const store = { get: () => ({}), set } as unknown as SqliteStore;

    await syncBuiltinModelProvider(store, { access: BuiltinModelAccess.Enabled });

    expect(json).not.toHaveBeenCalled();
    expect(set.mock.calls[0][1].providers.builtin_models.models).toEqual([expect.objectContaining({ id: 'chat-model' })]);
    const records = [...vi.mocked(console.info).mock.calls, ...vi.mocked(console.warn).mock.calls].map(args => {
      expect(args).toHaveLength(1);
      expect(args[0]).not.toMatch(/[\r\n]|user-123|test-signature|chat-model/);
      return JSON.parse(String(args[0]).slice('[BuiltinModelAuth] '.length));
    });
    expect(records).toContainEqual(expect.objectContaining({
      event: 'discovery.optional-http-rejected', discoveryStage: 'model-info', httpStatus: 404,
    }));
    expect(records).toContainEqual(expect.objectContaining({ event: 'discovery.succeeded', chatModelCount: 1 }));
    expect(records).toHaveLength(2);
    expect(records.some(record => record.event === 'discovery.failed')).toBe(false);
  });

  test('publishes the first model list even when optional model-info JSON is malformed', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: 'new-model' }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => { throw new SyntaxError('private-error-fixture\nBearer private-jwt-fixture'); } }));
    const set = vi.fn();
    const store = { get: () => ({}), set } as unknown as SqliteStore;

    await syncBuiltinModelProvider(store, { access: BuiltinModelAccess.Enabled });

    expect(set.mock.calls[0][1].model.defaultModel).toBe('new-model');
    expect(set.mock.calls[0][1].providers.builtin_models.models).toEqual([
      expect.objectContaining({ id: 'new-model', enabled: true }),
    ]);
    const [line] = vi.mocked(console.warn).mock.calls[0];
    expect(line).not.toMatch(/[\r\n]|private-.*-fixture|Bearer/);
    expect(JSON.parse(String(line).slice('[BuiltinModelAuth] '.length))).toEqual(expect.objectContaining({
      event: 'discovery.optional-failed', discoveryStage: 'model-info', reason: 'response-invalid-json',
    }));
  });

  test.each([
    ['fails to connect', async () => { throw new Error('optional service unreachable'); }],
    ['returns no usable data', async () => ({ ok: true, json: async () => ({}) })],
  ])('uses the fresh model list with known capabilities if optional metadata %s', async (_description, fetchInfo) => {
    const config = { providers: { builtin_models: {
      baseUrl: testProviderConfig.baseUrl,
      models: [{ id: 'chat-model', name: 'Previous name', supportsImage: true, enabled: false }],
      embeddingModels: [{ id: 'embedding-model' }, { id: 'retired-model' }],
    } } };
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        data: [{ id: 'chat-model', name: 'New name' }, { id: 'embedding-model' }, { id: 'new-model' }],
      }) })
      .mockImplementationOnce(fetchInfo));
    const set = vi.fn();
    const store = { get: () => config, set } as unknown as SqliteStore;

    await syncBuiltinModelProvider(store, { access: BuiltinModelAccess.Enabled });

    expect(set.mock.calls[0][1].providers.builtin_models).toMatchObject({
      models: [
        { id: 'chat-model', name: 'New name', supportsImage: true, enabled: false },
        { id: 'new-model', enabled: true },
      ],
      embeddingModels: [{ id: 'embedding-model' }],
    });
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
        Authorization: `Bearer ${getActiveBuiltinModelCredential()!.accessToken}`,
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
