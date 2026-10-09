import fs from 'node:fs/promises';
import path from 'node:path';

import {
  diagnosticErrorCodes,
  isDiagnosticMetricValue,
} from '../../../shared/cowork/diagnostics/diagnosticLogDetails';
import type {
  DiagnosticLogCollection,
  DiagnosticLogCoverage,
  DiagnosticLogRecord,
  DiagnosticLogSignal,
  DiagnosticLogSource,
  DiagnosticReport,
  DiagnosticScanProgress,
} from '../../../shared/cowork/diagnostics/sessionDiagnostics';
import { scanDiagnosticLog } from './logScanner';
import { projectResponseLog } from './responseLog';

const FILE_BYTES = 512 * 1024;
const TOTAL_BYTES = 4 * 1024 * 1024;
const RECORD_BYTES = 64 * 1024;
const MAX_FILES = 16;
const MAX_RECORDS = 400;
// Each source retains capacity even when an earlier log source is very noisy.
const SOURCE_BYTES = 1024 * 1024;
const SOURCE_FILES = 4;
const SOURCE_RECORDS = 100;
const DEADLINE_MS = 5000;
const WINDOW_MARGIN_MS = 120_000;
const METRICS = [
  'statusCode',
  'attempt',
  'durationMs',
  'queueDepth',
  'exitCode',
  'waitMs',
  'timeToFirstByteMs',
  'requestPayloadBytes',
  'responseStreamBytes',
] as const;
const SIGNALS: DiagnosticLogSignal[] = [
  'auth',
  'rate_limit',
  'billing',
  'context',
  'timeout',
  'network',
  'tls',
  'provider',
  'tool',
  'retry',
  'disconnect',
  'reconnect',
  'process_exit',
  'queue',
  'storage',
  'permission',
  'unknown',
];
const HINTS: Array<[DiagnosticLogSignal, RegExp]> = [
  ['auth', /\b(?:unauthorized|authentication[ ._-](?:failed|error)|invalid.api.key)\b/i],
  ['rate_limit', /\brate[._ -]limit(?:ed|ing)?\b/i],
  ['billing', /\b(?:billing|insufficient.quota)\b/i],
  [
    'context',
    /\b(?:context[._ -]overflow|context[._ -](?:length|window|limit).{0,24}(?:exceeded|overflow|too.large)|prompt.too.large)\b/i,
  ],
  ['timeout', /\b(?:timeout|timed.out|ETIMEDOUT)\b/i],
  ['tls', /\b(?:TLS|certificate|CERT_[A-Z_]+)\b/],
  ['network', /\b(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|connection.reset|fetch.failed)\b/i],
  ['permission', /\b(?:EACCES|EPERM|permission.denied)\b/i],
  ['storage', /\b(?:SQLITE_[A-Z_]+|ENOSPC|disk.full)\b/i],
  [
    'process_exit',
    /\b(?:process.exited|exit.code|render-process-gone|SIGTERM|SIGKILL|out.of.memory)\b/i,
  ],
  ['network', /\bdid-fail-load\b/i],
  ['unknown', /\b(?:uncaughtException|unhandledRejection)\b/],
  ['disconnect', /\b(?:disconnected|connection.closed)\b/i],
  ['reconnect', /\b(?:reconnected|reconnecting)\b/i],
  ['retry', /\b(?:retry|retrying|backoff)\b/i],
  ['queue', /\b(?:queue|queued)\b/i],
  ['tool', /\btool.(?:failed|error)\b|\[tools\]\s+\S+\s+failed\b/i],
  ['provider', /\bprovider.error\b/i],
];
// Native diagnostic contracts use categories beyond the UI's closed signal vocabulary.
const NATIVE_CATEGORIES: Record<string, DiagnosticLogSignal> = {
  auth_permanent: 'auth',
  context_overflow: 'context',
  tool_result_error: 'tool',
  before_tool_call: 'tool',
  overloaded: 'provider',
  request_timeout: 'timeout',
  connection_reset: 'network',
  connection_closed: 'network',
  'overall-timeout': 'timeout',
  'no-output-timeout': 'timeout',
};
const NATIVE_EVENTS: Record<string, DiagnosticLogSignal> = {
  'tool.execution.error': 'tool',
  'tool.execution.blocked': 'permission',
  'model.call.error': 'provider',
};
const httpSignal = (status: number | undefined): DiagnosticLogSignal | undefined =>
  status === 401
    ? 'auth'
    : status === 403
      ? 'permission'
      : status === 429
        ? 'rate_limit'
        : status !== undefined && status >= 500 && status <= 599 && Number.isInteger(status)
          ? 'provider'
          : undefined;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const own = (value: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(value, key) ? value[key] : undefined;
const reason = (
  coverage: DiagnosticLogCoverage,
  value: DiagnosticLogCoverage['reasons'][number],
) => {
  if (!coverage.reasons.includes(value)) coverage.reasons.push(value);
};

function parseRecord(text: string, source: DiagnosticLogSource) {
  let timestamp: number | undefined;
  let level: DiagnosticLogRecord['level'] = 'unknown';
  let body = text;
  const prefix = /^\[([^\]]+)\]\s*\[([^\]]+)\]\s*/.exec(text);
  if (prefix) {
    const parsed = Date.parse(prefix[1].replace(/^(\d{4}-\d\d-\d\d) /, '$1T'));
    if (Number.isFinite(parsed)) timestamp = parsed;
    const candidate = prefix[2].toLowerCase();
    if (['error', 'warn', 'info', 'debug'].includes(candidate)) level = candidate as typeof level;
    body = text.slice(prefix[0].length);
  }
  const fields: Record<string, unknown>[] = [];
  let hintText = body;
  let malformed = false;
  if (body.trimStart().startsWith('{')) {
    try {
      const root = object(JSON.parse(body));
      if (root) {
        fields.push(root);
        // Metadata names, configuration objects and tool arguments are not error messages.
        hintText = Object.entries(root)
          .filter(
            ([key, value]) =>
              (/^\d+$/.test(key) || ['message', 'msg', 'error'].includes(key)) &&
              typeof value === 'string' &&
              !value.trimStart().startsWith('{'),
          )
          .map(([, value]) => value)
          .join(' ');
        for (const [key, value] of Object.entries(root)) {
          if (!/^\d+$/.test(key)) continue;
          const argument = object(value);
          if (argument) fields.push(argument);
          else if (typeof value === 'string' && value.trimStart().startsWith('{')) {
            try {
              const parsed = object(JSON.parse(value));
              if (parsed) fields.push(parsed);
            } catch {
              /* text argument */
            }
          }
        }
        const meta = object(own(root, '_meta'));
        const time = own(root, 'time') ?? (meta && own(meta, 'date'));
        if (typeof time === 'string' && Number.isFinite(Date.parse(time)))
          timestamp = Date.parse(time);
        const nativeLevel = own(root, 'level') ?? (meta && own(meta, 'logLevelName'));
        if (
          typeof nativeLevel === 'string' &&
          ['error', 'warn', 'info', 'debug'].includes(nativeLevel.toLowerCase())
        )
          level = nativeLevel.toLowerCase() as typeof level;
      } else malformed = true;
    } catch {
      malformed = true;
    }
  } else if (source === 'native') malformed = true;
  // Plain-text content never establishes keyed identity, including forged "runId=" strings.
  return { timestamp, level, fields, malformed, hintText };
}

