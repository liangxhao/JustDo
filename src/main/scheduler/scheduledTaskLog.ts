const REDACTED = '[redacted]';
const SENSITIVE_KEYS = new Set([
  'accountId',
  'agentId',
  'argv',
  'completionDestination',
  'cwd',
  'description',
  'env',
  'failureDestination',
  'input',
  'message',
  'name',
  'script',
  'sessionKey',
  'text',
  'to',
]);

export function stringifyScheduledTaskLog(value: unknown): string {
  return JSON.stringify(value, (key, nestedValue) => {
    if (SENSITIVE_KEYS.has(key) && nestedValue !== undefined) return REDACTED;
    return nestedValue;
  });
}
