import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { clearActiveBuiltinModelCredential, getActiveBuiltinModelCredential } from './builtinModelCredential';
import { resolveBuiltinModelCredentialExpiryDelayMs } from './builtinModelCredentialMonitor';
import { BuiltinModelTokenExchange, getOrCreateBuiltinModelDeviceId } from './builtinModelTokenExchange';

const NOW = 2_000_000_000;
let directory: string;
let config = {
  tokenExchangeUrl: 'https://issuer.test/api/litellm/mtoken2jwt',
  maxJwtLifetimeSeconds: 300,
  developmentAuthMode: 'jwt' as const,
  developmentApiKey: '',
};
const jwt = (account = 'user-1', seconds = 300) => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return [encode({ alg: 'RS256', kid: 'fixture' }), encode({
    iss: 'https://issuer.test', aud: 'litellm', sub: account, iat: now, exp: now + seconds, jti: `fixture-${now}`,
  }), 'signature'].join('.');
};
const login = (account = 'user-1', mtoken = 'mtoken-fixture') => {
  fs.writeFileSync(path.join(directory, 'user_info.json'), JSON.stringify({
    mtoken, 'X-User-Account': account, 'X-Cookie': 'cookie-fixture',
  }));
};
const success = (overrides: Record<string, unknown> = {}) => new Response(JSON.stringify({
  access_token: jwt(), token_type: 'Bearer', expires_in: 300, uid: 'user-1', ...overrides,
}));
const setup = (fetch = vi.fn(async () => success())) => ({
  fetch,
  service: new BuiltinModelTokenExchange({
    userInfoPath: path.join(directory, 'user_info.json'),
    deviceIdPath: path.join(directory, 'model-device.json'),
    getConfig: () => ({ ...config }),
    fetch,
  }),
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1000);
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-exchange-'));
  clearActiveBuiltinModelCredential();
  config = {
    tokenExchangeUrl: 'https://issuer.test/api/litellm/mtoken2jwt',
    maxJwtLifetimeSeconds: 300,
    developmentAuthMode: 'jwt',
    developmentApiKey: '',
  };
});

