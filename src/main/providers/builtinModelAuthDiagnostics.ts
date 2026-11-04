import type { BuiltinModelCredentialFailureCode } from './builtinModelCredential';

export const BuiltinModelAuthDiagnosticEvent = {
  ExchangeSucceeded: 'exchange.succeeded',
  ExchangeFailed: 'exchange.failed',
  ExchangeUnavailable: 'exchange.unavailable',
  RefreshRetryScheduled: 'refresh.retry-scheduled',
  ApplicationFailed: 'application.failed',
  ConfigSyncFailed: 'config-sync.failed',
  SnapshotPublished: 'snapshot.published',
  SnapshotPublicationFailed: 'snapshot.publication-failed',
  SnapshotRevoked: 'snapshot.revoked',
  SnapshotRevocationFailed: 'snapshot.revocation-failed',
  ReloadAcknowledged: 'reload.acknowledged',
  ReloadFailed: 'reload.failed',
  RecoveryFailed: 'recovery.failed',
  StartupFailed: 'startup.failed',
  NotificationFailed: 'notification.failed',
  DiscoverySucceeded: 'discovery.succeeded',
  DiscoveryFailed: 'discovery.failed',
  DiscoveryOptionalHttpRejected: 'discovery.optional-http-rejected',
} as const;

export type BuiltinModelAuthDiagnosticEvent =
  (typeof BuiltinModelAuthDiagnosticEvent)[keyof typeof BuiltinModelAuthDiagnosticEvent];

export const BuiltinModelAuthDiagnosticReason = {
  ConfigInvalid: 'config-invalid',
  EndpointMissing: 'endpoint-missing',
  LoginMissing: 'login-missing',
  LoginTooLarge: 'login-too-large',
  LoginInvalidJson: 'login-invalid-json',
  LoginInvalidFields: 'login-invalid-fields',
  LoginReadFailed: 'login-read-failed',
  LoginSuspended: 'login-suspended',
  UrlInvalid: 'url-invalid',
  DeviceUnavailable: 'device-unavailable',
  NetworkFailure: 'network-failure',
  RequestTimeout: 'request-timeout',
  HttpRejected: 'http-rejected',
  ResponseUnreadable: 'response-unreadable',
  ResponseEmpty: 'response-empty',
  ResponseTooLarge: 'response-too-large',
  ResponseInvalidJson: 'response-invalid-json',
  ResponseInvalidShape: 'response-invalid-shape',
  CredentialInvalid: 'credential-invalid',
  IdentityUnavailable: 'identity-unavailable',
  ConfigApplicationFailed: 'config-application-failed',
  SnapshotInvalid: 'snapshot-invalid',
  SnapshotWriteFailed: 'snapshot-write-failed',
  SnapshotRevokeFailed: 'snapshot-revoke-failed',
  ReloadFailed: 'reload-failed',
  ReloadAckInvalid: 'reload-ack-invalid',
  RecoveryFailed: 'recovery-failed',
} as const;

export type BuiltinModelAuthDiagnosticReason =
  (typeof BuiltinModelAuthDiagnosticReason)[keyof typeof BuiltinModelAuthDiagnosticReason];

const ERROR_CODES = [
  'ENOENT', 'EACCES', 'EPERM', 'EBUSY', 'ENOSPC', 'EROFS', 'EIO', 'EMFILE', 'ENFILE',
  'EISDIR', 'ENOTDIR', 'EINVAL',
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'EPIPE', 'ECONNABORTED', 'ENOTCONN',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'UNAVAILABLE', 'CLIENT_TIMEOUT', 'FORBIDDEN', 'INVALID_REQUEST', 'UNAUTHORIZED',
] as const;
export type BuiltinModelAuthErrorCode = (typeof ERROR_CODES)[number] | 'unknown';
const allowedErrorCodes = new Set<string>(ERROR_CODES);

