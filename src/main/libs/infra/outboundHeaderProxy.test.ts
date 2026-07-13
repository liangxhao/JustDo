import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test, vi } from 'vitest';

import {
  getOutboundHeaderPolicyConfig,
  getOutboundHeaderUserInfo,
  updateOutboundHeaderUserInfoCache,
} from './outboundHeaderPolicyConfig';
import {
  applyOutboundHeaders,
  applyOutboundProxyEnv,
  isIgnorableProxyClientError,
  isOutboundHeaderProxyActive,
  OutboundHeaderProxy,
  resolveOutboundHeaderProxyConfig,
  restoreOutboundProxyEnv,
  shouldApplyOutboundHeadersForRequest,
  shouldInjectOutboundHeaders,
  shouldSuppressMitmProxyErrorLog,
  suppressNoisyMitmDisconnectLogs,
} from './outboundHeaderProxy';

const temporaryDirectories: string[] = [];
const HEADER_NAMES = {
  USER_ACCOUNT: 'X-User-Account',
  COOKIE: 'X-Cookie',
} as const;
const CONFIGURED_HEADER_NAMES = [HEADER_NAMES.USER_ACCOUNT, HEADER_NAMES.COOKIE] as const;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const writeUserInfo = (content: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-user-info-'));
  temporaryDirectories.push(directory);
  const userInfoPath = path.join(directory, 'user_info.json');
  fs.writeFileSync(userInfoPath, content);
  return userInfoPath;
};

const writePolicyConfig = (content: object): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-header-policy-'));
  temporaryDirectories.push(directory);
  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(content));
  return configPath;
};

test('matches no requests when the whitelist is empty', () => {
  expect(shouldInjectOutboundHeaders('https://example.com/a', [])).toBe(false);
});

test('matches only configured origins and path prefixes', () => {
  const baseUrlWhitelist = ['https://example.com/api/'];

  expect(shouldInjectOutboundHeaders('https://example.com/api/users', baseUrlWhitelist)).toBe(true);
  expect(shouldInjectOutboundHeaders('https://example.com/other', baseUrlWhitelist)).toBe(false);
  expect(shouldInjectOutboundHeaders('https://other.example/api/users', baseUrlWhitelist)).toBe(
    false,
  );
});

test('applies outbound headers only when enabled and the URL is whitelisted', () => {
  const config = {
    enabled: true,
    baseUrlWhitelist: ['https://example.com/api/'],
    headerNames: [HEADER_NAMES.USER_ACCOUNT],
  };

  expect(isOutboundHeaderProxyActive(config)).toBe(true);
  expect(shouldApplyOutboundHeadersForRequest(config, 'https://example.com/api/users')).toBe(true);
  expect(shouldApplyOutboundHeadersForRequest(config, 'https://example.com/other')).toBe(false);
  expect(
    shouldApplyOutboundHeadersForRequest(
      { ...config, enabled: false },
      'https://example.com/api/users',
    ),
  ).toBe(false);
});

test('reads configured values from user_info.json', () => {
  const userInfoPath = writeUserInfo(
    JSON.stringify({
      [HEADER_NAMES.USER_ACCOUNT]: 'user-123',
      [HEADER_NAMES.COOKIE]: 'cookie-value',
      ignored: 'not-a-header',
    }),
  );

  expect(updateOutboundHeaderUserInfoCache(userInfoPath, CONFIGURED_HEADER_NAMES)).toEqual({
    [HEADER_NAMES.USER_ACCOUNT]: 'user-123',
    [HEADER_NAMES.COOKIE]: 'cookie-value',
  });
});

