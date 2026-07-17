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
});