test('uses a development API key without login or token exchange', async () => {
  const fetch = vi.fn(async () => success());
  const service = new BuiltinModelTokenExchange({
    userInfoPath: path.join(directory, 'missing-user_info.json'),
    deviceIdPath: path.join(directory, 'model-device.json'),
    getConfig: () => ({ ...config }),
    getDevelopmentApiKey: () => 'sk-development',
    fetch,
  });
  const credential = await service.refresh();
  expect(credential).toMatchObject({
    accessToken: 'sk-development',
    userAccount: '',
    authType: 'api-key',
  });
  expect(fetch).not.toHaveBeenCalled();
});
afterEach(() => {
  clearActiveBuiltinModelCredential();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('exchanges only mtoken and a stable device ID without changing the login file', async () => {
  login();
  const original = fs.readFileSync(path.join(directory, 'user_info.json'), 'utf8');
  const { service, fetch } = setup();
  expect((await service.refresh())?.userAccount).toBe('user-1');
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('https://issuer.test/api/litellm/mtoken2jwt');
  expect(init.redirect).toBe('error');
  expect(JSON.parse(String(init.body))).toEqual({
    mtoken: 'mtoken-fixture', deviceId: getOrCreateBuiltinModelDeviceId(path.join(directory, 'model-device.json')),
  });
  expect(JSON.stringify(init)).not.toContain('cookie-fixture');
  expect(fs.readFileSync(path.join(directory, 'user_info.json'), 'utf8')).toBe(original);
  await service.refresh();
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('coalesces concurrent exchanges and renews before expiration', async () => {
  login();
  const { service, fetch } = setup();
  await Promise.all([service.refresh(), service.refresh(), service.refresh()]);
  expect(fetch).toHaveBeenCalledTimes(1);
  vi.setSystemTime((NOW + 241) * 1000);
  expect((await service.refresh())?.expiresAt).toBe(NOW + 541);
  expect(fetch).toHaveBeenCalledTimes(2);
});

test.each([30, 60, 90, 300, 900, 10_800])('uses the same bounded refresh deadline for %i-second JWTs', async seconds => {
  login();
  config.maxJwtLifetimeSeconds = seconds;
  const { service, fetch } = setup(vi.fn(async () => success({
    access_token: jwt('user-1', seconds), expires_in: seconds,
  })));
  const active = await service.refresh();
  expect(active).not.toBeNull();
  const delay = (seconds - Math.min(60, seconds / 2)) * 1000;
  expect(resolveBuiltinModelCredentialExpiryDelayMs(active!)).toBe(delay);
  vi.setSystemTime(NOW * 1000 + delay - 1000);
  await service.refresh();
  expect(fetch).toHaveBeenCalledTimes(1);
  vi.setSystemTime(NOW * 1000 + delay);
  await service.refresh();
  expect(fetch).toHaveBeenCalledTimes(2);
});

test.each([
  { uid: 'other-user' }, { access_token: 'pqAk' }, { token_type: 'Basic' },
  { expires_in: 0 }, { expires_in: 30 }, { access_token: jwt('other-user') },
])('rejects an inconsistent or invalid token response', async overrides => {
  login();
  const { service } = setup(vi.fn(async () => success(overrides)));
  await expect(service.refresh()).rejects.toThrow('Model authentication token exchange failed.');
  expect(getActiveBuiltinModelCredential()).toBeNull();
});

test('discards a late exchange response after the login file switches accounts', async () => {
  login();
  let resolve!: (response: Response) => void;
  const { service } = setup(vi.fn(() => new Promise<Response>(next => { resolve = next; })));
  const request = service.refresh();
  login('user-2', 'other-mtoken');
  resolve(success());
  expect(await request).toBeNull();
  expect(getActiveBuiltinModelCredential()).toBeNull();
});

test('keeps a still-valid JWT during a temporary outage but clears it before expiration', async () => {
  login();
  const { service, fetch } = setup();
  await service.refresh();
  fetch.mockRejectedValue(new Error('mtoken-fixture must not leak'));
  vi.setSystemTime((NOW + 241) * 1000);
  await expect(service.refresh()).rejects.toThrow('Model authentication token exchange failed.');
  expect(getActiveBuiltinModelCredential()).not.toBeNull();
  vi.setSystemTime((NOW + 286) * 1000);
  await expect(service.refresh()).rejects.toThrow('Model authentication token exchange failed.');
  expect(getActiveBuiltinModelCredential()).toBeNull();
});

test('revokes on rejected mtoken and does not leak the server response', async () => {
  login();
  const { service, fetch } = setup();
  await service.refresh();
  vi.setSystemTime((NOW + 241) * 1000);
  fetch.mockResolvedValue(new Response('mtoken-fixture cookie-fixture', { status: 401 }));
  await expect(service.refresh()).rejects.toThrow('Model authentication token exchange failed.');
  expect(getActiveBuiltinModelCredential()).toBeNull();
});

test('explicit logout prevents retry from reauthorizing the unchanged login file', async () => {
  login();
  const { service, fetch } = setup();
  await service.refresh();
  service.suspend();
  expect(await service.refresh()).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
  service.resume();
  expect(await service.refresh()).not.toBeNull();
  expect(fetch).toHaveBeenCalledTimes(2);
});

test('does not exchange an unrelated cookie when mtoken is missing', async () => {
  login('user-1', '');
  const { service, fetch } = setup();
  expect(await service.refresh()).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

test.each([900, 10_800])('accepts the documented %i-second response only with a matching explicit lifetime policy', async seconds => {
  login();
  const { service } = setup(vi.fn(async () => success({ access_token: jwt('user-1', seconds), expires_in: seconds })));
  await expect(service.refresh()).rejects.toThrow('Model authentication token exchange failed.');
  config.maxJwtLifetimeSeconds = seconds;
  expect((await service.refresh())?.expiresAt).toBe(NOW + seconds);
});

test('changing the endpoint invalidates a cached credential immediately on refresh', async () => {
  login();
  const { service, fetch } = setup();
  await service.refresh();
  config.tokenExchangeUrl = 'https://new-issuer.test/api/litellm/mtoken2jwt';
  await service.refresh();
  expect(fetch).toHaveBeenCalledTimes(2);
  config.tokenExchangeUrl = '';
  expect(await service.refresh()).toBeNull();
  expect(getActiveBuiltinModelCredential()).toBeNull();
});

test('discards an in-flight response after configuration changes', async () => {
  login();
  let resolve!: (response: Response) => void;
  const { service } = setup(vi.fn(() => new Promise<Response>(next => { resolve = next; })));
  const pending = service.refresh();
  config.maxJwtLifetimeSeconds = 900;
  resolve(success());
  expect(await pending).toBeNull();
  expect(getActiveBuiltinModelCredential()).toBeNull();
});
