import type { BrowserWindow } from 'electron';

import type { AuthProfile } from '../../../../shared/app/auth';

/** Main-only result, returned AFTER the SDK has verified the identity. */
export type AuthenticatedLogin = Readonly<{
  account: string;
  mtoken: string;
  displayName?: string;
  avatarUrl?: string;
  headerValues?: Readonly<Record<string, string>>;
  cookieExpiresAt?: number;
}>;

export const LoginSdkStatus = {
  Authenticated: 'authenticated',
  Canceled: 'canceled',
} as const;

export type LoginSdkResult =
  | { status: typeof LoginSdkStatus.Authenticated; session: AuthenticatedLogin }
  | { status: typeof LoginSdkStatus.Canceled };

export type CredentialUpdate = Readonly<{
  mtoken?: string;
  headerValues?: Readonly<Record<string, string>>;
  cookieExpiresAt?: number;
}>;

export interface LoginSdkAdapter {
  readonly available: boolean;
  /** Own the SDK popup; abort must close it and remove its listeners. */
  login: (options: { signal: AbortSignal }) => Promise<LoginSdkResult>;
  /** Optional SDK session restoration; must verify, not infer login from file presence. */
  restoreSession?: (options: { signal: AbortSignal; profile: AuthProfile }) => Promise<boolean>;
  logout?: (options: { signal: AbortSignal }) => Promise<void>;
  /** Future renewal coordinator uses expiry metadata, never a fixed half-day interval. */
  refreshCredentials?: (options: { signal: AbortSignal }) => Promise<CredentialUpdate>;
  /** Remove session listeners and stop SDK-owned renewal when the app shuts down. */
  dispose?: () => void;
}

/** Replace this factory with the real SDK adapter; no simulated production login. */
export function createLoginSdkAdapter(_context: {
  getParentWindow: () => BrowserWindow | null;
}): LoginSdkAdapter {
  return {
    available: false,
    login: async () => {
      throw new Error('Login SDK is unavailable.');
    },
  };
}
