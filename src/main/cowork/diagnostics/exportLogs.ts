import { createHash } from 'node:crypto';

import type {
  DiagnosticLogRecord,
  DiagnosticLogSource,
} from '../../../shared/cowork/diagnostics/sessionDiagnostics';
import { redactLogText as redactDiagnosticLog } from '../../core/logging/logRedaction';
import { diagnosticExportTime } from './exportFormat';
import type { DiagnosticLogExportMetadata } from './logCollector';

export { redactDiagnosticLog };

const SOURCE_LIMIT = 2 * 1024 * 1024;
const SOURCE_RECORD_LIMIT = 2048;
const SOURCES: DiagnosticLogSource[] = ['main', 'cowork', 'gateway', 'native'];
const SELECTION = 'evidence_priority_with_recent_context';
const LOG_TIME = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)?$/;
const LOG_PREFIX = /^\[([^\]\r\n]+)\] (?=\[)/;
const MAIN_MIRROR = /^\[(info|error)\] \[OpenClaw (stdout|stderr)\] ([^\r\n]*)$/;
const GATEWAY_STREAM = /^\[(stdout|stderr)\] ([^\r\n]*)$/;
const GATEWAY_FORWARD_MAX_DELAY_MS = 100;
export const DIAGNOSTIC_ERRORS_FILE = 'errors.log';

export interface DiagnosticExportLogIndex extends DiagnosticLogExportMetadata {
  source: DiagnosticLogSource;
  association: DiagnosticLogRecord['association'];
  file: string;
  line: number;
  endLine: number;
}
export interface DiagnosticExportLogBundle {
  entries: Record<string, string>;
  coverage: Array<{
    source: DiagnosticLogSource;
    bytes: number;
    records: number;
    omitted: number;
    byteLimit: number;
    seenRecords?: number;
    duplicateRecords?: number;
    omittedBytes?: number;
    recordLimit?: number;
    selection?: string;
    retainedAssociations?: Partial<Record<DiagnosticLogRecord['association'], number>>;
    seenAssociations?: Partial<Record<DiagnosticLogRecord['association'], number>>;
  }>;
  index?: DiagnosticExportLogIndex[];
}
interface RetainedRecord extends DiagnosticLogExportMetadata {
  source: DiagnosticLogSource;
  association: DiagnosticLogRecord['association'];
  isError: boolean;
  content: string;
  bytes: number;
  order: number;
  priority: number;
  mirrorKey?: string;
}
const priority = (association: DiagnosticLogRecord['association'], issue: boolean) => {
  return association === 'run'
    ? issue
      ? 5
      : 4
    : association === 'session'
      ? issue
        ? 3
        : 1
      : issue
        ? 2
        : 0;
};
const compareTime = (left: RetainedRecord, right: RetainedRecord) =>
  Number(left.timestamp === undefined) - Number(right.timestamp === undefined) ||
  (left.timestamp ?? 0) - (right.timestamp ?? 0);

function isSameLogTime(value: unknown, timestamp: number | undefined): boolean {
  return (
    timestamp !== undefined &&
    typeof value === 'string' &&
    LOG_TIME.test(value) &&
    Date.parse(value.replace(' ', 'T')) === timestamp
  );
}

function normalizeLogText(
  source: DiagnosticLogSource,
  text: string,
  timestamp: number | undefined,
): string {
  const normalizedTime = diagnosticExportTime(timestamp);
  if (source !== 'native') {
    const prefix = LOG_PREFIX.exec(text);
    return prefix && normalizedTime && isSameLogTime(prefix[1], timestamp)
      ? `[${normalizedTime}] ${text.slice(prefix[0].length)}`
      : text;
  }
  if (!text.startsWith('{')) return text;
  try {
    const record = JSON.parse(text) as Record<string, unknown>;
    const value = record._meta;
    const meta =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    const sameTime = normalizedTime && isSameLogTime(record.time, timestamp);
    const sameMetaDate = normalizedTime && isSameLogTime(meta?.date, timestamp);
    let changed = false;
    if (sameTime && record.time !== normalizedTime) {
      record.time = normalizedTime;
      changed = true;
    }
    if (meta) {
      if (sameMetaDate) {
        if (sameTime) {
          delete meta.date;
          changed = true;
        } else if (meta.date !== normalizedTime) {
          meta.date = normalizedTime;
          changed = true;
        }
      }
      if (typeof meta.logLevelName === 'string') {
        if (typeof record.hostname === 'string' && record.hostname === meta.hostname) {
          delete meta.hostname;
          changed = true;
        }
        if (
          typeof record.message === 'string' &&
          Object.entries(record).some(
            ([key, value]) => /^\d+$/.test(key) && value === record.message,
          )
        ) {
          delete record.message;
          changed = true;
        }
      }
    }
    return changed ? JSON.stringify(record) : text;
  } catch {
    return text;
  }
}

function gatewayMirrorKey(
  source: DiagnosticLogSource,
  text: string,
  timestamp: number | undefined,
): string | undefined {
  if (source !== 'main' && source !== 'gateway') return undefined;
  const prefix = LOG_PREFIX.exec(text);
  if (!prefix || !isSameLogTime(prefix[1], timestamp)) return undefined;
  const body = text.slice(prefix[0].length);
  if (source === 'main') {
    const forwarded = MAIN_MIRROR.exec(body);
    if (!forwarded || (forwarded[1] === 'error') !== (forwarded[2] === 'stderr')) return undefined;
    return `${forwarded[2]}:${createHash('sha256').update(forwarded[3]).digest('hex')}`;
  }
  const stream = GATEWAY_STREAM.exec(body);
  if (!stream) return undefined;
  // Main's console forwarding rewrites ISO UTC timestamps to local offsets.
  const forwarded = stream[2].replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, value => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    const offset = -date.getTimezoneOffset();
    const absolute = Math.abs(offset);
    const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
    const minutes = String(absolute % 60).padStart(2, '0');
    const local = new Date(date.getTime() + offset * 60_000).toISOString().slice(0, -1);
    return `${local}${offset >= 0 ? '+' : '-'}${hours}:${minutes}`;
  });
  return `${stream[1]}:${createHash('sha256').update(forwarded).digest('hex')}`;
}

