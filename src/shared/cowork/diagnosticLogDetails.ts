/** Only these machine error codes can leave the log parser. Never retain error messages. */
export const diagnosticErrorCodes = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EACCES',
  'EPERM',
  'ENOENT',
  'ENOSPC',
  'SQLITE_BUSY',
  'SQLITE_FULL',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
] as const;
export type DiagnosticErrorCode = (typeof diagnosticErrorCodes)[number];
export const diagnosticStages = ['model', 'tool', 'command', 'runtime'] as const;
export type DiagnosticStage = (typeof diagnosticStages)[number];

/** Validate each metric's meaning as well as its numeric bounds. */
export function isDiagnosticMetricValue(key: string, value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e12) return false;
  if (key === 'statusCode') return Number.isInteger(value) && value >= 100 && value <= 599;
  if (key === 'exitCode') return Number.isInteger(value);
  if (['durationMs', 'waitMs', 'timeToFirstByteMs'].includes(key)) return value >= 0;
  return (
    ['attempt', 'queueDepth', 'requestPayloadBytes', 'responseStreamBytes'].includes(key) &&
    Number.isInteger(value) &&
    value >= 0
  );
}

/** Closed operation families; custom tool names are never retained. */
export const diagnosticOperations = [
  'command',
  'file_read',
  'file_write',
  'file_edit',
  'browser',
  'search',
  'fetch',
  'process',
] as const;
export type DiagnosticOperation = (typeof diagnosticOperations)[number];
