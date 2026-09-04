import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SqliteStore } from '../data/sqliteStore';
import {
  BUILTIN_MODEL_AUTHORIZATION_PLACEHOLDER,
  clearActiveBuiltinModelCredential,
  setActiveBuiltinModelCredential,
} from './builtinModelCredential';
import {
  getProviderDisplayNameMap,
  resolveAllEnabledProviderConfigs,
  resolveAllProviderApiKeys,
  resolveCurrentApiConfig,
  resolveRawApiConfig,
  resolveRendererApiConfig,
  setStoreGetter,
  validateConfiguredOpenClawProviderNames,
} from './providerApiConfig';

afterEach(() => {
  clearActiveBuiltinModelCredential();
  setStoreGetter(() => null);
  vi.restoreAllMocks();
});

describe('built-in provider credential resolution', () => {
  const setActiveJwt = (): void => {
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
    setActiveBuiltinModelCredential({
      accessToken,
      userAccount: 'user-123',
      expiresAt: nowSeconds + 300,
    });
  };

  const setBuiltinStore = (): void => {
    setStoreGetter(
      () =>
        ({
          get: () => ({
            model: {
              defaultModel: 'team-model',
              defaultModelProvider: 'builtin_models',
            },
            providers: {
              builtin_models: {
                enabled: true,
                apiKey: '',
                baseUrl: 'http://127.0.0.1:9108/v1',
                models: [{ id: 'team-model' }],
              },
            },
          }),
        }) as unknown as SqliteStore,
    );
  };

  it('uses only a non-secret API-key sentinel while the in-memory JWT is active', () => {
    setBuiltinStore();
    setActiveJwt();

    expect(resolveCurrentApiConfig().config?.apiKey).toBe(BUILTIN_MODEL_AUTHORIZATION_PLACEHOLDER);
    expect(resolveRendererApiConfig().config?.apiKey).toBe('');
    expect(resolveAllProviderApiKeys()).toEqual({
      BUILTIN_MODELS: BUILTIN_MODEL_AUTHORIZATION_PLACEHOLDER,
    });
    expect(resolveAllEnabledProviderConfigs()[0]?.apiKey).toBe(
      BUILTIN_MODEL_AUTHORIZATION_PLACEHOLDER,
    );
  });

  it('does not fall back to a shared placeholder when the user token is missing', () => {
    setBuiltinStore();

    expect(resolveCurrentApiConfig()).toMatchObject({
      config: null,
      error: 'Built-in model authentication is unavailable.',
    });
    expect(resolveAllProviderApiKeys()).toEqual({});
    expect(resolveAllEnabledProviderConfigs()).toEqual([]);
  });

  it('falls back to an authenticated custom provider when the built-in token is missing', () => {
    setStoreGetter(
      () =>
        ({
          get: () => ({
            model: {
              defaultModel: 'team-model',
              defaultModelProvider: 'builtin_models',
            },
            providers: {
              builtin_models: {
                enabled: true,
                apiKey: '',
                baseUrl: 'http://127.0.0.1:9108/v1',
                models: [{ id: 'team-model' }],
              },
              custom_0: {
                enabled: true,
                apiKey: 'custom-secret',
                baseUrl: 'https://custom.example.test/v1',
                models: [{ id: 'custom-model' }],
              },
            },
          }),
        }) as unknown as SqliteStore,
    );

    expect(resolveCurrentApiConfig()).toMatchObject({
      config: {
        apiKey: 'custom-secret',
        model: 'custom-model',
      },
      providerMetadata: { providerName: 'custom_0' },
    });
  });
});

describe('OpenClaw custom provider names', () => {
  it('allows an explicitly configured OpenClaw provider id before config sync', () => {
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

    expect(validateConfiguredOpenClawProviderNames()).toEqual({ ok: true });
  });

  it('rejects a JustDo-owned provider id before config sync', () => {
    setStoreGetter(
      () =>
        ({
          get: () => ({
            providers: {
              custom_0: { enabled: true, displayName: 'builtin_models' },
            },
          }),
        }) as unknown as SqliteStore,
    );

    expect(validateConfiguredOpenClawProviderNames()).toEqual({
      ok: false,
      providerKey: 'custom_0',
      displayName: 'builtin_models',
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
