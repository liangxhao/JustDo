import { afterEach, describe, expect, test, vi } from 'vitest';

import type { SqliteStore } from '../data/sqliteStore';
import { syncBuiltinModelProvider } from './builtinModelProvider';

describe('syncBuiltinModelProvider', () => {
  afterEach(() => {
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

    await syncBuiltinModelProvider(store);

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
    vi.stubGlobal(
      'fetch',
      vi
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
        }),
    );

    await syncBuiltinModelProvider(store);

    const savedConfig = set.mock.calls[0]?.[1];
    expect(savedConfig.providers.builtin_models.models).toEqual([
      expect.objectContaining({ id: 'chat-model' }),
    ]);
    expect(savedConfig.providers.builtin_models.embeddingModels).toEqual([
      expect.objectContaining({ id: 'embedding-a' }),
      expect.objectContaining({ id: 'embedding-z' }),
    ]);
  });
});
