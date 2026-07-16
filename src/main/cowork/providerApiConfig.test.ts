import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SqliteStore } from '../data/sqliteStore';
import { resolveRawApiConfig, setStoreGetter } from './providerApiConfig';

afterEach(() => {
  setStoreGetter(() => null);
  vi.restoreAllMocks();
});

describe('resolveRawApiConfig logging', () => {
  it('logs a credential-free provider summary only once for an unchanged selection', () => {
    const appConfig = {
      model: {
        defaultModel: 'model-1',
        defaultModelProvider: 'provider-1',
      },
      providers: {
        'provider-1': {
          enabled: true,
          apiKey: 'secret-key',
          baseUrl: 'https://example.test/v1',
          apiFormat: 'openai' as const,
          models: [{ id: 'model-1' }],
        },
      },
    };
    setStoreGetter(() => ({ get: () => appConfig }) as unknown as SqliteStore);
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);

    resolveRawApiConfig();
    resolveRawApiConfig();

    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith(
      '[ProviderApiConfig] resolved provider=provider-1 model=model-1 apiFormat=openai',
    );
    expect(debug.mock.calls.flat().join(' ')).not.toContain('secret-key');
    expect(debug.mock.calls.flat().join(' ')).not.toContain('example.test');
  });
});