/** Project closed error codes only; arbitrary error text and properties stay private. */
export function getBuiltinModelAuthErrorCode(error: unknown): BuiltinModelAuthErrorCode {
  const pending = [error];
  const visited = new Set<object>();
  for (let index = 0; index < pending.length && index < 16; index += 1) {
    const value = pending[index];
    if (!value || typeof value !== 'object' || visited.has(value)) continue;
    visited.add(value);
    try {
      const candidate = value as { code?: unknown; gatewayCode?: unknown; cause?: unknown; errors?: unknown };
      for (const code of [candidate.gatewayCode, candidate.code]) {
        if (typeof code === 'string' && allowedErrorCodes.has(code)) return code as BuiltinModelAuthErrorCode;
      }
      pending.push(candidate.cause);
      if (Array.isArray(candidate.errors)) pending.push(...candidate.errors.slice(0, 4));
    } catch {
      // Exotic/proxy errors must not alter the operation being diagnosed.
    }
  }
  return 'unknown';
}

export type BuiltinModelAuthDiagnosticFields = Readonly<{
  generation?: number;
  backgroundRevision?: number;
  background?: boolean;
  refreshCatalog?: boolean;
  credentialPresent?: boolean;
  authType?: 'jwt' | 'api-key' | 'none';
  stage?: 'url' | 'device' | 'request' | 'response' | 'credential' | 'identity';
  reason?: BuiltinModelAuthDiagnosticReason;
  errorCode?: BuiltinModelAuthErrorCode;
  networkCode?: BuiltinModelAuthErrorCode;
  credentialCode?: BuiltinModelCredentialFailureCode;
  httpStatus?: number;
  elapsedMs?: number;
  expiresInSeconds?: number;
  refreshInMs?: number;
  retryDelayMs?: number;
  syncReason?: 'auth-login' | 'auth-logout' | 'other';
  configSynced?: boolean;
  requireApplication?: boolean;
  remainingSeconds?: number;
  attempt?: number;
  maxAttempts?: number;
  timeoutMs?: number;
  warningCount?: number;
  changed?: boolean;
  fileKind?: 'snapshot' | 'resolver' | 'launcher';
  willRetry?: boolean;
  snapshotState?: 'missing' | 'expired' | 'invalid-session';
  ackState?: 'accepted' | 'invalid';
  gatewayPhase?: 'uninstalled' | 'ready' | 'starting' | 'running' | 'stopping' | 'error';
  discoveryStage?: 'models' | 'model-info';
  chatModelCount?: number;
  embeddingModelCount?: number;
}>;

const diagnosticFieldNames = new Set<string>([
  'generation', 'backgroundRevision', 'background', 'refreshCatalog', 'credentialPresent', 'authType',
  'stage', 'reason', 'errorCode', 'networkCode', 'credentialCode', 'httpStatus', 'elapsedMs',
  'expiresInSeconds', 'refreshInMs', 'retryDelayMs', 'syncReason',
  'configSynced', 'requireApplication',
  'remainingSeconds', 'attempt', 'maxAttempts', 'timeoutMs', 'warningCount', 'changed', 'fileKind', 'willRetry',
  'snapshotState', 'ackState', 'gatewayPhase',
  'discoveryStage', 'chatModelCount', 'embeddingModelCount',
]);

/** A single string avoids util.inspect wrapping; JSON escapes embedded line breaks. */
export function writeBuiltinModelAuthDiagnostic(
  level: 'info' | 'warn' | 'error',
  event: BuiltinModelAuthDiagnosticEvent,
  fields: BuiltinModelAuthDiagnosticFields = {},
): void {
  try {
    const projected = Object.fromEntries(Object.entries(fields).filter(([name, value]) =>
      diagnosticFieldNames.has(name) && (typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      (typeof value === 'string' && value.length <= 128)),
    ));
    console[level](`[BuiltinModelAuth] ${JSON.stringify({ event, ...projected })}`);
  } catch { /* Observability must not affect credential or execution ownership. */ }
}
