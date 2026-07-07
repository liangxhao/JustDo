import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test } from 'vitest';

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
} from './outboundHeaderProxy';

const temporaryDirectories: string[] = [];

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
    headerNames: ['user_id'],
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
      user_id: 'user-123',
      user_cookie: 'cookie-value',
      ignored: 'not-a-header',
    }),
  );

  expect(updateOutboundHeaderUserInfoCache(userInfoPath, ['user_id', 'user_cookie'])).toEqual({
    user_id: 'user-123',
    user_cookie: 'cookie-value',
  });
});

test('uses empty strings for missing, empty, null, or unsupported values', () => {
  const userInfoPath = writeUserInfo(
    JSON.stringify({
      user_id: '',
      user_cookie: null,
      object_value: { secret: true },
    }),
  );

  expect(
    updateOutboundHeaderUserInfoCache(userInfoPath, [
      'user_id',
      'user_cookie',
      'missing',
      'object_value',
    ]),
  ).toEqual({
    user_id: '',
    user_cookie: '',
    missing: '',
    object_value: '',
  });
});

test('uses empty values when user_info.json does not exist', () => {
  expect(
    updateOutboundHeaderUserInfoCache('missing-user-info.json', ['user_id', 'user_cookie']),
  ).toEqual({
    user_id: '',
    user_cookie: '',
  });
});

test('reuses cached user info until the update function is called', () => {
  const userInfoPath = writeUserInfo(JSON.stringify({ user_id: 'first' }));

  updateOutboundHeaderUserInfoCache(userInfoPath, ['user_id']);
  fs.writeFileSync(userInfoPath, JSON.stringify({ user_id: 'second' }));

  expect(getOutboundHeaderUserInfo(userInfoPath, ['user_id'])).toEqual({ user_id: 'first' });
  expect(updateOutboundHeaderUserInfoCache(userInfoPath, ['user_id'])).toEqual({
    user_id: 'second',
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
  const headers = { User_Id: 'old-value', untouched: 'yes' };

  applyOutboundHeaders(headers, {
    user_id: 'user-123',
    user_cookie: 'cookie-value',
  });

  expect(headers).toEqual({
    User_Id: 'user-123',
    user_cookie: 'cookie-value',
    untouched: 'yes',
  });
});

test('normalizes the static policy and ignores invalid base URLs', () => {
  expect(
    resolveOutboundHeaderProxyConfig({
      enabled: true,
      headerNames: [' user_id ', '', 'invalid header', 'bad:header', 'user_cookie'],
      baseUrlWhitelist: ['https://one.example/api/', 'invalid', 'http://two.example/'],
    }),
  ).toEqual({
    enabled: true,
    headerNames: ['user_id', 'user_cookie'],
    baseUrlWhitelist: ['https://one.example/api/', 'http://two.example/'],
  });
});

test('configures common Node, Python, and curl proxy environment variables for active policies', () => {
  const env: NodeJS.ProcessEnv = {};

  applyOutboundProxyEnv(
    env,
    {
      proxyUrl: 'http://127.0.0.1:1234',
      caCertificatePath: '/tmp/ca.pem',
    },
    {
      enabled: true,
      baseUrlWhitelist: ['https://example.com/api/'],
      headerNames: ['user_id'],
    },
  );

  expect(env).toMatchObject({
    HTTP_PROXY: 'http://127.0.0.1:1234',
    HTTPS_PROXY: 'http://127.0.0.1:1234',
    NODE_EXTRA_CA_CERTS: '/tmp/ca.pem',
    NODE_USE_ENV_PROXY: '1',
    REQUESTS_CA_BUNDLE: '/tmp/ca.pem',
    CURL_CA_BUNDLE: '/tmp/ca.pem',
    SSL_CERT_FILE: '/tmp/ca.pem',
    NO_PROXY: '',
    no_proxy: '',
  });
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
    headerNames: ['user_id'],
  });
  applyOutboundProxyEnv(emptyWhitelistEnv, proxyInfo, {
    enabled: true,
    baseUrlWhitelist: [],
    headerNames: ['user_id'],
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

test('accepts a dynamic upstream proxy resolver and user info path', () => {
  const resolver = async (targetUrl: string) =>
    targetUrl.startsWith('https://internal.example') ? 'http://system-proxy:8080' : null;

  expect(
    () =>
      new OutboundHeaderProxy(undefined, resolver, 'C:\\AppData\\JustDo\\huawei\\user_info.json'),
  ).not.toThrow();
});