test('uses empty strings for missing, empty, null, or unsupported values', () => {
  const userInfoPath = writeUserInfo(
    JSON.stringify({
      [HEADER_NAMES.USER_ACCOUNT]: '',
      [HEADER_NAMES.COOKIE]: null,
      object_value: { secret: true },
    }),
  );

  expect(
    updateOutboundHeaderUserInfoCache(userInfoPath, [
      ...CONFIGURED_HEADER_NAMES,
      'missing',
      'object_value',
    ]),
  ).toEqual({
    [HEADER_NAMES.USER_ACCOUNT]: '',
    [HEADER_NAMES.COOKIE]: '',
    missing: '',
    object_value: '',
  });
});

test('uses empty values when user_info.json does not exist', () => {
  expect(
    updateOutboundHeaderUserInfoCache('missing-user-info.json', CONFIGURED_HEADER_NAMES),
  ).toEqual({
    [HEADER_NAMES.USER_ACCOUNT]: '',
    [HEADER_NAMES.COOKIE]: '',
  });
});

test('reuses cached user info until the update function is called', () => {
  const userInfoPath = writeUserInfo(JSON.stringify({ [HEADER_NAMES.USER_ACCOUNT]: 'first' }));

  updateOutboundHeaderUserInfoCache(userInfoPath, [HEADER_NAMES.USER_ACCOUNT]);
  fs.writeFileSync(userInfoPath, JSON.stringify({ [HEADER_NAMES.USER_ACCOUNT]: 'second' }));

  expect(getOutboundHeaderUserInfo(userInfoPath, [HEADER_NAMES.USER_ACCOUNT])).toEqual({
    [HEADER_NAMES.USER_ACCOUNT]: 'first',
  });
  expect(updateOutboundHeaderUserInfoCache(userInfoPath, [HEADER_NAMES.USER_ACCOUNT])).toEqual({
    [HEADER_NAMES.USER_ACCOUNT]: 'second',
  });
});

test('reloads the outbound header policy together with user info', () => {
  const userInfoPath = writeUserInfo(JSON.stringify({ account_id: 'account-123' }));
  const configPath = writePolicyConfig({
    enabled: false,
    baseUrlWhitelist: ['https://example.com/api/'],
    headerNames: ['account_id'],
  });

  expect(updateOutboundHeaderUserInfoCache(userInfoPath, undefined, configPath)).toEqual({
    account_id: 'account-123',
  });
  expect(getOutboundHeaderPolicyConfig()).toEqual({
    enabled: false,
    baseUrlWhitelist: ['https://example.com/api/'],
    headerNames: ['account_id'],
  });
});

test('adds only configured header values and replaces names case-insensitively', () => {
  const headers = { [HEADER_NAMES.USER_ACCOUNT]: 'old-value', untouched: 'yes' };

  applyOutboundHeaders(headers, {
    [HEADER_NAMES.USER_ACCOUNT]: 'user-123',
    [HEADER_NAMES.COOKIE]: 'cookie-value',
  });

  expect(headers).toEqual({
    [HEADER_NAMES.USER_ACCOUNT]: 'user-123',
    [HEADER_NAMES.COOKIE]: 'cookie-value',
    untouched: 'yes',
  });
});

test('normalizes the static policy and ignores invalid base URLs', () => {
  expect(
    resolveOutboundHeaderProxyConfig({
      enabled: true,
      headerNames: [
        ` ${HEADER_NAMES.USER_ACCOUNT} `,
        '',
        'invalid header',
        'bad:header',
        HEADER_NAMES.COOKIE,
      ],
      baseUrlWhitelist: ['https://one.example/api/', 'invalid', 'http://two.example/'],
    }),
  ).toEqual({
    enabled: true,
    headerNames: CONFIGURED_HEADER_NAMES,
    baseUrlWhitelist: ['https://one.example/api/', 'http://two.example/'],
  });
});