function findGatewayMirrors(main: RetainedRecord[], gateway: RetainedRecord[]) {
  const candidates = new Map<string, RetainedRecord[]>();
  for (const record of [...gateway].sort(compareTime)) {
    if (!record.mirrorKey) continue;
    const matches = candidates.get(record.mirrorKey) ?? [];
    matches.push(record);
    candidates.set(record.mirrorKey, matches);
  }
  const duplicates = new Set<RetainedRecord>();
  const forwardedErrors = new Set<RetainedRecord>();
  // Match one-to-one after eviction so an omitted Gateway line cannot hide the Main fallback.
  for (const record of [...main].sort(compareTime)) {
    const { timestamp } = record;
    if (!record.mirrorKey || timestamp === undefined) continue;
    const matches = candidates.get(record.mirrorKey);
    if (!matches) continue;
    const canPromote = record.level === 'error' && record.mirrorKey.startsWith('stderr:');
    const match = matches.findIndex(candidate => {
      if (
        candidate.timestamp === undefined ||
        candidate.association !== record.association ||
        (record.isError && !candidate.isError && !canPromote) ||
        Math.max(candidate.priority, canPromote ? priority(candidate.association, true) : 0) <
          record.priority
      )
        return false;
      const delay = timestamp - candidate.timestamp;
      return delay >= 0 && delay <= GATEWAY_FORWARD_MAX_DELAY_MS;
    });
    if (match < 0) continue;
    const [counterpart] = matches.splice(match, 1);
    if (canPromote && !counterpart.isError) forwardedErrors.add(counterpart);
    duplicates.add(record);
  }
  return { duplicates, forwardedErrors };
}

/** Lowest-value, oldest evidence is evicted first; unknown times stay unknown. */
const compareRetention = (left: RetainedRecord, right: RetainedRecord) =>
  left.priority - right.priority ||
  Number(left.timestamp !== undefined) - Number(right.timestamp !== undefined) ||
  (left.timestamp !== undefined && right.timestamp !== undefined
    ? left.timestamp - right.timestamp
    : 0) ||
  left.order - right.order;

/** A bounded min-heap avoids sorting retained text for every scanned record. */
function push(records: RetainedRecord[], record: RetainedRecord): void {
  records.push(record);
  let index = records.length - 1;
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (compareRetention(records[parent], records[index]) <= 0) break;
    [records[parent], records[index]] = [records[index], records[parent]];
    index = parent;
  }
}
function shift(records: RetainedRecord[]): RetainedRecord {
  const first = records[0];
  const last = records.pop()!;
  if (records.length) {
    records[0] = last;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < records.length && compareRetention(records[left], records[smallest]) < 0)
        smallest = left;
      if (right < records.length && compareRetention(records[right], records[smallest]) < 0)
        smallest = right;
      if (smallest === index) break;
      [records[index], records[smallest]] = [records[smallest], records[index]];
      index = smallest;
    }
  }
  return first;
}

