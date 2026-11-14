import { EOL } from 'node:os';

export function diagnosticExportTime(value: unknown): string | undefined {
  const timestamp =
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
      ? Date.parse(value)
      : value;
  return typeof timestamp === 'number' &&
    Number.isSafeInteger(timestamp) &&
    Math.abs(timestamp) <= 8.64e15
    ? new Date(timestamp).toISOString()
    : undefined;
}

export function formatDiagnosticJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`.replaceAll('\n', EOL);
}