test('configures common Node, Python, and curl proxy environment variables for active policies', () => {
  const env: NodeJS.ProcessEnv = {
    NO_PROXY: 'internal.example,localhost,127.0.0.1',
    no_proxy: 'legacy.example,::1',
  };

  applyOutboundProxyEnv(
    env,
    {
      proxyUrl: 'http://127.0.0.1:1234',
      caCertificatePath: '/tmp/ca.pem',
    },
    {
      enabled: true,
      baseUrlWhitelist: ['https://example.com/api/'],
      headerNames: [HEADER_NAMES.USER_ACCOUNT],
    },
    ['127.0.0.1:4321'],
  );

  expect(env).toMatchObject({
    HTTP_PROXY: 'http://127.0.0.1:1234',
    HTTPS_PROXY: 'http://127.0.0.1:1234',
    NODE_EXTRA_CA_CERTS: '/tmp/ca.pem',
    NODE_USE_ENV_PROXY: '1',
    REQUESTS_CA_BUNDLE: '/tmp/ca.pem',
    CURL_CA_BUNDLE: '/tmp/ca.pem',
    SSL_CERT_FILE: '/tmp/ca.pem',
    NO_PROXY: 'internal.example,legacy.example,127.0.0.1:4321',
    no_proxy: 'internal.example,legacy.example,127.0.0.1:4321',
  });
});

test('routes local LiteLLM through the proxy when no explicit bypass entries are provided', () => {
  const env: NodeJS.ProcessEnv = {
    NO_PROXY: 'internal.example,localhost,127.0.0.1,::1',
    no_proxy: '*',
  };

  applyOutboundProxyEnv(
    env,
    {
      proxyUrl: 'http://127.0.0.1:1234',
      caCertificatePath: '/tmp/ca.pem',
    },
    {
      enabled: true,
      baseUrlWhitelist: ['https://example.com/api/'],
      headerNames: [HEADER_NAMES.USER_ACCOUNT],
    },
  );

  expect(env.NO_PROXY).toBe('internal.example');
  expect(env.no_proxy).toBe('internal.example');
});

test('replaces a stale Gateway bypass when its port changes', () => {
  const env: NodeJS.ProcessEnv = {
    NO_PROXY: 'internal.example,localhost',
  };
  const proxyInfo = {
    proxyUrl: 'http://127.0.0.1:1234',
    caCertificatePath: '/tmp/ca.pem',
  };
  const config = {
    enabled: true,
    baseUrlWhitelist: ['http://127.0.0.1:4000/'],
    headerNames: [HEADER_NAMES.USER_ACCOUNT],
  };

  applyOutboundProxyEnv(env, proxyInfo, config, ['127.0.0.1:4321']);
  applyOutboundProxyEnv(env, proxyInfo, config, ['127.0.0.1:4322']);

  expect(env.NO_PROXY).toBe('internal.example,127.0.0.1:4322');
  expect(env.no_proxy).toBe('internal.example,127.0.0.1:4322');
});

test('does not configure proxy environment variables when disabled or whitelist is empty', () => {
  const disabledEnv: NodeJS.ProcessEnv = {
    HTTP_PROXY: 'http://system-proxy:8080',
    NO_PROXY: 'localhost',
  };
  const emptyWhitelistEnv: NodeJS.ProcessEnv = {
    HTTPS_PROXY: 'http://system-proxy:8080',
  };
  const proxyInfo = {
    proxyUrl: 'http://127.0.0.1:1234',
    caCertificatePath: '/tmp/ca.pem',
  };

  applyOutboundProxyEnv(disabledEnv, proxyInfo, {
    enabled: false,
    baseUrlWhitelist: ['https://example.com/api/'],
    headerNames: [HEADER_NAMES.USER_ACCOUNT],
  });
  applyOutboundProxyEnv(emptyWhitelistEnv, proxyInfo, {
    enabled: true,
    baseUrlWhitelist: [],
    headerNames: [HEADER_NAMES.USER_ACCOUNT],
  });

  expect(disabledEnv).toEqual({
    HTTP_PROXY: 'http://system-proxy:8080',
    NO_PROXY: 'localhost',
  });
  expect(emptyWhitelistEnv).toEqual({
    HTTPS_PROXY: 'http://system-proxy:8080',
  });
});

