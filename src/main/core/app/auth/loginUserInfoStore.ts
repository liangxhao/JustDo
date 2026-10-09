import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { AuthProfile } from '../../../../shared/app/auth';
import type { AuthenticatedLogin, CredentialUpdate } from './loginSdkAdapter';

const MAX_FILE_BYTES = 256 * 1024;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const UNSAFE_VALUE = /[\u0000-\u001f\u007f]/;
const RESERVED_HEADERS = new Set([
  'mtoken',
  'x-user-account',
  'x-access-jwt',
  'authorization',
  'username',
  'avatarurl',
  'logintime',
  'cookieexpiresat',
]);

export class LoginStorageError extends Error {
  constructor() {
    super('Unable to persist login state.');
  }
}

export type StoredLogin = Readonly<{
  identity: string;
  credentialVersion: string;
  profile: AuthProfile;
  values: Record<string, unknown>;
}>;

function requiredString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') throw new LoginStorageError();
  const text = value.trim();
  if (!text || text.length > maxLength || UNSAFE_VALUE.test(text)) throw new LoginStorageError();
  return text;
}

function avatarUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function inspect(values: Record<string, unknown>): StoredLogin {
  const mtoken = requiredString(values.mtoken, 32_768);
  const account = requiredString(values['X-User-Account'], 512);
  const displayName =
    typeof values.userName === 'string' && values.userName.trim()
      ? values.userName
          .replace(/[\u0000-\u001f\u007f]/g, ' ')
          .trim()
          .slice(0, 512)
      : account;
  const avatar = avatarUrl(values.avatarUrl);
  return {
    identity: createHash('sha256')
      .update(JSON.stringify([mtoken, account]))
      .digest('hex'),
    credentialVersion: createHash('sha256').update(JSON.stringify(values)).digest('hex'),
    profile: { account, displayName, ...(avatar ? { avatarUrl: avatar } : {}) },
    values,
  };
}

function applyHeaders(
  values: Record<string, unknown>,
  headers?: Readonly<Record<string, string>>,
): void {
  if (!headers) return;
  if (typeof headers !== 'object' || Array.isArray(headers)) throw new LoginStorageError();
  for (const [name, value] of Object.entries(headers)) {
    if (
      !HEADER_NAME.test(name) ||
      RESERVED_HEADERS.has(name.toLowerCase()) ||
      typeof value !== 'string' ||
      UNSAFE_VALUE.test(value)
    )
      throw new LoginStorageError();
    values[name] = value;
  }
}

function applyExpiry(values: Record<string, unknown>, expiry?: number): void {
  if (expiry === undefined) return;
  if (!Number.isSafeInteger(expiry) || expiry <= 0) throw new LoginStorageError();
  values.cookieExpiresAt = expiry;
}

/** Owns atomic writes to the SAME resolved file used by the model exchange and header cache. */
export class LoginUserInfoStore {
  constructor(private readonly filePath: string) {}

  read(): StoredLogin | null {
    try {
      if (fs.statSync(this.filePath).size > MAX_FILE_BYTES) return null;
      const values: unknown = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!values || typeof values !== 'object' || Array.isArray(values)) return null;
      return inspect(values as Record<string, unknown>);
    } catch {
      return null;
    }
  }

  validateLogin(session: AuthenticatedLogin): void {
    const values = this.loginValues(session);
    inspect(values);
    if (Buffer.byteLength(JSON.stringify(values)) > MAX_FILE_BYTES) throw new LoginStorageError();
  }

  writeLogin(session: AuthenticatedLogin): StoredLogin {
    return this.write(this.loginValues(session));
  }

  private loginValues(session: AuthenticatedLogin): Record<string, unknown> {
    const values: Record<string, unknown> = {
      mtoken: requiredString(session.mtoken, 32_768),
      'X-User-Account': requiredString(session.account, 512),
      loginTime: new Date().toISOString(),
    };
    applyHeaders(values, session.headerValues);
    if (session.displayName !== undefined) {
      if (typeof session.displayName !== 'string' || session.displayName.length > 512)
        throw new LoginStorageError();
      values.userName = session.displayName;
    }
    if (session.avatarUrl !== undefined) {
      if (typeof session.avatarUrl !== 'string' || session.avatarUrl.length > 2048)
        throw new LoginStorageError();
      const avatar = avatarUrl(session.avatarUrl);
      if (avatar) values.avatarUrl = avatar;
    }
    applyExpiry(values, session.cookieExpiresAt);
    return values;
  }

  update(current: StoredLogin, update: CredentialUpdate): StoredLogin {
    const values = { ...current.values };
    // JWT is derived by Main, never owned by the login SDK or written back here.
    delete values['X-ACCESS-JWT'];
    if (update.mtoken !== undefined) values.mtoken = requiredString(update.mtoken, 32_768);
    applyHeaders(values, update.headerValues);
    applyExpiry(values, update.cookieExpiresAt);
    return this.write(values);
  }

  clear(): void {
    try {
      fs.rmSync(this.filePath, { force: true });
    } catch {
      throw new LoginStorageError();
    }
  }

  private write(values: Record<string, unknown>): StoredLogin {
    const login = inspect(values);
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      const contents = `${JSON.stringify(values, null, 2)}\n`;
      if (Buffer.byteLength(contents) > MAX_FILE_BYTES) throw new LoginStorageError();
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(temporaryPath, contents, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporaryPath, this.filePath);
      return login;
    } catch {
      throw new LoginStorageError();
    } finally {
      try {
        fs.rmSync(temporaryPath, { force: true });
      } catch {
        /* Preserve the original error. */
      }
    }
  }
}
