import fs from 'fs';

export const BUILTIN_MODEL_JWT_FIELD = 'X-ACCESS-JWT';
export const BUILTIN_MODEL_USER_ACCOUNT_FIELD = 'X-User-Account';
export const BUILTIN_MODEL_AUTHORIZATION_PLACEHOLDER = 'access-jwt-auth';
export const EXPECTED_JWT_AUDIENCE = 'justdo-litellm';

const MAX_JWT_LENGTH = 8_192;
const MAX_USER_ACCOUNT_LENGTH = 512;
const DEFAULT_MAX_JWT_LIFETIME_SECONDS = 5 * 60;
const CLOCK_SKEW_SECONDS = 30;
const MIN_REMAINING_LIFETIME_SECONDS = 15;
export const BUILTIN_TOKEN_REFRESH_MARGIN_SECONDS = 60;
const HTTP_HEADER_VALUE_PATTERN = /^[\u0020-\u007e\u0080-\u00ff]+$/;
const BASE64URL_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;
const ALLOWED_JWT_ALGORITHMS = new Set([
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
]);

export type BuiltinModelCredential = Readonly<{
  accessToken: string;
  userAccount: string;
  expiresAt: number;
  authType?: 'jwt' | 'api-key';
}>;

export const BuiltinModelCredentialFailureCode = {
  Account: 'invalid-account',
  TokenFormat: 'invalid-token-format',
  TokenJson: 'invalid-jwt-json',
  LifetimePolicy: 'invalid-lifetime-policy',
  Algorithm: 'unsupported-algorithm',
  Subject: 'missing-subject',
  AccountMismatch: 'account-mismatch',
  Issuer: 'missing-issuer',
  TokenId: 'missing-token-id',
  Audience: 'audience-mismatch',
  Timestamps: 'invalid-timestamps',
  IssuedInFuture: 'issued-in-future',
  LifetimeExceeded: 'lifetime-exceeded',
  Lifetime: 'invalid-lifetime',
  ExpiryTooFar: 'expiry-too-far',
  Expired: 'expired-or-expiring',
  ResponseLifetime: 'expires-in-mismatch',
} as const;

export type BuiltinModelCredentialFailureCode =
  (typeof BuiltinModelCredentialFailureCode)[keyof typeof BuiltinModelCredentialFailureCode];

type CredentialValidationResult =
  | { credential: BuiltinModelCredential; failureCode: null }
  | { credential: null; failureCode: BuiltinModelCredentialFailureCode };

const rejectCredential = (failureCode: BuiltinModelCredentialFailureCode): CredentialValidationResult =>
  ({ credential: null, failureCode });

type JwtHeader = {
  alg?: unknown;
  kid?: unknown;
};

type JwtPayload = {
  aud?: unknown;
  exp?: unknown;
  iat?: unknown;
  iss?: unknown;
  jti?: unknown;
  sub?: unknown;
};

let activeCredential: BuiltinModelCredential | null = null;

const normalizeCredentialValue = (value: unknown, maxLength: number): string => {
  if (typeof value !== 'string') {
    return '';
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || !HTTP_HEADER_VALUE_PATTERN.test(normalized)) {
    return '';
  }
  return normalized;
};

const decodeJwtObject = <T>(segment: string): T | null => {
  if (!BASE64URL_SEGMENT_PATTERN.test(segment)) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
};

/** Classifies local preflight failures without exposing token or identity values. */
export const inspectBuiltinModelCredential = (
  accessTokenValue: unknown,
  userAccountValue: unknown,
  nowSeconds = Math.floor(Date.now() / 1000),
  maxLifetime = DEFAULT_MAX_JWT_LIFETIME_SECONDS,
): CredentialValidationResult => {
  const accessToken = normalizeCredentialValue(accessTokenValue, MAX_JWT_LENGTH);
  const userAccount = normalizeCredentialValue(userAccountValue, MAX_USER_ACCOUNT_LENGTH);
  const segments = accessToken.split('.');
  if (
    segments.length !== 3 ||
    segments.some(segment => !BASE64URL_SEGMENT_PATTERN.test(segment))
  ) {
    return rejectCredential(BuiltinModelCredentialFailureCode.TokenFormat);
  }
  if (!userAccount) return rejectCredential(BuiltinModelCredentialFailureCode.Account);

  const header = decodeJwtObject<JwtHeader>(segments[0]);
  const payload = decodeJwtObject<JwtPayload>(segments[1]);
  if (!header || !payload) {
    return rejectCredential(BuiltinModelCredentialFailureCode.TokenJson);
  }

  const algorithm = typeof header.alg === 'string' ? header.alg : '';
  const subject = typeof payload.sub === 'string' ? payload.sub.trim() : '';
  const issuer = typeof payload.iss === 'string' ? payload.iss.trim() : '';
  const tokenId = typeof payload.jti === 'string' ? payload.jti.trim() : '';
  const issuedAt = payload.iat;
  const expiresAt = payload.exp;

  if (!Number.isInteger(maxLifetime) || maxLifetime < 30 || maxLifetime > 10_800) {
    return rejectCredential(BuiltinModelCredentialFailureCode.LifetimePolicy);
  }
  if (!ALLOWED_JWT_ALGORITHMS.has(algorithm)) return rejectCredential(BuiltinModelCredentialFailureCode.Algorithm);
  if (!subject) return rejectCredential(BuiltinModelCredentialFailureCode.Subject);
  if (subject !== userAccount) return rejectCredential(BuiltinModelCredentialFailureCode.AccountMismatch);
  if (!issuer) return rejectCredential(BuiltinModelCredentialFailureCode.Issuer);
  if (!tokenId) return rejectCredential(BuiltinModelCredentialFailureCode.TokenId);
  if (payload.aud !== EXPECTED_JWT_AUDIENCE) return rejectCredential(BuiltinModelCredentialFailureCode.Audience);
  if (
    typeof issuedAt !== 'number' ||
    !Number.isInteger(issuedAt) ||
    typeof expiresAt !== 'number' ||
    !Number.isInteger(expiresAt)
  ) {
    return rejectCredential(BuiltinModelCredentialFailureCode.Timestamps);
  }
  if (issuedAt > nowSeconds + CLOCK_SKEW_SECONDS) return rejectCredential(BuiltinModelCredentialFailureCode.IssuedInFuture);
  if (expiresAt - issuedAt > maxLifetime) return rejectCredential(BuiltinModelCredentialFailureCode.LifetimeExceeded);
  if (expiresAt - issuedAt <= 0) return rejectCredential(BuiltinModelCredentialFailureCode.Lifetime);
  if (expiresAt > nowSeconds + maxLifetime) return rejectCredential(BuiltinModelCredentialFailureCode.ExpiryTooFar);
  if (expiresAt < nowSeconds + MIN_REMAINING_LIFETIME_SECONDS) return rejectCredential(BuiltinModelCredentialFailureCode.Expired);

  return { credential: Object.freeze({ accessToken, userAccount, expiresAt }), failureCode: null };
};