async function readTail(file: string, maxBytes: number, deadline: number) {
  if (/^(?:\\\\|\/\/)/.test(file)) throw new Error('unsafe_file');
  const resolved = path.resolve(file);
  // Reject symlink parents as well as the final entry, including Windows junctions.
  let current = resolved;
  while (true) {
    if (Date.now() >= deadline) throw new Error('limit');
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error('unsafe_file');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (Date.now() >= deadline) throw new Error('limit');
  const before = await fs.lstat(resolved);
  if (!before.isFile()) throw new Error('unsafe_file');
  if (Date.now() >= deadline) throw new Error('limit');
  const handle = await fs.open(resolved, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino)
      throw new Error('unsafe_file');
    if (Date.now() >= deadline) throw new Error('limit');
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      if (Date.now() >= deadline) throw new Error('limit');
      const result = await handle.read(
        buffer,
        bytesRead,
        length - bytesRead,
        stat.size - length + bytesRead,
      );
      if (!result.bytesRead) break;
      bytesRead += result.bytesRead;
    }
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    const truncated = stat.size > length || bytesRead < length;
    // Discard the leading partial line; its missing prefix could contain identity or redaction context.
    if (stat.size > length) text = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '';
    return { text, bytesRead, truncated };
  } finally {
    await handle.close();
  }
}

