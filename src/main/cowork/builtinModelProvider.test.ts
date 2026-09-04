import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { SqliteStore } from '../data/sqliteStore';
import {
  clearActiveBuiltinModelCredential,
  setActiveBuiltinModelCredential,
} from './builtinModelCredential';
import { BuiltinModelAccess, syncBuiltinModelProvider } from './builtinModelProvider';

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
  beforeEach(() => {
    setActiveBuiltinModelCredential(createCredential());
  });

  afterEach(() => {
    clearActiveBuiltinModelCredential();
    vi.unstubAllGlobals();
  });

  test('clears cached models when refreshing the built-in provider fails', async () => {
    const appConfig = {
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
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network unavailable')));

    await syncBuiltinModelProvider(store, { access: BuiltinModelAccess.Enabled });

    expect(set).toHaveBeenCalledWith(
      'app_config',
      expect.objectContaining({
        providers: expect.objectContaining({
          builtin_models: expect.objectContaining({ models: [] }),
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
        Authorization: 'Bearer justdo-jwt-auth',
        'X-JustDo-JWT': expect.stringMatching(/^[^.]+\.[^.]+\.[^.]+$/),
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
});
