import type { DecisionProviderV1 } from 'openclaw/plugin-sdk/decisions';
import { createDeferred } from 'openclaw/plugin-sdk/extension-shared';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('openclaw/plugin-sdk/secret-input-runtime', () => ({
  getPreparedPluginSecretInput: () => ({ revision: 1, value: 'synthetic-key' }),
}));

beforeEach(() => {
  vi.resetModules();
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    vi.stubEnv(name, '');
  }
});

afterEach(() => {
  vi.doUnmock('./client.js');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const batch = { state: 'synthetic', questions: { q: { type: 'boolean' as const } } };
const response = {
  model: 'jev-selected',
  answers: { q: { type: 'noul', noul: 0.75 } },
  usage: { input_tokens: 3, output_tokens: 1 },
};
const context = (isAdmissible: () => boolean) => ({
  model: 'jev-selected',
  signal: new AbortController().signal,
  deadlineMonotonicMs: performance.now() + 30_000,
  isAdmissible,
});

async function register(config: { baseUrl?: string; serviceUrl?: string }) {
  const { default: plugin } = await import('../index.js');
  const registerDecisionProvider = vi.fn<OpenClawPluginApi['registerDecisionProvider']>();
  plugin.register({
    runtime: { config: { current: () => ({ plugins: { entries: { typesafe: { config } } } }) } },
    registerDecisionProvider,
  } as unknown as OpenClawPluginApi);
  const provider = registerDecisionProvider.mock.calls[0]?.[0];
  expect(provider).toBeDefined();
  return provider as DecisionProviderV1;
}

const endpoints = [
  { kind: 'hosted', config: {}, url: 'https://api.typesafe.ai/v1/systemone' },
  {
    kind: 'loopback',
    config: { baseUrl: 'http://localhost:8009' },
    url: 'http://localhost:8009/v1/systemone',
  },
  {
    kind: 'authenticated intranet',
    config: { serviceUrl: 'http://evaluation.internal:8009/private/v1' },
    url: 'http://evaluation.internal:8009/private/v1/systemone',
  },
];

describe.each(endpoints)('$kind admission', ({ kind, config, url }) => {
  it('rejects initial denial before guarded-fetch preparation', async () => {
    const ssrf = await import('openclaw/plugin-sdk/ssrf-runtime');
    const guard = vi.spyOn(ssrf, 'fetchWithSsrFGuard');
    const fetch = vi.fn(async () => new Response(JSON.stringify(response)));
    vi.stubGlobal('fetch', fetch);
    const isAdmissible = vi.fn(() => false);

    await expect((await register(config)).evaluate(batch, context(isAdmissible))).resolves.toEqual({
      status: 'unavailable',
      reason: 'transport',
    });

    expect(isAdmissible).toHaveBeenCalledOnce();
    expect(guard).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('observes admission revoked while the real evaluator import is pending', async () => {
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    vi.doMock('./client.js', async (importOriginal) => {
      started.resolve();
      await release.promise;
      return importOriginal<typeof import('./client.js')>();
    });
    const fetch = vi.fn(async () => new Response(JSON.stringify(response)));
    vi.stubGlobal('fetch', fetch);
    let admitted = true;
    const isAdmissible = vi.fn(() => admitted);
    const provider = await register(config);
    const pending = provider.evaluate(batch, context(isAdmissible));
    try {
      await started.promise;
      expect(fetch).not.toHaveBeenCalled();
      admitted = false;
    } finally {
      release.resolve();
    }

    await expect(pending).resolves.toEqual({ status: 'unavailable', reason: 'transport' });
    expect(isAdmissible).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'rechecks admission after native DNS preparation (revoked: %s)',
    async (revoked) => {
      const ssrf = await import('openclaw/plugin-sdk/ssrf-runtime');
      const nativeGuard = ssrf.fetchWithSsrFGuard;
      const started = createDeferred<void>();
      const release = createDeferred<void>();
      const lookup = vi.fn(async () => {
        started.resolve();
        await release.promise;
        const address = kind === 'hosted' ? '93.184.216.34'
          : kind === 'loopback' ? '127.0.0.1' : '10.20.30.40';
        return [{ address, family: 4 }];
      });
      // Inject DNS only: the real guard must perform its await and beforeRequest check.
      const guard = vi.spyOn(ssrf, 'fetchWithSsrFGuard').mockImplementation((params) =>
        nativeGuard({ ...params, lookupFn: lookup }),
      );
      const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(response)),
      );
      vi.stubGlobal('fetch', fetch);
      let admitted = true;
      const isAdmissible = vi.fn(() => admitted);
      const pending = (await register(config)).evaluate(batch, context(isAdmissible));
      try {
        await started.promise;
        expect(isAdmissible).toHaveBeenCalledOnce();
        expect(fetch).not.toHaveBeenCalled();
        admitted = !revoked;
      } finally {
        release.resolve();
      }

      const outcome = await pending;
      expect(lookup).toHaveBeenCalledExactlyOnceWith(new URL(url).hostname, { all: true });
      expect(guard).toHaveBeenCalledOnce();
      expect(isAdmissible).toHaveBeenCalledTimes(2);
      if (revoked) {
        expect(outcome).toEqual({ status: 'unavailable', reason: 'transport' });
        expect(fetch).not.toHaveBeenCalled();
      } else {
        expect(outcome).toMatchObject({
          status: 'ok',
          result: { model: 'jev-selected', answers: { q: { probabilityTrue: 0.75 } } },
        });
        expect(fetch).toHaveBeenCalledOnce();
        expect(fetch.mock.calls[0]?.[0]).toBe(url);
        const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
        expect(headers.get('Authorization')).toBe(kind === 'loopback' ? null : 'Bearer synthetic-key');
      }
    },
  );
});