export const validateBuiltinModelCredential = (
  accessTokenValue: unknown,
  userAccountValue: unknown,
  nowSeconds = Math.floor(Date.now() / 1000),
  maxLifetime = DEFAULT_MAX_JWT_LIFETIME_SECONDS,
): BuiltinModelCredential | null =>
  inspectBuiltinModelCredential(accessTokenValue, userAccountValue, nowSeconds, maxLifetime).credential;

export const readBuiltinModelCredential = (userInfoPath: string): BuiltinModelCredential | null => {
  let userInfo: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(userInfoPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    userInfo = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  return validateBuiltinModelCredential(
    userInfo[BUILTIN_MODEL_JWT_FIELD],
    userInfo[BUILTIN_MODEL_USER_ACCOUNT_FIELD],
  );
};

export const setActiveBuiltinModelCredential = (
  credential: BuiltinModelCredential | null,
  maxLifetime = DEFAULT_MAX_JWT_LIFETIME_SECONDS,
): void => {
  activeCredential = credential
    ? validateBuiltinModelCredential(credential.accessToken, credential.userAccount, undefined, maxLifetime)
    : null;
};

export const setActiveBuiltinModelDevelopmentApiKey = (
  apiKeyValue: unknown,
): BuiltinModelCredential | null => {
  const apiKey = normalizeCredentialValue(apiKeyValue, MAX_JWT_LENGTH);
  activeCredential = apiKey
    ? Object.freeze({
        accessToken: apiKey,
        userAccount: '',
        expiresAt: Number.MAX_SAFE_INTEGER,
        authType: 'api-key' as const,
      })
    : null;
  return activeCredential;
};

export const refreshActiveBuiltinModelCredential = (
  userInfoPath: string,
): BuiltinModelCredential | null => {
  const credential = readBuiltinModelCredential(userInfoPath);
  setActiveBuiltinModelCredential(credential);
  return credential;
};

export const getActiveBuiltinModelCredential = (): BuiltinModelCredential | null => {
  if (
    activeCredential &&
    activeCredential.expiresAt < Math.floor(Date.now() / 1000) + MIN_REMAINING_LIFETIME_SECONDS
  ) {
    activeCredential = null;
  }
  return activeCredential;
};

/** Short-lived tokens renew halfway through their signed lifetime, not every second. */
export const getBuiltinModelCredentialRefreshAtSeconds = (credential: BuiltinModelCredential): number => {
  if (credential.authType === 'api-key') return Number.MAX_SAFE_INTEGER;
  const payload = decodeJwtObject<JwtPayload>(credential.accessToken.split('.')[1] ?? '');
  const lifetime = typeof payload?.iat === 'number' && Number.isInteger(payload.iat)
    ? credential.expiresAt - payload.iat : NaN;
  const margin = Number.isFinite(lifetime) && lifetime > 0
    ? Math.min(BUILTIN_TOKEN_REFRESH_MARGIN_SECONDS, Math.max(MIN_REMAINING_LIFETIME_SECONDS, lifetime / 2))
    : BUILTIN_TOKEN_REFRESH_MARGIN_SECONDS;
  return credential.expiresAt - margin;
};

export const buildBuiltinModelRequestHeaders = (
  credential: BuiltinModelCredential,
): Record<string, string> => credential.authType === 'api-key'
  ? { Authorization: `Bearer ${credential.accessToken}` }
  : {
      Authorization: `Bearer ${credential.accessToken}`,
      [BUILTIN_MODEL_JWT_FIELD]: credential.accessToken,
      [BUILTIN_MODEL_USER_ACCOUNT_FIELD]: credential.userAccount,
    };

export const isActiveBuiltinModelDevelopmentApiKey = (): boolean =>
  activeCredential?.authType === 'api-key';

export const getBuiltinModelRequestHeaders = (): Record<string, string> | null => {
  const credential = getActiveBuiltinModelCredential();
  if (!credential) {
    return null;
  }
  return buildBuiltinModelRequestHeaders(credential);
};

export const clearActiveBuiltinModelCredential = (): void => {
  activeCredential = null;
};