test('restores outbound-header-specific environment variables', () => {
  const keys = [
    'NODE_EXTRA_CA_CERTS',
    'NODE_USE_ENV_PROXY',
    'REQUESTS_CA_BUNDLE',
    'CURL_CA_BUNDLE',
    'SSL_CERT_FILE',
  ] as const;
  const expected = Object.fromEntries(
    keys
      .map(key => [key, process.env[key]])
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  const env: NodeJS.ProcessEnv = {
    NODE_EXTRA_CA_CERTS: '/tmp/ca.pem',
    NODE_USE_ENV_PROXY: '1',
    REQUESTS_CA_BUNDLE: '/tmp/ca.pem',
    CURL_CA_BUNDLE: '/tmp/ca.pem',
    SSL_CERT_FILE: '/tmp/ca.pem',
  };

  restoreOutboundProxyEnv(env);

  expect(env).toEqual(expected);
});

test('classifies proxy client disconnects as ignorable errors', () => {
  expect(
    isIgnorableProxyClientError(
      Object.assign(new Error('socket hang up'), {
        code: 'ECONNRESET',
      }),
    ),
  ).toBe(true);
  expect(isIgnorableProxyClientError(new Error('connection reset by peer'))).toBe(true);
  expect(
    isIgnorableProxyClientError(
      Object.assign(new Error('upstream failed'), {
        code: 'ETIMEDOUT',
      }),
    ),
  ).toBe(false);
});

test('suppresses noisy MITM logs only for ignorable disconnects', () => {
  const resetError = Object.assign(new Error('socket hang up'), {
    code: 'ECONNRESET',
  });

  expect(shouldSuppressMitmProxyErrorLog('SERVER_TO_PROXY_RESPONSE_ERROR', resetError)).toBe(true);
  expect(shouldSuppressMitmProxyErrorLog('PROXY_TO_SERVER_REQUEST_ERROR', resetError)).toBe(true);
  expect(shouldSuppressMitmProxyErrorLog('ON_REQUEST_ERROR', resetError)).toBe(false);
  expect(
    shouldSuppressMitmProxyErrorLog(
      'SERVER_TO_PROXY_RESPONSE_ERROR',
      Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
    ),
  ).toBe(false);
});

test('keeps MITM error handlers while skipping raw disconnect logging', () => {
  const originalOnError = vi.fn();
  const proxyHandler = vi.fn();
  const contextHandler = vi.fn();
  const proxy = {
    _onError: originalOnError,
    onErrorHandlers: [proxyHandler],
  };
  const context = {
    onErrorHandlers: [contextHandler],
  };
  const resetError = Object.assign(new Error('socket hang up'), {
    code: 'ECONNRESET',
  });

  suppressNoisyMitmDisconnectLogs(proxy as never);
  proxy._onError('SERVER_TO_PROXY_RESPONSE_ERROR', context, resetError);

  expect(originalOnError).not.toHaveBeenCalled();
  expect(proxyHandler).toHaveBeenCalledWith(context, resetError, 'SERVER_TO_PROXY_RESPONSE_ERROR');
  expect(contextHandler).toHaveBeenCalledWith(context, resetError, 'SERVER_TO_PROXY_RESPONSE_ERROR');

  const timeoutError = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
  proxy._onError('SERVER_TO_PROXY_RESPONSE_ERROR', context, timeoutError);

  expect(originalOnError).toHaveBeenCalledWith(
    'SERVER_TO_PROXY_RESPONSE_ERROR',
    context,
    timeoutError,
  );
});

test('accepts a dynamic upstream proxy resolver and user info path', () => {
  const resolver = async (targetUrl: string) =>
    targetUrl.startsWith('https://internal.example') ? 'http://system-proxy:8080' : null;

  expect(
    () =>
      new OutboundHeaderProxy(undefined, resolver, 'C:\\AppData\\JustDo\\huawei\\user_info.json'),
  ).not.toThrow();
});
