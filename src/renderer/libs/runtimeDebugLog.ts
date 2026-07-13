const MAX_STRING_LENGTH = 240;
const MAX_ARRAY_ITEMS = 20;
const MAX_OBJECT_KEYS = 30;
const MAX_DEPTH = 3;

export function writeRendererDebugLog(message: string, details?: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  const debug = window.electron?.log?.debug;
  if (typeof debug !== 'function') return;
  try {
    debug(message, details ? sanitizeDebugRecord(details) : undefined);
  } catch {
    // Debug logging must never affect the feature being diagnosed.
  }
}

export function sanitizeDebugRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record)
      .slice(0, MAX_OBJECT_KEYS)
      .map(([key, value]) => [key, sanitizeDebugValue(value)]),
  );
}

function sanitizeDebugValue(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}...`
      : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map(item => sanitizeDebugValue(item, depth + 1));
  }
  if (typeof value !== 'object') return String(value);
  if (depth >= MAX_DEPTH) return '[object]';
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, MAX_OBJECT_KEYS)
      .map(([key, item]) => [key, sanitizeDebugValue(item, depth + 1)]),
  );
}
