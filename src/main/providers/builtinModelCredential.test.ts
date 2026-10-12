import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  buildBuiltinModelRequestHeaders,
  BUILTIN_MODEL_JWT_FIELD,
  BUILTIN_MODEL_USER_ACCOUNT_FIELD,
  BuiltinModelCredentialFailureCode,
  clearActiveBuiltinModelCredential,
  getActiveBuiltinModelCredential,
  inspectBuiltinModelCredential,
  readBuiltinModelCredential,
  refreshActiveBuiltinModelCredential,
  setActiveBuiltinModelCredential,
  setActiveBuiltinModelDevelopmentApiKey,
  validateBuiltinModelCredential,
} from './builtinModelCredential';

const NOW_SECONDS = 2_000_000_000;
const temporaryDirectories: string[] = [];

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

const writeUserInfo = (value: unknown): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-builtin-credential-'));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, 'user_info.json');
  fs.writeFileSync(filePath, JSON.stringify(value), 'utf8');
  return filePath;
};

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
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
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
    { overrides: { iat: NOW_SECONDS + 30, exp: NOW_SECONDS + 330 }, code: BuiltinModelCredentialFailureCode.ExpiryTooFar },
    { overrides: { exp: NOW_SECONDS + 14 }, code: BuiltinModelCredentialFailureCode.Expired },
  ])('classifies local credential rejection without returning claims: $code', ({ overrides, code }) => {
    const token = createJwt('user-123', overrides);
    expect(inspectBuiltinModelCredential(token, 'user-123')).toEqual({ credential: null, failureCode: code });
    expect(validateBuiltinModelCredential(token, 'user-123')).toBeNull();
  });

  test('classifies invalid token encoding, account, algorithm and lifetime policy', () => {
    const token = createJwt();
    expect(inspectBuiltinModelCredential('not-a-jwt', 'user-123').failureCode).toBe(BuiltinModelCredentialFailureCode.TokenFormat);
    expect(inspectBuiltinModelCredential('bm90LWpzb24.e30.signature', 'user-123').failureCode).toBe(BuiltinModelCredentialFailureCode.TokenJson);
    expect(inspectBuiltinModelCredential(token, '').failureCode).toBe(BuiltinModelCredentialFailureCode.Account);
    expect(inspectBuiltinModelCredential(createJwt('user-123', {}, { alg: 'HS256' }), 'user-123').failureCode).toBe(BuiltinModelCredentialFailureCode.Algorithm);
    expect(inspectBuiltinModelCredential(token, 'user-123', NOW_SECONDS, 10_801).failureCode).toBe(BuiltinModelCredentialFailureCode.LifetimePolicy);
    expect(inspectBuiltinModelCredential(token, 'user-123')).toEqual({
      credential: { accessToken: token, userAccount: 'user-123', expiresAt: NOW_SECONDS + 300 }, failureCode: null,
    });
  });

  test('accepts the intranet RS256 JWT without a key id', () => {
    const accessToken = createJwt('user-123', { name: 'Fixture User' }, { kid: undefined, typ: 'JWT' });
    expect(validateBuiltinModelCredential(accessToken, 'user-123')).toEqual({
      accessToken, userAccount: 'user-123', expiresAt: NOW_SECONDS + 300,
    });
  });

  test.each([undefined, '', 'litellm', 'LiteLLM', ' justdo-litellm ', ['justdo-litellm'], 123])(
    'rejects a missing, mismatched, or unsupported audience: %j', aud => {
      expect(validateBuiltinModelCredential(createJwt('user-123', { aud }), 'user-123')).toBeNull();
    },
  );

  test('accepts a three-hour JWT only with the explicit deployment lifetime policy', () => {
    const accessToken = createJwt('user-123', { exp: NOW_SECONDS + 10_800 }, { kid: undefined });
    expect(validateBuiltinModelCredential(accessToken, 'user-123')).toBeNull();
    expect(validateBuiltinModelCredential(accessToken, 'user-123', NOW_SECONDS, 10_800)).toEqual({
      accessToken, userAccount: 'user-123', expiresAt: NOW_SECONDS + 10_800,
    });
  });

  test('reads a short-lived JWT whose subject matches the account header', () => {
    const accessToken = createJwt();
    const userInfoPath = writeUserInfo({
      [BUILTIN_MODEL_JWT_FIELD]: `  ${accessToken}  `,
      [BUILTIN_MODEL_USER_ACCOUNT_FIELD]: '  user-123  ',
      'X-Cookie': 'unrelated-login-cookie',
    });

    expect(readBuiltinModelCredential(userInfoPath)).toEqual({
      accessToken,
      userAccount: 'user-123',
      expiresAt: NOW_SECONDS + 300,
    });
  });

  test.each([
    [{ [BUILTIN_MODEL_USER_ACCOUNT_FIELD]: 'user-123' }],
    [{ [BUILTIN_MODEL_JWT_FIELD]: createJwt() }],
    [
      {
        [BUILTIN_MODEL_JWT_FIELD]: createJwt(),
        [BUILTIN_MODEL_USER_ACCOUNT_FIELD]: 'other-user',
      },
    ],
    [
      {
        [BUILTIN_MODEL_JWT_FIELD]: createJwt('user-123', { exp: NOW_SECONDS + 301 }),
        [BUILTIN_MODEL_USER_ACCOUNT_FIELD]: 'user-123',
      },
    ],
    [
      {
        [BUILTIN_MODEL_JWT_FIELD]: createJwt('user-123', {
          iat: NOW_SECONDS + 30,
          exp: NOW_SECONDS + 330,
        }),
        [BUILTIN_MODEL_USER_ACCOUNT_FIELD]: 'user-123',
      },
    ],
    [
      {
        [BUILTIN_MODEL_JWT_FIELD]: createJwt('user-123', { exp: NOW_SECONDS + 14 }),
        [BUILTIN_MODEL_USER_ACCOUNT_FIELD]: 'user-123',
      },
    ],
    [
      {
        [BUILTIN_MODEL_JWT_FIELD]: createJwt('user-123', { jti: '' }),
        [BUILTIN_MODEL_USER_ACCOUNT_FIELD]: 'user-123',
      },
    ],
    [
      {
        [BUILTIN_MODEL_JWT_FIELD]: createJwt('user-123', {}, { alg: 'HS256' }),
        [BUILTIN_MODEL_USER_ACCOUNT_FIELD]: 'user-123',
      },
    ],
    [
      {
        [BUILTIN_MODEL_JWT_FIELD]: createJwt().replace('.', '.\r\n'),
        [BUILTIN_MODEL_USER_ACCOUNT_FIELD]: 'user-123',
      },
    ],
    [{ 'X-Cookie': createJwt(), [BUILTIN_MODEL_USER_ACCOUNT_FIELD]: 'user-123' }],
  ])('fails closed for incomplete, unsafe, or overlong credentials: %j', userInfo => {
    expect(readBuiltinModelCredential(writeUserInfo(userInfo))).toBeNull();
  });

  test('fails closed when the user info file is missing or malformed', () => {
    expect(readBuiltinModelCredential(path.join(os.tmpdir(), 'missing-user-info.json'))).toBeNull();
    expect(readBuiltinModelCredential(writeUserInfo('not-an-object'))).toBeNull();
  });

  test('keeps the active JWT only in process memory and clears it near expiry', () => {
    const accessToken = createJwt();
    setActiveBuiltinModelCredential({
      accessToken,
      userAccount: 'user-123',
      expiresAt: NOW_SECONDS + 300,
    });

    expect(getActiveBuiltinModelCredential()).toEqual({
      accessToken,
      userAccount: 'user-123',
      expiresAt: NOW_SECONDS + 300,
    });

    vi.setSystemTime((NOW_SECONDS + 286) * 1_000);
    expect(getActiveBuiltinModelCredential()).toBeNull();
  });

  test('builds a real JWT bearer authorization and the deployment headers', () => {
    const accessToken = createJwt();
    expect(
      buildBuiltinModelRequestHeaders({
        accessToken,
        userAccount: 'user-123',
        expiresAt: NOW_SECONDS + 300,
      }),
    ).toEqual({
      Authorization: `Bearer ${accessToken}`,
      [BUILTIN_MODEL_JWT_FIELD]: accessToken,
      [BUILTIN_MODEL_USER_ACCOUNT_FIELD]: 'user-123',
    });
  });

  test('refreshes the in-memory credential from the login handoff file', () => {
    const accessToken = createJwt();
    const userInfoPath = writeUserInfo({
      [BUILTIN_MODEL_JWT_FIELD]: accessToken,
      [BUILTIN_MODEL_USER_ACCOUNT_FIELD]: 'user-123',
      'X-Cookie': 'unrelated-login-cookie',
    });

    const expected = {
      accessToken,
      userAccount: 'user-123',
      expiresAt: NOW_SECONDS + 300,
    };
    expect(refreshActiveBuiltinModelCredential(userInfoPath)).toEqual(expected);
    expect(getActiveBuiltinModelCredential()).toEqual(expected);
  });
});
