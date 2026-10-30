import { TaskCompletionStatus } from './constants';
import type {
  ScheduledTaskRunDiagnostic,
  ScheduledTaskRunDiagnostics,
  ScheduledTaskRunMetadata,
  ScheduledTaskRunUsage,
} from './types';

const DIAGNOSTIC_SOURCES = new Set([
  'cron-preflight',
  'cron-setup',
  'model-preflight',
  'agent-run',
  'tool',
  'exec',
  'delivery',
]);
const DIAGNOSTIC_SEVERITIES = new Set(['info', 'warn', 'error']);
const MAX_DIAGNOSTIC_ENTRIES = 32;
const MAX_DIAGNOSTIC_MESSAGE_CHARS = 2048;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const boundedText = (value: unknown, limit: number): string | undefined =>
  typeof value === 'string' && value.trim() ? value.slice(0, limit) : undefined;

export function normalizeScheduledTaskDiagnostics(
  value: unknown,
): ScheduledTaskRunDiagnostics | undefined {
  const source = record(value);
  if (!Array.isArray(source.entries)) return undefined;
  const entries: ScheduledTaskRunDiagnostic[] = [];
  for (const candidate of source.entries.slice(0, 128)) {
    const entry = record(candidate);
    if (
      typeof entry.ts !== 'number' ||
      !Number.isSafeInteger(entry.ts) ||
      entry.ts < 0 ||
      typeof entry.source !== 'string' ||
      !DIAGNOSTIC_SOURCES.has(entry.source) ||
      typeof entry.severity !== 'string' ||
      !DIAGNOSTIC_SEVERITIES.has(entry.severity) ||
      typeof entry.message !== 'string'
    )
      continue;
    entries.push({
      ts: entry.ts,
      source: entry.source as ScheduledTaskRunDiagnostic['source'],
      severity: entry.severity as ScheduledTaskRunDiagnostic['severity'],
      message: entry.message.slice(0, MAX_DIAGNOSTIC_MESSAGE_CHARS),
      ...(boundedText(entry.toolName, 128) ? { toolName: boundedText(entry.toolName, 128) } : {}),
      ...(entry.exitCode === null ||
      (typeof entry.exitCode === 'number' && Number.isFinite(entry.exitCode))
        ? { exitCode: entry.exitCode as number | null }
        : {}),
      ...(entry.truncated === true || entry.message.length > MAX_DIAGNOSTIC_MESSAGE_CHARS
        ? { truncated: true }
        : {}),
    });
    if (entries.length >= MAX_DIAGNOSTIC_ENTRIES) break;
  }
  const summary = boundedText(source.summary, 4096);
  return { ...(summary ? { summary } : {}), entries };
}

/** Only bounded native receipt facts cross into product storage and Renderer. */
export function normalizeScheduledTaskRunMetadata(value: unknown): ScheduledTaskRunMetadata {
  const source = record(value);
  const result: ScheduledTaskRunMetadata = {};
  if (
    source.completionStatus === TaskCompletionStatus.Succeeded ||
    source.completionStatus === TaskCompletionStatus.Failed ||
    source.completionStatus === TaskCompletionStatus.Unknown
  ) {
    result.completionStatus = source.completionStatus;
  }
  for (const key of ['errorReason', 'deliverySuppressionReason', 'model', 'provider'] as const) {
    const text = boundedText(source[key], 512);
    if (text) result[key] = text;
  }
  const diagnostics = normalizeScheduledTaskDiagnostics(source.diagnostics);
  if (diagnostics) result.diagnostics = diagnostics;
  if (source.usage && typeof source.usage === 'object' && !Array.isArray(source.usage)) {
    const rawUsage = record(source.usage);
    const usage: ScheduledTaskRunUsage = {};
    for (const key of [
      'input_tokens',
      'output_tokens',
      'total_tokens',
      'cache_read_tokens',
      'cache_write_tokens',
    ] as const) {
      const tokens = rawUsage[key];
      if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0) usage[key] = tokens;
    }
    if (Object.keys(usage).length) result.usage = usage;
  }
  return result;
}
