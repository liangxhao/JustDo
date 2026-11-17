export const BuiltinModelIpc = {
  Changed: 'builtinModels:changed',
  Refresh: 'builtinModels:refresh',
} as const;

export const BuiltinModelRefreshErrorCode = {
  DeviceUnavailable: 'device-unavailable',
  ExchangeTimeout: 'exchange-timeout',
  ExchangeHttpError: 'exchange-http-error',
  Failed: 'refresh-failed',
} as const;

export type BuiltinModelRefreshErrorCode =
  (typeof BuiltinModelRefreshErrorCode)[keyof typeof BuiltinModelRefreshErrorCode];

export type BuiltinModelRefreshResult =
  | { success: true }
  | {
      success: false;
      error: string;
      errorCode: BuiltinModelRefreshErrorCode;
      httpStatus?: number;
    };

export const BuiltinModelSyncReason = {
  AuthLogin: 'auth-login',
  AuthLogout: 'auth-logout',
  ManualRefresh: 'manual-refresh',
} as const;
