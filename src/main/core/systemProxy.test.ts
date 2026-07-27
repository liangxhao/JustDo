import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { BUILTIN_MODEL_PROVIDER_CONFIG } from '../cowork/builtinModelProviderConfig';
import {
  applySystemProxyEnv,
  configureForcedProxyRouting,
  getNoProxyConflictingEntries,
  getNoProxyEntries,
  isLoopbackBaseUrl,
  setProcessProxyRouting,
  shouldBypassProxyForUrl,
} from './systemProxy';

vi.mock('electron', () => ({
  app: {
    isReady: () => true,
  },
  session: {
    defaultSession: {
      resolveProxy: vi.fn(),
    },
  },
}));

const PROXY_ENV_KEYS = [
  'http_proxy',
  'https_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'no_proxy',
  'NO_PROXY',
] as const;

const originalEnv = Object.fromEntries(
  PROXY_ENV_KEYS.map(key => [key, process.env[key]]),
) as Record<(typeof PROXY_ENV_KEYS)[number], string | undefined>;

const restoreTestEnvironment = (): void => {
  for (const key of PROXY_ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
};

describe('process proxy bypass', () => {
  beforeEach(() => {
    restoreTestEnvironment();
    setProcessProxyRouting({ bypassEntries: [], forcedBaseUrls: [] });
  });

  afterEach(() => {
    applySystemProxyEnv(null);
    setProcessProxyRouting({ bypassEntries: [], forcedBaseUrls: [] });
    restoreTestEnvironment();
  });

  test('proxies the configured local provider while preserving other loopback bypasses', () => {
    setProcessProxyRouting({
      bypassEntries: ['127.0.0.1:6006'],
      forcedBaseUrls: [BUILTIN_MODEL_PROVIDER_CONFIG.baseUrl],
    });
    const proxyUrl = 'http://127.0.0.1:9000';
    applySystemProxyEnv(proxyUrl);

    expect(process.env.HTTP_PROXY).toBe('http://127.0.0.1:9000');
    expect(process.env.HTTPS_PROXY).toBe('http://127.0.0.1:9000');
    expect(process.env.NO_PROXY?.split(',')).toContain('127.0.0.1:6006');
    expect(process.env.NO_PROXY?.split(',')).not.toContain('127.0.0.1');
    expect(process.env.NO_PROXY?.split(',')).toContain('localhost');
    expect(process.env.NO_PROXY?.split(',')).toContain('::1');
  });

  test('keeps the original loopback bypasses when no provider is forced through proxy', () => {
    setProcessProxyRouting({ bypassEntries: [], forcedBaseUrls: [] });
    const proxyUrl = 'http://127.0.0.1:9000';
    applySystemProxyEnv(proxyUrl);

    expect(process.env.NO_PROXY?.split(',')).toEqual(
      expect.arrayContaining(['localhost', '127.0.0.1', '::1']),
    );
  });

  test('reapplies an active proxy when the Gateway port changes', () => {
    setProcessProxyRouting({
      bypassEntries: ['127.0.0.1:6006'],
      forcedBaseUrls: [BUILTIN_MODEL_PROVIDER_CONFIG.baseUrl],
    });
    const proxyUrl = 'http://127.0.0.1:9000';
    applySystemProxyEnv(proxyUrl);
    setProcessProxyRouting({
      bypassEntries: ['127.0.0.1:7007'],
      forcedBaseUrls: [BUILTIN_MODEL_PROVIDER_CONFIG.baseUrl],
    });

    expect(process.env.NO_PROXY?.split(',')).toContain('127.0.0.1:7007');
    expect(process.env.NO_PROXY?.split(',')).not.toContain('127.0.0.1:6006');
  });

  test('does not restore a disabled proxy when the Gateway port changes', () => {
    const proxyUrl = 'http://127.0.0.1:9000';
    applySystemProxyEnv(proxyUrl);
    applySystemProxyEnv(null);
    setProcessProxyRouting({
      bypassEntries: ['127.0.0.1:7007'],
      forcedBaseUrls: [BUILTIN_MODEL_PROVIDER_CONFIG.baseUrl],
    });

    expect(process.env.HTTP_PROXY).toBe(originalEnv.HTTP_PROXY);
    expect(process.env.HTTPS_PROXY).toBe(originalEnv.HTTPS_PROXY);
  });

  test('uses the same provider and Gateway routing for system proxy mode', () => {
    setProcessProxyRouting({
      bypassEntries: ['127.0.0.1:6006'],
      forcedBaseUrls: [BUILTIN_MODEL_PROVIDER_CONFIG.baseUrl],
    });
    applySystemProxyEnv('http://system-proxy:8080');

    expect(process.env.NO_PROXY?.split(',')).toContain('127.0.0.1:6006');
    expect(process.env.NO_PROXY?.split(',')).not.toContain('127.0.0.1');
    expect(process.env.NO_PROXY?.split(',')).toContain('localhost');
    expect(process.env.NO_PROXY?.split(',')).toContain('::1');

    setProcessProxyRouting({
      bypassEntries: ['127.0.0.1:7007'],
      forcedBaseUrls: [BUILTIN_MODEL_PROVIDER_CONFIG.baseUrl],
    });
    expect(process.env.NO_PROXY?.split(',')).toContain('127.0.0.1:7007');
    expect(process.env.NO_PROXY?.split(',')).not.toContain('127.0.0.1:6006');
  });

  test('removes every IPv4 bypass pattern that matches the forced provider', () => {
    const env: NodeJS.ProcessEnv = {
      NO_PROXY: '127.0.0.1:4000,127.0.0.0/8,127.*,127.0.0.1:5000,localhost',
    };

    configureForcedProxyRouting(env, ['127.0.0.1:6006'], ['http://127.0.0.1:4000/v1']);

    expect(env.NO_PROXY?.split(',')).toEqual(
      expect.arrayContaining(['127.0.0.1:5000', '127.0.0.1:6006', 'localhost', '::1']),
    );
    expect(env.NO_PROXY?.split(',')).not.toContain('127.0.0.1:4000');
    expect(env.NO_PROXY?.split(',')).not.toContain('127.0.0.0/8');
    expect(env.NO_PROXY?.split(',')).not.toContain('127.*');
    expect(env.NO_PROXY?.split(',')).not.toContain('127.0.0.1');
  });

  test('removes suffix bypasses that match a forced provider hostname', () => {
    const env: NodeJS.ProcessEnv = {
      no_proxy: '.example.com,*.example.com,api.example.com:444,other.example.net',
    };

    configureForcedProxyRouting(env, [], ['https://api.example.com/v1']);

    expect(env.NO_PROXY?.split(',')).toEqual(
      expect.arrayContaining(['api.example.com:444', 'other.example.net']),
    );
    expect(env.NO_PROXY?.split(',')).not.toContain('.example.com');
    expect(env.NO_PROXY?.split(',')).not.toContain('*.example.com');
  });

  test('handles bracketed IPv6 bypasses with ports', () => {
    const env: NodeJS.ProcessEnv = {
      NO_PROXY: '[::1]:4000,[::1]:5000',
    };

    configureForcedProxyRouting(env, [], ['http://[::1]:4000/v1']);

    expect(env.NO_PROXY?.split(',')).toContain('[::1]:5000');
    expect(env.NO_PROXY?.split(',')).not.toContain('[::1]:4000');
    expect(env.NO_PROXY?.split(',')).not.toContain('::1');
  });

  test('uses the original bypass entries as an upstream routing policy', () => {
    const entries = getNoProxyEntries({
      NO_PROXY: '*.huawei.com,api.example.com:8443',
      no_proxy: '.internal.example',
    });

    expect(shouldBypassProxyForUrl(entries, 'https://api.huawei.com/v1/models')).toBe(true);
    expect(shouldBypassProxyForUrl(entries, 'https://api.example.com:8443/v1')).toBe(true);
    expect(shouldBypassProxyForUrl(entries, 'https://api.example.com/v1')).toBe(false);
    expect(shouldBypassProxyForUrl(entries, 'https://external.example/v1')).toBe(false);
    expect(
      getNoProxyConflictingEntries(entries, [
        'https://api.huawei.com/v1/',
        'https://external.example/v1/',
      ]),
    ).toEqual(['*.huawei.com']);
  });
});

describe('isLoopbackBaseUrl', () => {
  test('accepts localhost and IP loopback URLs', () => {
    expect(isLoopbackBaseUrl('http://localhost:4000/v1')).toBe(true);
    expect(isLoopbackBaseUrl('https://models.localhost/v1')).toBe(true);
    expect(isLoopbackBaseUrl('http://127.0.0.1:4000/v1')).toBe(true);
    expect(isLoopbackBaseUrl('http://127.10.20.30/v1')).toBe(true);
    expect(isLoopbackBaseUrl('http://[::1]:4000/v1')).toBe(true);
  });

  test('rejects remote, non-loopback, and invalid base URLs', () => {
    expect(isLoopbackBaseUrl('https://api.example.com/v1')).toBe(false);
    expect(isLoopbackBaseUrl('http://192.168.1.20:4000/v1')).toBe(false);
    expect(isLoopbackBaseUrl('file:///tmp/model')).toBe(false);
    expect(isLoopbackBaseUrl('not-a-url')).toBe(false);
  });
});
