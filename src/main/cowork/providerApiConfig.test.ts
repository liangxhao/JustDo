import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SqliteStore } from '../data/sqliteStore';
import {
  getProviderDisplayNameMap,
  resolveAllEnabledProviderConfigs,
  resolveRawApiConfig,
  setStoreGetter,
  validateConfiguredOpenClawProviderNames,
} from './providerApiConfig';

afterEach(() => {
  setStoreGetter(() => null);
  vi.restoreAllMocks();
});

describe('OpenClaw custom provider names', () => {
  it('rejects an official provider id before config sync', () => {
    setStoreGetter(
      () =>
        ({
          get: () => ({
            providers: {
              custom_0: {
                enabled: true,
                apiKey: 'secret-key',
                baseUrl: 'https://example.test/v1',
                displayName: 'OpenCode',
              },
            },
          }),
        }) as unknown as SqliteStore,
    );

    expect(validateConfiguredOpenClawProviderNames()).toEqual({
      ok: false,
      providerKey: 'custom_0',
      displayName: 'OpenCode',
      reason: 'reserved',
    });
  });

  it('rejects duplicate wire ids case-insensitively', () => {
    setStoreGetter(
      () =>
        ({
          get: () => ({
            providers: {
              custom_0: { enabled: true, displayName: 'AcmeProxy' },
              custom_1: { enabled: true, displayName: 'ACMEPROXY' },
            },
          }),
        }) as unknown as SqliteStore,
    );

    expect(validateConfiguredOpenClawProviderNames()).toMatchObject({
      ok: false,
      providerKey: 'custom_1',
      reason: 'duplicate',
    });
  });

  it('rejects a malformed persisted display name without throwing', () => {
    setStoreGetter(
      () =>
        ({
          get: () => ({
            providers: {
              custom_0: { enabled: true, displayName: 42 },
            },
          }),
        }) as unknown as SqliteStore,
    );

    expect(validateConfiguredOpenClawProviderNames()).toEqual({
      ok: false,
      providerKey: 'custom_0',
      displayName: 'Custom0',
      reason: 'format',
    });
  });

  it('uses the effective display name for custom provider routes', () => {
    setStoreGetter(
      () =>
        ({
          get: () => ({
            providers: {
              custom_0: { enabled: true, displayName: 'AcmeProxy' },
              custom_1: { enabled: true, displayName: '' },
            },
          }),
        }) as unknown as SqliteStore,
    );

    expect(validateConfiguredOpenClawProviderNames()).toEqual({ ok: true });
    expect(getProviderDisplayNameMap()).toEqual({
      custom_0: 'AcmeProxy',
      custom_1: 'Custom1',
    });
  });
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

  it('falls back to an enabled model when the configured model is unchecked', () => {
    const appConfig = {
      model: {
        defaultModel: 'disabled-model',
        defaultModelProvider: 'provider-1',
      },
      providers: {
        'provider-1': {
          enabled: true,
          apiKey: 'secret-key',
          baseUrl: 'https://example.test/v1',
          apiFormat: 'openai' as const,
          models: [
            { id: 'disabled-model', enabled: false },
            { id: 'enabled-model', enabled: true },
          ],
        },
      },
    };
    setStoreGetter(() => ({ get: () => appConfig }) as unknown as SqliteStore);
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);

    const result = resolveRawApiConfig();

    expect(result.config?.model).toBe('enabled-model');
  });

  it('omits unchecked models from enabled provider configs', () => {
    const appConfig = {
      providers: {
        'provider-1': {
          enabled: true,
          apiKey: 'secret-key',
          baseUrl: 'https://example.test/v1',
          apiFormat: 'openai' as const,
          models: [{ id: 'disabled-model', enabled: false }, { id: 'enabled-model' }],
        },
      },
    };
    setStoreGetter(() => ({ get: () => appConfig }) as unknown as SqliteStore);

    const result = resolveAllEnabledProviderConfigs();

    expect(result).toHaveLength(1);
    expect(result[0]?.models).toEqual([{ id: 'enabled-model' }]);
  });
});
