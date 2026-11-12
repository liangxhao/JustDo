import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative } from 'node:path';

import { app } from 'electron';

export const BROWSER_AUTHENTICATION_PROFILE_ENV = 'BROWSER_AUTHENTICATION_PROFILE';
export const BROWSER_AUTHENTICATION_PROFILE_PREFIX = 'browser-authentication-';
export const BROWSER_AUTHENTICATION_TIMEOUT_MS = 30_000;

export const BrowserAuthenticationMessage = {
  Ready: 'ready',
  Authenticate: 'authenticate',
  Authenticated: 'authenticated',
} as const;

export function isBrowserAuthenticationMessage(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function browserAuthenticationProfile(): string {
  const value = process.env[BROWSER_AUTHENTICATION_PROFILE_ENV];
  if (!value || !isAbsolute(value)) throw new Error('Invalid browser authentication profile.');
  const profile = realpathSync(value);
  const temp = realpathSync(app.getPath('temp'));
  if (
    relative(temp, dirname(profile)) ||
    !basename(profile).startsWith(BROWSER_AUTHENTICATION_PROFILE_PREFIX) ||
    !statSync(profile).isDirectory()
  )
    throw new Error('Invalid browser authentication profile.');
  return profile;
}
