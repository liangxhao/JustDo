const MAX_ERROR_DETAIL_CHARS = 2000;
const UNCLASSIFIED_VALUES = new Set(['unknown', 'unclassified', 'no_error_details']);

/** Combine existing display-safe diagnostics without replacing the native failure summary. */
export function appendErrorDisplayDetail(summary: string, detail: unknown): string {
  if (typeof detail !== 'string' || !detail.trim()) return summary;
  const text = detail.trim().slice(0, MAX_ERROR_DETAIL_CHARS);
  if (!summary.trim()) return text;
  if (summary.includes(text)) return summary;
  return `${summary.trim()}\n${text}`;
}

/** Read only the native public, already-redacted error-detail contract. */
export function readErrorDisplayDetail(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of [
    'providerErrorMessagePreview',
    'providerErrorType',
    'failoverReason',
    'providerRuntimeFailureKind',
  ]) {
    const part = record[key];
    if (typeof part !== 'string' || !part.trim() || UNCLASSIFIED_VALUES.has(part.trim())) continue;
    const text = part.trim().slice(0, 300);
    if (!parts.some(existing => existing.includes(text))) parts.push(text);
  }
  const status = record.httpStatus;
  if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599) {
    const text = `HTTP ${status}`;
    if (!parts.some(part => part.includes(text))) parts.push(text);
  }
  return parts.join(' · ');
}