async function readTailBeforeDeadline(file: string, maxBytes: number, deadline: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      readTail(file, maxBytes, deadline),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('limit')), Math.max(0, deadline - Date.now()));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Collect only bounded, payload-free hints. This never changes the run conclusion. */
export async function collectDiagnosticLogs(
  report: DiagnosticReport,
  sources: { main: string[]; cowork: string[]; gateway: string[] },
  native?: {
    lines: string[];
    truncated?: boolean;
    files?: string[];
    discoveryFailure?: 'unsafe_file' | 'unreadable' | 'read_timeout' | 'canceled';
  },
  options: {
    fullScan?: boolean;
    onExportRecord?: (
      source: DiagnosticLogSource,
      text: string,
      association: DiagnosticLogRecord['association'],
    ) => void;
    signal?: AbortSignal;
    onProgress?: (progress: Omit<DiagnosticScanProgress, 'snapshotId'>) => void;
  } = {},
): Promise<DiagnosticLogCollection> {
  const now = Date.now();
  const deadline = options.fullScan ? Number.POSITIVE_INFINITY : now + DEADLINE_MS;
  // A historical run can precede the default tail by hours on the same day.
  // Expand only completed-run reads, retaining source isolation and a hard deadline.
  const historical = report.run?.endedAt !== undefined;
  const fileBudget = historical ? 4 * 1024 * 1024 : FILE_BYTES;
  const sourceBudget = historical ? 4 * 1024 * 1024 : SOURCE_BYTES;
  const totalBudget = historical ? 13 * 1024 * 1024 : TOTAL_BYTES;
  const end = report.run?.endedAt ?? report.collectedAt;
  const window = {
    from: Math.max(0, (report.run?.startedAt ?? end) - WINDOW_MARGIN_MS),
    to: end + WINDOW_MARGIN_MS,
  };
  const collection: DiagnosticLogCollection = {
    scanMode: options.fullScan ? 'full_files' : 'tail',
    collectedAt: now,
    window,
    localTimezoneOffsetMinutes: new Date().getTimezoneOffset(),
    partial: true,
    sources: [],
    records: [],
  };
  const runIds = new Set(
    [report.run?.id, ...report.events.map(event => event.nativeRunId)].filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    ),
  );
  let totalBytes = 0;
  let fileCount = 0;
  const consume = (text: string, coverage: DiagnosticLogCoverage) => {
    const lines = text.split(/\r?\n/);
    const records: string[] = [];
    for (const line of lines) {
      if (!line) continue;
      if (
        coverage.source !== 'native' &&
        !/^\[\d{4}-\d\d-\d\d[ T]/.test(line) &&
        !line.startsWith('{')
      ) {
        if (records.length) records[records.length - 1] += `\n${line}`;
        else {
          coverage.suppressed++;
          reason(coverage, 'malformed');
        }
      } else records.push(line);
    }
    for (const textRecord of records.reverse()) {
      coverage.recordsRead++;
      if (
        Date.now() >= deadline ||
        (!options.fullScan && collection.records.length >= MAX_RECORDS) ||
        (!options.fullScan && coverage.emitted >= SOURCE_RECORDS) ||
        Buffer.byteLength(textRecord) > RECORD_BYTES
      ) {
        coverage.suppressed++;
        coverage.truncated = true;
        reason(coverage, 'limit');
        continue;
      }
      if (textRecord.includes('\uFFFD')) {
        coverage.parseFailures++;
        coverage.suppressed++;
        reason(coverage, 'malformed');
        continue;
      }
      const parsed = parseRecord(textRecord, coverage.source);
      if (parsed.malformed) {
        coverage.parseFailures++;
        coverage.suppressed++;
        reason(coverage, 'malformed');
        continue;
      }
      const ids = (keys: string[]) =>
        parsed.fields.flatMap(fields =>
          keys.flatMap(key => {
            const value = own(fields, key);
            return typeof value === 'string' && value.length ? [value] : [];
          }),
        );
      const runs = ids(['runId', 'nativeRunId', 'sessionRunId']);
      const sessions = ids(['sessionId']);
      // Known different identities must not be relabelled as this run by timestamp proximity.
      if (
        runs.some(id => !runIds.has(id)) ||
        (coverage.source !== 'native' && sessions.some(id => id !== report.sessionId))
      ) {
        coverage.suppressed++;
        reason(coverage, 'outside_window');
        continue;
      }
      let association: DiagnosticLogRecord['association'];
      if (runs.length && runs.every(id => runIds.has(id))) association = 'run';
      else if (
        coverage.source !== 'native' &&
        sessions.length &&
        sessions.every(id => id === report.sessionId)
      )
        association = 'session';
      else if (
        parsed.timestamp !== undefined &&
        parsed.timestamp >= window.from &&
        parsed.timestamp <= window.to
      )
        association = 'time_window';
      else {
        coverage.suppressed++;
        reason(coverage, 'outside_window');
        continue;
      }
      // Session evidence still needs this run's time window; an exact run may lack timestamps.
      if (
        association !== 'run' &&
        (parsed.timestamp === undefined ||
          parsed.timestamp < window.from ||
          parsed.timestamp > window.to)
      ) {
        coverage.suppressed++;
        reason(coverage, 'outside_window');
        continue;
      }
      // Explicit local export only: before category filtering and preview sampling.
      options.onExportRecord?.(coverage.source, textRecord, association);
      const metrics: DiagnosticLogRecord['metrics'] = {};
      let signal: DiagnosticLogSignal = 'unknown';
      let basis: DiagnosticLogRecord['basis'];
      for (const fields of parsed.fields) {
        for (const key of METRICS) {
          const alias =
            key === 'statusCode'
              ? 'httpStatus'
              : key === 'requestPayloadBytes'
                ? 'requestBytes'
                : key === 'responseStreamBytes'
                  ? 'responseBytes'
                  : key;
          const value = own(fields, key) ?? own(fields, alias);
          if (isDiagnosticMetricValue(key, value)) metrics[key] = value;
        }
        for (const key of ['errorCategory', 'failureKind', 'signal', 'failoverReason', 'reason']) {
          const value = own(fields, key);
          if (typeof value === 'string' && SIGNALS.includes(value as DiagnosticLogSignal)) {
            signal = value as DiagnosticLogSignal;
            basis = 'error_category';
          } else if (typeof value === 'string' && Object.hasOwn(NATIVE_CATEGORIES, value)) {
            signal = NATIVE_CATEGORIES[value];
            basis = 'error_category';
          }
        }
      }
      const nativeType = parsed.fields
        .map(fields => own(fields, 'type'))
        .find(
          value =>
            typeof value === 'string' &&
            /^(?:model\.call|tool\.execution|exec\.process|harness\.run)\./.test(value),
        );
      let stage: DiagnosticLogRecord['stage'] =
        typeof nativeType !== 'string'
          ? undefined
          : nativeType.startsWith('model.')
            ? 'model'
            : nativeType.startsWith('tool.')
              ? 'tool'
              : nativeType.startsWith('exec.')
                ? 'command'
                : 'runtime';
      const structuredErrorCode = diagnosticErrorCodes.find(code =>
        parsed.fields.some(
          fields =>
            own(fields, 'code') === code ||
            own(fields, 'errorCode') === code ||
            object(own(fields, 'error'))?.code === code,
        ),
      );
      const errorCode =
        structuredErrorCode ??
        (['warn', 'error'].includes(parsed.level)
          ? diagnosticErrorCodes.find(code => new RegExp(`\\b${code}\\b`).test(parsed.hintText))
          : undefined);
      if (errorCode && signal === 'unknown') {
        signal = ['EACCES', 'EPERM'].includes(errorCode)
          ? 'permission'
          : ['ENOENT', 'ENOSPC', 'SQLITE_BUSY', 'SQLITE_FULL'].includes(errorCode)
            ? 'storage'
            : errorCode === 'ETIMEDOUT'
              ? 'timeout'
              : /CERT|SIGNATURE/.test(errorCode)
                ? 'tls'
                : 'network';
        basis = structuredErrorCode ? 'error_category' : 'error_text';
      }
      if (nativeType === 'exec.process.completed') {
        if (parsed.fields.some(fields => own(fields, 'timedOut') === true)) {
          signal = 'timeout';
          basis = 'command_timeout';
        } else if (
          metrics.exitCode !== undefined &&
          Number.isInteger(metrics.exitCode) &&
          metrics.exitCode !== 0
        ) {
          signal = 'tool';
          basis = 'command_exit';
        } else if (
          signal === 'unknown' &&
          parsed.fields.some(fields => own(fields, 'outcome') === 'failed')
        ) {
          signal = 'tool';
          basis = 'command_error';
        }
      }
      // A bare number can be a timestamp, token count or duration, not an HTTP status.
      const successfulCommand =
        nativeType === 'exec.process.completed' &&
        metrics.exitCode === 0 &&
        !parsed.fields.some(
          fields => own(fields, 'timedOut') === true || own(fields, 'outcome') === 'failed',
        );
      const routineNativeEvent =
        successfulCommand ||
        parsed.fields.some(fields =>
          [
            'tool.execution.started',
            'tool.execution.completed',
            'model.call.started',
            'model.call.completed',
          ].includes(String(own(fields, 'type'))),
        );
      // Names and payload summaries on successful calls can contain words such as "auth".
      // Keep timing metrics, but never turn those words into failure evidence.
      if (routineNativeEvent) {
        signal = 'unknown';
        basis = 'routine';
      }
      const textStatus =
        /\b(?:HTTP(?:\/\d(?:\.\d)?)?|status(?:\s+code)?)\s*[:=]?\s*(\d{3})\b/i.exec(
          parsed.hintText,
        );
      if (signal === 'unknown' && !routineNativeEvent) {
        signal =
          httpSignal(metrics.statusCode) ??
          httpSignal(textStatus ? Number(textStatus[1]) : undefined) ??
          signal;
        if (signal !== 'unknown') {
          basis = 'http_status';
          if (metrics.statusCode === undefined && textStatus)
            metrics.statusCode = Number(textStatus[1]);
        }
      }
      if (signal === 'unknown' && !routineNativeEvent) {
        for (const fields of parsed.fields) {
          const type = own(fields, 'type');
          if (typeof type === 'string' && Object.hasOwn(NATIVE_EVENTS, type)) {
            signal = NATIVE_EVENTS[type];
            basis =
              type === 'tool.execution.error'
                ? 'tool_error'
                : type === 'tool.execution.blocked'
                  ? 'tool_blocked'
                  : 'model_error';
          }
        }
      }
      const hint =
        signal === 'unknown' && !routineNativeEvent
          ? HINTS.find(([, regex]) => regex.test(parsed.hintText))
          : undefined;
      if (hint) {
        signal = hint[0];
        basis = ['error', 'warn'].includes(parsed.level) ? 'error_text' : 'keyword';
      }
      const response = !routineNativeEvent
        ? projectResponseLog(parsed.fields, parsed.hintText, parsed.level)
        : undefined;
      if (response) {
        signal = 'provider';
        basis = response.basis;
        stage = 'model';
      }
      if (
        signal === 'unknown' &&
        !hint &&
        !Object.keys(metrics).length &&
        !['error', 'warn'].includes(parsed.level)
      ) {
        coverage.suppressed++;
        reason(coverage, 'no_safe_fields');
        continue;
      }
      if (options.fullScan) {
        coverage.matched = (coverage.matched ?? 0) + 1;
        coverage.signalCounts ??= {};
        coverage.signalCounts[signal] = (coverage.signalCounts[signal] ?? 0) + 1;
        // Scan every record even after preview capacity is exhausted. Keep stronger evidence.
        if (coverage.emitted >= SOURCE_RECORDS) {
          const rank = (level: string, association: string, category: string) =>
            (level === 'error' ? 100 : level === 'warn' ? 50 : 0) +
            (association === 'run' ? 200 : association === 'session' ? 120 : 0) +
            (!['unknown', 'queue', 'retry'].includes(category) ? 5 : 0);
          const candidates = collection.records
            .map((record, index) => ({ record, index }))
            .filter(item => item.record.source === coverage.source)
            .sort(
              (a, b) =>
                rank(a.record.level, a.record.association, a.record.signal) -
                  rank(b.record.level, b.record.association, b.record.signal) ||
                (a.record.timestamp ?? 0) - (b.record.timestamp ?? 0),
            );
          coverage.outputOmitted = (coverage.outputOmitted ?? 0) + 1;
          reason(coverage, 'output_limit');
          const weakest = candidates[0];
          if (
            !weakest ||
            rank(parsed.level, association, signal) <
              rank(weakest.record.level, weakest.record.association, weakest.record.signal)
          )
            continue;
          collection.records.splice(weakest.index, 1);
          coverage.emitted--;
        }
      }
      collection.records.push({
        id: `log-${coverage.source}-${coverage.recordsRead}`,
        source: coverage.source,
        timestamp: parsed.timestamp,
        level: parsed.level,
        association,
        signal,
        inferred: true,
        ...(response ?? {}),
        ...(basis ? { basis } : {}),
        ...(stage ? { stage } : {}),
        ...(!routineNativeEvent && errorCode ? { errorCode } : {}),
        metrics,
      });
      coverage.emitted++;
    }
  };
  for (const source of ['main', 'cowork', 'gateway', 'native'] as const) {
    const coverage: DiagnosticLogCoverage = {
      source,
      status: 'unavailable',
      filesRead: 0,
      bytesRead: 0,
      recordsRead: 0,
      emitted: 0,
      suppressed: 0,
      parseFailures: 0,
      truncated: false,
      reasons: [],
    };
    collection.sources.push(coverage);
    const fullFiles = source === 'native' ? native?.files : sources[source];
    if (options.fullScan && fullFiles) {
      const files = [...new Set(fullFiles)];
      coverage.filesDiscovered = files.length;
      coverage.filesCompleted = 0;
      coverage.scanComplete = files.length > 0;
      coverage.matched = 0;
      coverage.outputOmitted = 0;
      coverage.signalCounts = {};
      if (!files.length) reason(coverage, 'missing');
      for (const file of files) {
        let previousBytes = 0;
        try {
          await scanDiagnosticLog(
            file,
            source === 'native',
            {
              record: text => consume(text, coverage),
              oversized: () => {
                coverage.recordsRead++;
                coverage.parseFailures++;
                reason(coverage, 'malformed');
              },
              progress: (bytes, total) => {
                coverage.bytesRead += bytes - previousBytes;
                totalBytes += bytes - previousBytes;
                previousBytes = bytes;
                options.onProgress?.({
                  source,
                  filesCompleted: collection.sources.reduce(
                    (sum, item) => sum + (item.filesCompleted ?? 0),
                    0,
                  ),
                  bytesRead: totalBytes,
                  fileBytesRead: bytes,
                  fileBytesTotal: total,
                });
              },
            },
            options.signal,
          );
          coverage.filesRead++;
          coverage.filesCompleted++;
        } catch (error) {
          coverage.scanComplete = false;
          const code = (error as NodeJS.ErrnoException).code;
          const message = error instanceof Error ? error.message : '';
          const known = ['unsafe_file', 'source_changed', 'read_timeout', 'canceled'] as const;
          reason(
            coverage,
            known.find(value => value === message) ??
              (code === 'ENOENT' ? 'missing' : 'unreadable'),
          );
          if (options.signal?.aborted) break;
        }
      }
    } else if (source === 'native') {
      if (options.fullScan) coverage.scanComplete = false;
      if (native?.discoveryFailure) reason(coverage, native.discoveryFailure);
      if (!native) {
        reason(coverage, 'native_unavailable');
        continue;
      }
      const accepted: string[] = [];
      for (let index = native.lines.length - 1; index >= 0; index--) {
        const line = native.lines[index];
        const bytes = Buffer.byteLength(line) + 1;
        if (
          Date.now() >= deadline ||
          coverage.bytesRead + bytes > FILE_BYTES ||
          totalBytes + bytes > totalBudget
        ) {
          coverage.truncated = true;
          reason(coverage, 'limit');
          break;
        }
        accepted.push(line);
        coverage.bytesRead += bytes;
        totalBytes += bytes;
      }
      coverage.filesRead = 1;
      coverage.truncated ||= native.truncated === true;
      if (coverage.truncated) reason(coverage, 'limit');
      consume(accepted.reverse().join('\n'), coverage);
    } else {
      const files = [...new Set(sources[source])];
      if (!files.length) reason(coverage, 'missing');
      let sourceFiles = 0;
      for (const file of files) {
        if (
          Date.now() >= deadline ||
          fileCount >= MAX_FILES ||
          totalBytes >= totalBudget ||
          sourceFiles >= SOURCE_FILES ||
          coverage.bytesRead >= sourceBudget
        ) {
          coverage.truncated = true;
          reason(coverage, 'limit');
          break;
        }
        fileCount++;
        sourceFiles++;
        try {
          const tail = await readTailBeforeDeadline(
            file,
            Math.min(fileBudget, totalBudget - totalBytes, sourceBudget - coverage.bytesRead),
            deadline,
          );
          coverage.filesRead++;
          coverage.bytesRead += tail.bytesRead;
          totalBytes += tail.bytesRead;
          coverage.truncated ||= tail.truncated;
          if (tail.truncated) reason(coverage, 'limit');
          consume(tail.text, coverage);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          const message = error instanceof Error ? error.message : '';
          reason(
            coverage,
            message === 'unsafe_file'
              ? 'unsafe_file'
              : message === 'limit'
                ? 'limit'
                : code === 'ENOENT'
                  ? 'missing'
                  : 'unreadable',
          );
          if (message === 'limit') coverage.truncated = true;
        }
      }
    }
    if (coverage.filesRead || coverage.bytesRead)
      coverage.status = coverage.reasons.length ? 'partial' : 'available';
  }
  collection.records.sort(
    (left, right) =>
      (left.timestamp ?? 0) - (right.timestamp ?? 0) ||
      (left.source === right.source
        ? Number(right.id.split('-').at(-1)) - Number(left.id.split('-').at(-1))
        : 0),
  );
  return collection;
}
