export const AuthIpc = {
  GetState: 'auth:getState',
  Login: 'auth:login',
  Logout: 'auth:logout',
  RetrySync: 'auth:retrySync',
  StateChanged: 'auth:stateChanged',
} as const;

export const AuthStatus = {
  SignedOut: 'signed-out',
  SignedIn: 'signed-in',
  LocalCredentials: 'local-credentials',
} as const;

export const AuthOperation = {
  Idle: 'idle',
  Login: 'login',
  Logout: 'logout',
  Sync: 'sync',
} as const;

export const AuthSyncStatus = {
  Idle: 'idle',
  Pending: 'pending',
  Completed: 'completed',
  Failed: 'failed',
} as const;

export const AuthErrorCode = {
  SdkUnavailable: 'sdk-unavailable',
  LoginFailed: 'login-failed',
  StorageFailed: 'storage-failed',
  SyncFailed: 'sync-failed',
  LogoutFailed: 'logout-failed',
  SessionChanged: 'session-changed',
  Unavailable: 'unavailable',
} as const;

export type AuthErrorCode = (typeof AuthErrorCode)[keyof typeof AuthErrorCode];

/** Display-only projection. Login material and header values never cross IPC. */
export type AuthProfile = Readonly<{
  account: string;
  displayName: string;
  avatarUrl?: string;
}>;

export type AuthState = Readonly<{
  revision: number;
  sdkAvailable: boolean;
  status: (typeof AuthStatus)[keyof typeof AuthStatus];
  operation: (typeof AuthOperation)[keyof typeof AuthOperation];
  syncStatus: (typeof AuthSyncStatus)[keyof typeof AuthSyncStatus];
  profile: AuthProfile | null;
  errorCode: AuthErrorCode | null;
}>;

export type AuthActionResult = Readonly<{
  success: boolean;
  canceled?: boolean;
  errorCode?: AuthErrorCode;
  state: AuthState;
}>;

export interface AuthApi {
  getState: () => Promise<AuthState>;
  login: () => Promise<AuthActionResult>;
  logout: () => Promise<AuthActionResult>;
  retrySync: () => Promise<AuthActionResult>;
  onStateChanged: (callback: (state: AuthState) => void) => () => void;
}

export const INITIAL_AUTH_STATE: AuthState = {
  revision: 0,
  sdkAvailable: false,
  status: AuthStatus.SignedOut,
  operation: AuthOperation.Idle,
  syncStatus: AuthSyncStatus.Idle,
  profile: null,
  errorCode: null,
};
