import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  buildBuiltinModelRequestHeaders,
  BUILTIN_MODEL_JWT_FIELD,
  BUILTIN_MODEL_USER_ACCOUNT_FIELD,
  BuiltinModelCredentialFailureCode,
  clearActiveBuiltinModelCredential,
  getActiveBuiltinModelCredential,
  getActiveBuiltinModelCredentialSessionId,
  inspectBuiltinModelCredential,
  setActiveBuiltinModelCredential,
  setActiveBuiltinModelDevelopmentApiKey,
} from './builtinModelCredential';

const NOW_SECONDS = 2_000_000_000;

const encodeJwtPart = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

const createJwt = (
  userAccount = 'user-123',
  overrides: Record<string, unknown> = {},
  headerOverrides: Record<string, unknown> = {},
): string =>
  [
    encodeJwtPart({ alg: 'RS256', kid: 'login-key-1', ...headerOverrides }),
    encodeJwtPart({
      iss: 'https://login.example.test',
      aud: 'justdo-litellm',
      sub: userAccount,
      iat: NOW_SECONDS,
      exp: NOW_SECONDS + 300,
      jti: 'token-1',
      ...overrides,
    }),
    'test-signature',
  ].join('.');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_SECONDS * 1_000);
});

test('builds only a bearer authorization header for a development API key', () => {
  const credential = setActiveBuiltinModelDevelopmentApiKey('sk-development');
  expect(credential).not.toBeNull();
  expect(buildBuiltinModelRequestHeaders(credential!)).toEqual({
    Authorization: 'Bearer sk-development',
  });
});

afterEach(() => {
  clearActiveBuiltinModelCredential();
  vi.useRealTimers();
});