export class DiagnosticExportLogs {
  private readonly sources = new Map(
    SOURCES.map(source => [
      source,
      {
        records: [] as RetainedRecord[],
        bytes: 0,
        seen: 0,
        omittedBytes: 0,
        seenAssociations: {} as Partial<Record<DiagnosticLogRecord['association'], number>>,
      },
    ]),
  );

  append(
    source: DiagnosticLogSource,
    text: string,
    association: DiagnosticLogRecord['association'],
    metadata?: DiagnosticLogExportMetadata,
  ): void {
    const target = this.sources.get(source)!;
    const order = ++target.seen;
    target.seenAssociations[association] = (target.seenAssociations[association] ?? 0) + 1;
    const id =
      metadata?.id.startsWith(`log-${source}-`) && /^log-\w+-\d+$/.test(metadata.id)
        ? metadata.id
        : `log-${source}-${order}`;
    const level = metadata?.level ?? 'unknown';
    const isError = level === 'error' || metadata?.isError === true;
    const timestamp =
      typeof metadata?.timestamp === 'number' && Number.isFinite(metadata.timestamp)
        ? metadata.timestamp
        : undefined;
    // Mask complete records before retention so clipping cannot introduce a partial credential.
    const content = `${normalizeLogText(source, redactDiagnosticLog(text), timestamp)}\n`;
    const bytes = Buffer.byteLength(content);
    if (bytes > SOURCE_LIMIT) {
      target.omittedBytes += bytes;
      return;
    }
    push(target.records, {
      id,
      source,
      timestamp,
      level,
      association,
      isError,
      content,
      bytes,
      order,
      mirrorKey: gatewayMirrorKey(source, text, timestamp),
      priority:
        association === 'run' && metadata?.recoveryExhausted
          ? 6
          : priority(association, isError || level === 'warn'),
    });
    target.bytes += bytes;
    while (target.bytes > SOURCE_LIMIT || target.records.length > SOURCE_RECORD_LIMIT) {
      const omitted = shift(target.records);
      target.bytes -= omitted.bytes;
      target.omittedBytes += omitted.bytes;
    }
  }

  finish(): DiagnosticExportLogBundle {
    const entries: Record<string, string> = {};
    const index: DiagnosticExportLogIndex[] = [];
    const coverage: DiagnosticExportLogBundle['coverage'] = [];
    const errors: RetainedRecord[] = [];
    const { duplicates, forwardedErrors } = findGatewayMirrors(
      this.sources.get('main')!.records,
      this.sources.get('gateway')!.records,
    );
    const write = (file: string, records: RetainedRecord[]) => {
      let line = 1;
      for (const record of records) {
        const lines = record.content.split('\n').length - 1;
        index.push({
          id: record.id,
          source: record.source,
          association: record.association,
          level: record.level,
          timestamp: record.timestamp,
          file,
          line,
          endLine: line + lines - 1,
        });
        line += lines;
      }
      entries[file] = records.map(record => record.content).join('');
    };
    for (const [source, value] of this.sources) {
      const records = value.records
        .filter(record => !duplicates.has(record))
        .sort((left, right) => compareTime(left, right) || left.order - right.order);
      const context: RetainedRecord[] = [];
      const associations: NonNullable<
        DiagnosticExportLogBundle['coverage'][number]['retainedAssociations']
      > = {};
      for (const record of records) {
        if (forwardedErrors.has(record)) errors.push({ ...record, level: 'error', isError: true });
        else (record.isError ? errors : context).push(record);
        associations[record.association] = (associations[record.association] ?? 0) + 1;
      }
      write(`logs/${source}.log`, context);
      coverage.push({
        source,
        bytes: records.reduce((total, record) => total + record.bytes, 0),
        records: records.length,
        omitted: value.seen - value.records.length,
        byteLimit: SOURCE_LIMIT,
        seenRecords: value.seen,
        ...(source === 'main' && duplicates.size ? { duplicateRecords: duplicates.size } : {}),
        omittedBytes: value.omittedBytes,
        recordLimit: SOURCE_RECORD_LIMIT,
        selection: SELECTION,
        retainedAssociations: associations,
        seenAssociations: { ...value.seenAssociations },
      });
    }
    if (errors.length) write(DIAGNOSTIC_ERRORS_FILE, errors.sort(compareTime));
    return { entries, index, coverage };
  }
}
