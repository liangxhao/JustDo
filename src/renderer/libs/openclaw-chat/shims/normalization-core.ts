/**
 * Simplified shim for @openclaw/normalization-core.
 * Provides the subset of coercion functions used by the chat rendering pipeline.
 */

export function normalizeLowercaseStringOrEmpty(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

export function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function normalizeOptionalLowercaseString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toLowerCase();
  return trimmed || undefined;
}

export function normalizeStringifiedOptionalString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const str = String(value).trim();
  return str || undefined;
}

export function normalizeStringEntries(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const result: string[] = [];
  for (const item of list) {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed) result.push(trimmed);
    } else if (item !== null && item !== undefined) {
      const str = String(item).trim();
      if (str) result.push(str);
    }
  }
  return result;
}

export function sortUniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  for (const v of values) {
    if (typeof v === 'string') {
      const trimmed = v.trim();
      if (trimmed) seen.add(trimmed);
    }
  }
  return [...seen].sort();
}

export function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const v of values) {
    if (typeof v === 'string') {
      const trimmed = v.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        result.push(trimmed);
      }
    }
  }
  return result;
}

// ─── Record coercion ────────────────────────────────────────────────────────

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function readStringField(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  if (!record) return undefined;
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

// ─── Number coercion ────────────────────────────────────────────────────────

export function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

export function asDateTimestampMs(value: unknown): number | undefined {
  const num = asFiniteNumber(value);
  if (num === undefined) return undefined;
  // Must be a positive timestamp (ms since epoch)
  if (num <= 0) return undefined;
  return num;
}