describe('built-in model credential', () => {
  test.each([
    { overrides: { aud: 'model-service' }, code: BuiltinModelCredentialFailureCode.Audience },
    { overrides: { aud: ['justdo-litellm'] }, code: BuiltinModelCredentialFailureCode.Audience },
    { overrides: { sub: 'other-user' }, code: BuiltinModelCredentialFailureCode.AccountMismatch },
    { overrides: { sub: '' }, code: BuiltinModelCredentialFailureCode.Subject },
    { overrides: { iss: '' }, code: BuiltinModelCredentialFailureCode.Issuer },
    { overrides: { jti: '' }, code: BuiltinModelCredentialFailureCode.TokenId },
    { overrides: { iat: String(NOW_SECONDS) }, code: BuiltinModelCredentialFailureCode.Timestamps },
    { overrides: { iat: NOW_SECONDS + 31 }, code: BuiltinModelCredentialFailureCode.IssuedInFuture },
    { overrides: { exp: NOW_SECONDS + 301 }, code: BuiltinModelCredentialFailureCode.LifetimeExceeded },
    { overrides: { exp: NOW_SECONDS }, code: BuiltinModelCredentialFailureCode.Lifetime },
    { overrides: { iat: NOW_SECONDS + 30, exp: NOW_SECONDS + 331 }, code: BuiltinModelCredentialFailureCode.LifetimeExceeded },
    { overrides: { iat: NOW_SECONDS - 300, exp: NOW_SECONDS - 1 }, code: BuiltinModelCredentialFailureCode.Expired },
    { overrides: { exp: NOW_SECONDS + 14 }, code: BuiltinModelCredentialFailureCode.Expired },
  ])('classifies local credential rejection without returning claims: $code', ({ overrides, code }) => {
    const token = createJwt('user-123', overrides);
    expect(inspectBuiltinModelCredential(token, 'user-123')).toEqual({ credential: null, failureCode: code });
  });

  test('classifies invalid token encoding, account, algorithm and lifetime policy', () => {
    const token = createJwt();
    expect(inspectBuiltinModelCredential('not-a-jwt', 'user-123').failureCode).toBe(BuiltinModelCredentialFailureCode.TokenFormat);
    expect(inspectBuiltinModelCredential(token.replace('.', '.\r\n'), 'user-123').failureCode).toBe(BuiltinModelCredentialFailureCode.TokenFormat);
    expect(inspectBuiltinModelCredential('bm90LWpzb24.e30.signature', 'user-123').failureCode).toBe(BuiltinModelCredentialFailureCode.TokenJson);
    expect(inspectBuiltinModelCredential(token, '').failureCode).toBe(BuiltinModelCredentialFailureCode.Account);
    expect(inspectBuiltinModelCredential(createJwt('user-123', {}, { alg: 'HS256' }), 'user-123').failureCode).toBe(BuiltinModelCredentialFailureCode.Algorithm);
    expect(inspectBuiltinModelCredential(token, 'user-123', NOW_SECONDS, 10_801).failureCode).toBe(BuiltinModelCredentialFailureCode.LifetimePolicy);
    expect(inspectBuiltinModelCredential(token, 'user-123')).toEqual({
      credential: {
        authType: 'jwt', accessToken: token, userAccount: 'user-123', issuedAt: NOW_SECONDS, expiresAt: NOW_SECONDS + 300,
      },
      failureCode: null,
    });
  });

  test('accepts the intranet RS256 JWT without a key id', () => {
    const accessToken = createJwt('user-123', { name: 'Fixture User' }, { kid: undefined, typ: 'JWT' });
    expect(inspectBuiltinModelCredential(accessToken, 'user-123').credential).toEqual({
      authType: 'jwt', accessToken, userAccount: 'user-123', issuedAt: NOW_SECONDS, expiresAt: NOW_SECONDS + 300,
    });
  });

  test.each([undefined, '', 'litellm', 'LiteLLM', ' justdo-litellm ', ['justdo-litellm'], 123])(
    'rejects a missing, mismatched, or unsupported audience: %j', aud => {
      expect(inspectBuiltinModelCredential(createJwt('user-123', { aud }), 'user-123').credential).toBeNull();
    },
  );

  test('accepts a three-hour JWT only with the explicit deployment lifetime policy', () => {
    const accessToken = createJwt('user-123', { exp: NOW_SECONDS + 10_800 }, { kid: undefined });
    expect(inspectBuiltinModelCredential(accessToken, 'user-123').credential).toBeNull();
    expect(inspectBuiltinModelCredential(accessToken, 'user-123', NOW_SECONDS, 10_800).credential).toEqual({
      authType: 'jwt', accessToken, userAccount: 'user-123', issuedAt: NOW_SECONDS, expiresAt: NOW_SECONDS + 10_800,
    });
  });

  test.each([1, 30])('accepts a maximum-lifetime JWT when the issuer clock is %i seconds ahead', clockSkewSeconds => {
    const accessToken = createJwt('user-123', {
      iat: NOW_SECONDS + clockSkewSeconds,
      exp: NOW_SECONDS + clockSkewSeconds + 10_800,
    });
    const { credential } = inspectBuiltinModelCredential(accessToken, 'user-123', NOW_SECONDS, 10_800);
    expect(credential).toMatchObject({
      issuedAt: NOW_SECONDS + clockSkewSeconds,
      expiresAt: NOW_SECONDS + clockSkewSeconds + 10_800,
    });
    setActiveBuiltinModelCredential(credential!);
    expect(getActiveBuiltinModelCredential()).toBe(credential);
  });

  test('keeps the active JWT only in process memory and clears it near expiry', () => {
    const accessToken = createJwt();
    const { credential } = inspectBuiltinModelCredential(accessToken, 'user-123');
    setActiveBuiltinModelCredential(credential!);
    expect(getActiveBuiltinModelCredential()).toBe(credential);

    vi.setSystemTime((NOW_SECONDS + 285) * 1_000 - 1);
    expect(getActiveBuiltinModelCredential()).not.toBeNull();
    vi.setSystemTime((NOW_SECONDS + 285) * 1_000);
    expect(getActiveBuiltinModelCredential()).toBeNull();
  });

  test('rejects a validated credential if it crosses the request cutoff before installation', () => {
    const { credential } = inspectBuiltinModelCredential(createJwt(), 'user-123');
    vi.setSystemTime((NOW_SECONDS + 285) * 1000);

    expect(setActiveBuiltinModelCredential(credential!)).toBeNull();
    expect(getActiveBuiltinModelCredentialSessionId()).toBeNull();
  });

  test('builds a real JWT bearer authorization and the deployment headers', () => {
    const accessToken = createJwt();
    expect(
      buildBuiltinModelRequestHeaders(inspectBuiltinModelCredential(`  ${accessToken}  `, '  user-123  ').credential!),
    ).toEqual({
      Authorization: `Bearer ${accessToken}`,
      [BUILTIN_MODEL_JWT_FIELD]: accessToken,
      [BUILTIN_MODEL_USER_ACCOUNT_FIELD]: 'user-123',
    });
  });

  test('retains the login session across renewal and temporary expiry, but revokes it on logout', () => {
    const publish = () => {
      const now = Math.floor(Date.now() / 1000);
      const accessToken = createJwt('user-123', { iat: now, exp: now + 300 });
      setActiveBuiltinModelCredential(inspectBuiltinModelCredential(accessToken, 'user-123').credential!);
    };
    publish();
    const session = getActiveBuiltinModelCredentialSessionId();
    expect(session).toMatch(/^[a-f0-9]{32}$/);
    vi.setSystemTime((NOW_SECONDS + 240) * 1000);
    publish();
    expect(getActiveBuiltinModelCredentialSessionId()).toBe(session);
    vi.setSystemTime((NOW_SECONDS + 600) * 1000);
    expect(getActiveBuiltinModelCredentialSessionId()).toBeNull();
    publish();
    expect(getActiveBuiltinModelCredentialSessionId()).toBe(session);
    clearActiveBuiltinModelCredential();
    publish();
    expect(getActiveBuiltinModelCredentialSessionId()).not.toBe(session);
  });
});
