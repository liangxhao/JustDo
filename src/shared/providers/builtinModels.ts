export const BuiltinModelIpc = {
  Changed: 'builtinModels:changed',
  Refresh: 'builtinModels:refresh',
} as const;

export const BuiltinModelRefreshErrorCode = {
  DeviceUnavailable: 'device-unavailable',
  ExchangeHttpError: 'exchange-http-error',
} as const;

export type BuiltinModelRefreshErrorCode =
  (typeof BuiltinModelRefreshErrorCode)[keyof typeof BuiltinModelRefreshErrorCode];

export type BuiltinModelAuthIssue = {
  errorCode: BuiltinModelRefreshErrorCode;
  httpStatus?: number;
};

export type BuiltinModelRefreshResult =
  | { success: true }
  | { success: false; skipped: true }
  | ({ success: false } & BuiltinModelAuthIssue);

export const BuiltinModelSyncReason = {
  AuthLogin: 'auth-login',
  AuthLogout: 'auth-logout',
} as const;
