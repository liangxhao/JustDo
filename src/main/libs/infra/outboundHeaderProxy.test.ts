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
  OutboundHeaderProxy,
  resolveOutboundHeaderProxyConfig,
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
  expect(shouldInjectOutboundHeaders('https://other.example/api/users', baseUrlWhitelist)).toBe(false);
});

test('reads configured values from user_info.json', () => {
  const userInfoPath = writeUserInfo(JSON.stringify({
    user_id: 'user-123',
    user_cookie: 'cookie-value',
    ignored: 'not-a-header',
  }));

  expect(updateOutboundHeaderUserInfoCache(userInfoPath, ['user_id', 'user_cookie'])).toEqual({
    user_id: 'user-123',
    user_cookie: 'cookie-value',
  });
});

test('uses empty strings for missing, empty, null, or unsupported values', () => {
  const userInfoPath = writeUserInfo(JSON.stringify({
    user_id: '',
    user_cookie: null,
    object_value: { secret: true },
  }));

  expect(
    updateOutboundHeaderUserInfoCache(
      userInfoPath,
      ['user_id', 'user_cookie', 'missing', 'object_value'],
    ),
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
  expect(resolveOutboundHeaderProxyConfig({
    enabled: true,
    headerNames: [' user_id ', '', 'invalid header', 'bad:header', 'user_cookie'],
    baseUrlWhitelist: ['https://one.example/api/', 'invalid', 'http://two.example/'],
  })).toEqual({
    enabled: true,
    headerNames: ['user_id', 'user_cookie'],
    baseUrlWhitelist: ['https://one.example/api/', 'http://two.example/'],
  });
});

test('configures common Node, Python, and curl proxy environment variables', () => {
  const env: NodeJS.ProcessEnv = {};

  applyOutboundProxyEnv(env, {
    proxyUrl: 'http://127.0.0.1:1234',
    caCertificatePath: '/tmp/ca.pem',
  });

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

test('accepts a dynamic upstream proxy resolver and user info path', () => {
  const resolver = async (targetUrl: string) =>
    targetUrl.startsWith('https://internal.example') ? 'http://system-proxy:8080' : null;

  expect(
    () => new OutboundHeaderProxy(undefined, resolver, 'C:\\AppData\\JustDo\\huawei\\user_info.json'),
  ).not.toThrow();
});
