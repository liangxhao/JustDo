import type { ProviderWrapStreamFnContext } from 'openclaw/plugin-sdk/plugin-entry';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BUILTIN_SECRET_ID,
  BUILTIN_SECRET_SOURCE,
  MODEL_AUTH_SESSION_ENV,
  MODEL_AUTH_TYPE_ENV,
} from '../contracts/model-auth';
import { buildBuiltinModelAuthProvider, wrapBuiltinModelAuth } from '../model-auth';

const sdk = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('openclaw/plugin-sdk/secret-ref-runtime', () => ({ resolveSecretRefValues: sdk.resolve }));

const key = `exec:${BUILTIN_SECRET_SOURCE}:${BUILTIN_SECRET_ID}`;
const baseUrl = 'https://models.example.test/v1';
const model = {
  provider: 'builtin_models',
  id: 'fixture',
  api: 'openai-completions',
  baseUrl,
  headers: { 'X-ACCESS-JWT': 'old', authorization: 'Bearer old', 'X-Keep': 'model' },
};
const config = () => ({
  models: { providers: { builtin_models: { baseUrl } } },
  secrets: {
    providers: {
      [BUILTIN_SECRET_SOURCE]: {
        source: 'exec',
        command: '/trusted/resolver',
        env: { [MODEL_AUTH_SESSION_ENV]: 'a'.repeat(32), [MODEL_AUTH_TYPE_ENV]: 'jwt' },
      },
    },
  },
});
const fixture = (cfg = config()) => {
  const inner = vi.fn(
    async (..._args: Parameters<NonNullable<ProviderWrapStreamFnContext['streamFn']>>) =>
      'stream' as never,
  );
  const wrap = wrapBuiltinModelAuth({
    config: cfg,
    provider: 'builtin_models',
    streamFn: inner,
  } as never)!;
  return { inner, wrap };
};
const request = (wrap: ReturnType<typeof fixture>['wrap'], options = {}) =>
  wrap(model as never, { messages: [] }, options);

beforeEach(() => {
  vi.resetAllMocks();
  sdk.resolve.mockResolvedValue(new Map([[key, 'current']]));
});

describe('managed model request authentication', () => {
  it('replaces captured credentials on every request without mutating run inputs', async () => {
    const { wrap, inner } = fixture();
    const options = {
      apiKey: 'old',
      headers: { 'x-access-jwt': 'old', AUTHORIZATION: 'Bearer old', 'X-Keep': 'options' },
    };
    await request(wrap, options);
    sdk.resolve.mockResolvedValueOnce(new Map([[key, 'renewed']]));
    await request(wrap, options);
    expect(sdk.resolve).toHaveBeenCalledTimes(2);
    expect(inner.mock.calls[1]).toEqual([
      {
        ...model,
        headers: { 'X-Keep': 'model', Authorization: 'Bearer renewed', 'X-ACCESS-JWT': 'renewed' },
      },
      { messages: [] },
      {
        apiKey: 'renewed',
        headers: {
          'X-Keep': 'options',
          Authorization: 'Bearer renewed',
          'X-ACCESS-JWT': 'renewed',
        },
      },
    ]);
    expect(model.headers['X-ACCESS-JWT']).toBe('old');
    expect(options.apiKey).toBe('old');
    expect(sdk.resolve.mock.calls[1][1]).not.toHaveProperty('cache');
  });

  it('never falls back to the captured key after logout, expiry or resolver failure', async () => {
    const { wrap, inner } = fixture();
    await request(wrap);
    sdk.resolve.mockRejectedValueOnce(new Error('private credential/path'));
    await expect(request(wrap, { apiKey: 'old' })).rejects.toThrow(
      'Managed model credentials are unavailable.',
    );
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('pins the original session even if a caller replaces the config object', async () => {
    const cfg = config();
    const { wrap } = fixture(cfg);
    cfg.secrets.providers[BUILTIN_SECRET_SOURCE].env[MODEL_AUTH_SESSION_ENV] = 'b'.repeat(32);
    await request(wrap);
    expect(
      sdk.resolve.mock.calls[0][1].config.secrets.providers[BUILTIN_SECRET_SOURCE].env[
        MODEL_AUTH_SESSION_ENV
      ],
    ).toBe('a'.repeat(32));
  });

  it('keeps development API keys in Bearer authentication only', async () => {
    const cfg = config();
    cfg.secrets.providers[BUILTIN_SECRET_SOURCE].env[MODEL_AUTH_TYPE_ENV] = 'api-key';
    const { wrap, inner } = fixture(cfg);
    await request(wrap, { headers: { 'x-access-jwt': 'old' } });
    expect(inner.mock.calls[0][0].headers).toEqual({
      'X-Keep': 'model',
      Authorization: 'Bearer current',
    });
    expect(inner.mock.calls[0][2].headers).toEqual({ Authorization: 'Bearer current' });
  });

  it.each(['', 'unsafe\r\nheader', 'x'.repeat(8193), undefined])(
    'rejects an invalid resolved credential',
    async token => {
      sdk.resolve.mockResolvedValue(new Map([[key, token]]));
      const { wrap, inner } = fixture();
      await expect(request(wrap)).rejects.toThrow('Managed model credentials are unavailable.');
      expect(inner).not.toHaveBeenCalled();
    },
  );

  it('does not send credentials to a changed route or foreign provider', async () => {
    const { wrap, inner } = fixture();
    for (const change of [{ provider: 'custom' }, { baseUrl: 'https://other.test/v1' }]) {
      await expect(wrap({ ...model, ...change } as never, { messages: [] }, {})).rejects.toThrow();
    }
    expect(sdk.resolve).not.toHaveBeenCalled();
    expect(inner).not.toHaveBeenCalled();
  });

  it('accepts native normalization of a trailing slash on the configured base URL', async () => {
    const cfg = config();
    cfg.models.providers.builtin_models.baseUrl += '/';
    const { wrap, inner } = fixture(cfg);
    await request(wrap);
    expect(inner).toHaveBeenCalledOnce();
  });

  it('fails closed if the managed session is missing', async () => {
    const cfg = config();
    cfg.secrets.providers[BUILTIN_SECRET_SOURCE].env[MODEL_AUTH_SESSION_ENV] = '';
    const { wrap, inner } = fixture(cfg);
    await expect(request(wrap)).rejects.toThrow();
    expect(inner).not.toHaveBeenCalled();
  });

  it('honors cancellation before and during credential resolution', async () => {
    const { wrap, inner } = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(request(wrap, { signal: controller.signal })).rejects.toThrow();
    expect(sdk.resolve).not.toHaveBeenCalled();
    const active = new AbortController();
    sdk.resolve.mockImplementationOnce(async () => {
      active.abort();
      return new Map([[key, 'current']]);
    });
    await expect(request(wrap, { signal: active.signal })).rejects.toThrow();
    expect(inner).not.toHaveBeenCalled();
  });

  it('registers the same policy for embedded tasks and direct completions only on builtin_models', () => {
    const provider = buildBuiltinModelAuthProvider();
    expect(provider.id).toBe('builtin_models');
    expect(provider.wrapStreamFn).toBe(wrapBuiltinModelAuth);
    expect(provider.wrapSimpleCompletionStreamFn).toBe(wrapBuiltinModelAuth);
    expect(
      wrapBuiltinModelAuth({ provider: 'custom', streamFn: vi.fn() } as never),
    ).toBeUndefined();
  });
});
