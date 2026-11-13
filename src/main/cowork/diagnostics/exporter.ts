import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import yazl from 'yazl';

import { buildDiagnosticFindings } from '../../../shared/cowork/diagnostics/diagnosticFindings';
import {
  diagnosticErrorCodes,
  diagnosticOperations,
  diagnosticStages,
  isDiagnosticMetricValue,
} from '../../../shared/cowork/diagnostics/diagnosticLogDetails';
import { DiagnosticRuntimeFailure } from '../../../shared/cowork/diagnostics/diagnosticRuntimeFailure';
import {
  projectDiagnosticGatewayInfo,
  projectDiagnosticRuntimeArtifact,
} from '../../../shared/cowork/diagnostics/diagnosticRuntimeInfo';
import { assessDiagnosticStop } from '../../../shared/cowork/diagnostics/diagnosticStop';
import {
  type DiagnosticLogRecord,
  type DiagnosticLogSource,
  DiagnosticReason,
  type DiagnosticReport,
  diagnosticResponseIssues,
  diagnosticTimeoutPhases,
} from '../../../shared/cowork/diagnostics/sessionDiagnostics';
import { OPENCLAW_WIRE_VERSION } from '../../engine/openclaw/wire/v2026_10_6';
import type { DiagnosticExportLogBundle } from './exportLogs';
import { DIAGNOSTIC_ERRORS_FILE, redactDiagnosticLog } from './exportLogs';
import { buildDiagnosticSummary } from './exportSummary';

const member = (value: unknown, values: readonly string[], fallback = 'unknown'): string =>
  typeof value === 'string' && values.includes(value) ? value : fallback;
const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const boolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

interface ErrorLogRange {
  source: DiagnosticLogSource;
  association: DiagnosticLogRecord['association'];
  line: number;
  endLine: number;
}

/** Defense in depth: aliases for identity and finite values for every exported string. */
export function buildDiagnosticArchive(
  report: DiagnosticReport,
  appVersion: string,
  language: 'zh' | 'en',
  logBundle?: DiagnosticExportLogBundle,
) {
  const aliases = new Map<string, string>();
  const alias = (value: unknown): string | undefined => {
    if (typeof value !== 'string' || !value) return;
    if (!aliases.has(value)) aliases.set(value, `id-${aliases.size + 1}`);
    return aliases.get(value);
  };
  const reason = member(report.conclusion.reason, Object.values(DiagnosticReason));
  const runtimeInfo = report.runtimeInfo
    ? {
        scope: 'collection_environment',
        collectedAt: count(report.runtimeInfo.collectedAt),
        wireVersion: member(report.runtimeInfo.wireVersion, [OPENCLAW_WIRE_VERSION]),
        gateway: {
          status: member(report.runtimeInfo.gateway.status, ['connected', 'offline', 'changed']),
          ...(report.runtimeInfo.gateway.status === 'connected'
            ? projectDiagnosticGatewayInfo({
                server: report.runtimeInfo.gateway,
                protocol: report.runtimeInfo.gateway.protocol,
              })
            : {}),
        },
        installedArtifact: report.runtimeInfo.installedArtifact
          ? projectDiagnosticRuntimeArtifact(report.runtimeInfo.installedArtifact)
          : undefined,
      }
    : undefined;
  const sources = ['main', 'cowork', 'gateway', 'native'] as const;
  const logEntries: Record<string, string> = {};
  for (const file of [DIAGNOSTIC_ERRORS_FILE, ...sources.map(source => `logs/${source}.log`)]) {
    const content = logBundle?.entries[file];
    if (content?.trim()) logEntries[file] = content;
  }
  const hasLogText = Object.keys(logEntries).length > 0;
  const locations = new Map<
    string,
    { source: string; file: string; line: number; endLine: number }
  >();
  const errorRanges: ErrorLogRange[] = [];
  let errorRecords = 0;
  for (const { id, source, association, file, line, endLine } of logBundle?.index ?? []) {
    if (
      (file === DIAGNOSTIC_ERRORS_FILE || file === `logs/${source}.log`) &&
      Object.hasOwn(logEntries, file) &&
      id.startsWith(`log-${source}-`) &&
      /^log-\w+-\d+$/.test(id) &&
      Number.isSafeInteger(line) &&
      line > 0 &&
      Number.isSafeInteger(endLine) &&
      endLine >= line
    ) {
      locations.set(id, { source, file, line, endLine });
      if (
        file === DIAGNOSTIC_ERRORS_FILE &&
        sources.includes(source) &&
        ['run', 'session', 'time_window'].includes(association)
      ) {
        errorRecords++;
        const previous = errorRanges.at(-1);
        if (
          previous?.source === source &&
          previous.association === association &&
          previous.endLine + 1 === line
        ) {
          previous.endLine = endLine;
        } else {
          errorRanges.push({ source, association, line, endLine });
        }
      }
    }
  }
  const logs = report.logs
    ? {
        scanMode: member(report.logs.scanMode, ['full_files', 'tail']),
        collectedAt: count(report.logs.collectedAt),
        window: { from: count(report.logs.window.from), to: count(report.logs.window.to) },
        partial: true,
        localTimezoneOffsetMinutes:
          Number.isInteger(report.logs.localTimezoneOffsetMinutes) &&
          Math.abs(report.logs.localTimezoneOffsetMinutes) <= 1440
            ? report.logs.localTimezoneOffsetMinutes
            : undefined,
        sources: report.logs.sources.slice(0, 4).map(source => ({
          source: member(source.source, sources),
          scanComplete: boolean(source.scanComplete),
          filesDiscovered: count(source.filesDiscovered),
          filesCompleted: count(source.filesCompleted),
          matched: count(source.matched),
          outputOmitted: count(source.outputOmitted),
          signalCounts: Object.fromEntries(
            [
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
            ].flatMap(signal => {
              const value = count(
                source.signalCounts?.[signal as keyof NonNullable<typeof source.signalCounts>],
              );
              return value === undefined ? [] : [[signal, value]];
            }),
          ),
          status: member(source.status, ['available', 'partial', 'unavailable']),
          filesRead: count(source.filesRead),
          bytesRead: count(source.bytesRead),
          recordsRead: count(source.recordsRead),
          emitted: count(source.emitted),
          suppressed: count(source.suppressed),
          parseFailures: count(source.parseFailures),
          truncated: source.truncated === true,
          reasons: source.reasons
            .slice(0, 12)
            .map(value =>
              member(value, [
                'missing',
                'unreadable',
                'unsafe_file',
                'limit',
                'malformed',
                'native_unavailable',
                'outside_window',
                'no_safe_fields',
                'output_limit',
                'source_changed',
                'read_timeout',
                'canceled',
              ]),
            ),
        })),
        records: report.logs.records.slice(0, 400).map(record => {
          const location = locations.get(record.id);
          return {
            id: alias(record.id),
            source: member(record.source, sources),
            timestamp: count(record.timestamp),
            level: member(record.level, ['error', 'warn', 'info', 'debug', 'unknown']),
            association: member(record.association, ['run', 'session', 'time_window']),
            signal: member(record.signal, [
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
            ]),
            stage: record.stage === undefined ? undefined : member(record.stage, diagnosticStages),
            errorCode:
              record.errorCode === undefined
                ? undefined
                : member(record.errorCode, diagnosticErrorCodes),
            inferred: record.inferred !== false,
            responseIssue:
              record.responseIssue === undefined
                ? undefined
                : member(record.responseIssue, diagnosticResponseIssues),
            responseRecovery:
              record.responseRecovery === undefined
                ? undefined
                : member(record.responseRecovery, ['retrying', 'exhausted']),
            basis: member(record.basis, [
              'error_category',
              'http_status',
              'tool_error',
              'tool_blocked',
              'model_error',
              'error_text',
              'keyword',
              'command_exit',
              'command_timeout',
              'command_error',
              'routine',
            ]),
            metrics: Object.fromEntries(
              [
                'statusCode',
                'attempt',
                'durationMs',
                'queueDepth',
                'exitCode',
                'waitMs',
                'timeToFirstByteMs',
                'requestPayloadBytes',
                'responseStreamBytes',
              ].flatMap(key => {
                const value = record.metrics[key as keyof typeof record.metrics];
                return isDiagnosticMetricValue(key, value) ? [[key, value]] : [];
              }),
            ),
            location:
              location?.source === record.source
                ? { file: location.file, line: location.line, endLine: location.endLine }
                : undefined,
          };
        }),
      }
    : undefined;
  const stop = assessDiagnosticStop(report);
  const safe = {
    stopAssessment: {
      modelReplyEnded: boolean(stop.modelReplyEnded),
      reason: member(stop.reason, [
        ...Object.values(DiagnosticReason),
        ...diagnosticResponseIssues,
      ]),
      basis: member(stop.basis, ['terminal', 'history', 'log', 'unknown']),
      confidence: member(stop.confidence, ['confirmed', 'observed', 'unknown']),
      eventIds: stop.eventIds.map(alias),
      logIds: stop.logIds.map(alias),
      timeoutPhase:
        stop.timeoutPhase === undefined
          ? undefined
          : member(stop.timeoutPhase, diagnosticTimeoutPhases),
      outputIssue:
        stop.outputIssue === undefined
          ? undefined
          : member(stop.outputIssue, diagnosticResponseIssues),
      outputLimited: boolean(stop.outputLimited),
      recoveryExhausted: boolean(stop.recoveryExhausted),
    },
    version: 1,
    collectedAt: count(report.collectedAt),
    session: alias(report.sessionId),
    run: report.run
      ? {
          id: alias(report.run.id),
          startedAt: count(report.run.startedAt),
          endedAt: count(report.run.endedAt),
          state: member(report.run.state, ['running', 'completed', 'failed', 'aborted']),
        }
      : undefined,
    conclusion: {
      reason,
      confidence: member(report.conclusion.confidence, ['confirmed', 'unknown']),
      evidence: report.conclusion.evidenceIds.slice(0, 232).map(alias),
      toolFailures: count(report.conclusion.toolFailures),
    },
    findings: buildDiagnosticFindings(report).map(finding => ({
      signal: finding.signal,
      association: finding.association,
      evidence: [...finding.eventIds, ...finding.logIds].map(alias),
    })),
    coverage: {
      partial: true,
      dropped: count(report.coverage.dropped),
      collectorDropped: count(report.coverage.collectorDropped),
      storageFailed: report.coverage.storageFailed === true,
      firstObservedAt: count(report.coverage.firstObservedAt),
    },
    connection: member(report.connection, ['connected', 'offline']),
    runtimeInfo,
    environment: {
      scope: 'global',
      status: member(report.environment.status, ['not_requested', 'available', 'unavailable']),
      collectedAt: count(report.environment.collectedAt),
      stabilityCount: count(report.environment.stabilityCount),
      stabilityDropped: count(report.environment.stabilityDropped),
      firstAt: count(report.environment.firstAt),
      lastAt: count(report.environment.lastAt),
      signals: Object.fromEntries(
        ['model', 'tool', 'blocked', 'command', 'stuck', 'liveness'].flatMap(key => {
          const value = count(
            report.environment.signals?.[
              key as keyof NonNullable<DiagnosticReport['environment']['signals']>
            ],
          );
          return value === undefined ? [] : [[key, value]];
        }),
      ),
    },
    events: report.events.slice(0, 232).map(event => ({
      id: alias(event.id),
      run: alias(event.runId),
      nativeRun: alias(event.nativeRunId),
      generation: alias(event.generation),
      epoch: alias(event.epoch),
      sequence: count(event.sequence),
      observedAt: count(event.observedAt),
      occurredAt: count(event.occurredAt),
      timeoutPhase:
        event.timeoutPhase === undefined
          ? undefined
          : member(event.timeoutPhase, diagnosticTimeoutPhases),
      responseIssue:
        event.responseIssue === undefined
          ? undefined
          : member(event.responseIssue, diagnosticResponseIssues),
      replyDisposition:
        event.replyDisposition === undefined
          ? undefined
          : member(event.replyDisposition, ['visible', 'silent', 'empty']),
      errorCode:
        event.errorCode === undefined ? undefined : member(event.errorCode, diagnosticErrorCodes),
      runtimeFailure:
        event.runtimeFailure === DiagnosticRuntimeFailure.ReplayAdmissionRejected
          ? event.runtimeFailure
          : undefined,
      statusCode:
        typeof event.statusCode === 'number' &&
        Number.isInteger(event.statusCode) &&
        event.statusCode >= 400 &&
        event.statusCode <= 599
          ? event.statusCode
          : undefined,
      durationMs:
        typeof event.durationMs === 'number' &&
        Number.isFinite(event.durationMs) &&
        event.durationMs >= 0 &&
        event.durationMs <= 1e12
          ? event.durationMs
          : undefined,
      kind: member(event.kind, ['lifecycle', 'chat', 'tool', 'command', 'connection', 'cancel']),
      phase: member(event.phase, [
        'start',
        'finishing',
        'end',
        'error',
        'final',
        'aborted',
        'connected',
        'disconnected',
        'requested',
        'acknowledged',
        'failed',
      ]),
      stopReason: member(event.stopReason, [
        'stop',
        'end_turn',
        'completed',
        'length',
        'max_tokens',
        'aborted',
        'timeout',
        'restart',
        'superseded',
        'error',
      ]),
      errorCategory: member(event.errorCategory, [
        'auth',
        'rate_limit',
        'billing',
        'timeout',
        'network',
        'context',
        'provider',
      ]),
      executionSettled: boolean(event.executionSettled),
      aborted: boolean(event.aborted),
      yielded: boolean(event.yielded),
      providerStarted: boolean(event.providerStarted),
      userInitiated: boolean(event.userInitiated),
      toolFailed: boolean(event.toolFailed),
      operation:
        event.operation === undefined ? undefined : member(event.operation, diagnosticOperations),
      toolValidationFailed: boolean(event.toolValidationFailed),
      exitCode: isDiagnosticMetricValue('exitCode', event.exitCode) ? event.exitCode : undefined,
    })),
  };
  const hasFailureExcerpts = Boolean(report.history?.failures.length);
  const archive = {
    formatVersion: 3,
    redactionVersion: 2,
    appVersion: /^v?\d+(\.\d+){1,3}$/.test(appVersion) ? appVersion : 'unknown',
    files: ['summary.md', 'report.json', ...Object.keys(logEntries)],
    sources: [
      'local_run_metadata',
      ...(report.environment.status === 'available' ? ['global_environment_snapshot'] : []),
      ...(logs ? ['sanitized_log_evidence'] : []),
    ],
    rawLogsIncluded: hasLogText,
    logCredentialsMasked: hasLogText,
    logTextMayIncludeTaskContent: hasLogText,
    errorLog: errorRecords
      ? { file: DIAGNOSTIC_ERRORS_FILE, records: errorRecords, ranges: errorRanges }
      : undefined,
    exportedLogCoverage: logBundle?.coverage,
    transcriptsIncluded: false,
    conversationFailureExcerptsIncluded: hasFailureExcerpts,
    identifiersAliased: !hasLogText && !hasFailureExcerpts,
    metadataIdentifiersAliased: true,
    limits: {
      localFiles: report.logs?.scanMode === 'full_files' ? 'all_discovered' : 16,
      localBytes:
        report.logs?.scanMode === 'full_files'
          ? 'all_discovered'
          : report.run?.endedAt !== undefined
            ? 13631488
            : 4194304,
      fileBytes:
        report.logs?.scanMode === 'full_files'
          ? 'captured_file_size'
          : report.run?.endedAt !== undefined
            ? 4194304
            : 524288,
      recordBytes: 65536,
      outputRecords: 400,
      nativeLines: 1000,
      nativeBytes: report.logs?.sources.some(
        source => source.source === 'native' && source.filesDiscovered !== undefined,
      )
        ? 'captured_file_size'
        : 524288,
      sourceFiles: report.logs?.scanMode === 'full_files' ? 'all_discovered' : 4,
      sourceBytes:
        report.logs?.scanMode === 'full_files'
          ? 'all_discovered'
          : report.run?.endedAt !== undefined
            ? 4194304
            : 1048576,
      sourceRecords: 100,
    },
    localTimestampAssumption: 'collector_local_timezone_historical_offset_unverified',
  };
  const history = report.history
    ? {
        status: report.history.status,
        reason: member(report.history.reason, [
          'offline',
          'no_run',
          'no_binding',
          'canceled',
          'timeout',
          'read_failed',
          'page_limit',
          'history_changed',
        ]),
        messagesScanned: report.history.messagesScanned,
        omitted: report.history.omitted,
        lastResponse: report.history.lastResponse
          ? {
              endTurn: boolean(report.history.lastResponse.endTurn),
              timestamp: count(report.history.lastResponse.timestamp),
              association: member(report.history.lastResponse.association, ['run', 'run_window']),
              thinking: boolean(report.history.lastResponse.thinking),
              text: boolean(report.history.lastResponse.text),
              toolCall: boolean(report.history.lastResponse.toolCall),
              other: boolean(report.history.lastResponse.other),
              complete: boolean(report.history.lastResponse.complete),
              stopReason: member(report.history.lastResponse.stopReason, [
                'stop',
                'end_turn',
                'length',
                'max_tokens',
                'toolUse',
                'error',
                'aborted',
                'unknown',
              ]),
            }
          : undefined,
        failures: report.history.failures.slice(0, 40).map(failure => ({
          timestamp: failure.timestamp,
          kind: failure.kind,
          tool: failure.tool ? redactDiagnosticLog(failure.tool).slice(0, 100) : undefined,
          excerpt: redactDiagnosticLog(failure.excerpt).slice(0, 1600),
          clipped: failure.clipped,
          association: failure.association,
          basis: member(failure.basis, ['activity', 'result', 'model', 'failure_receipt']),
          cause: member(failure.cause, [
            'state_contention',
            DiagnosticRuntimeFailure.ReplayAdmissionRejected,
          ]),
          outcome: member(failure.outcome, ['failed', 'blocked', 'aborted']),
        })),
      }
    : undefined;
  return {
    'summary.md': buildDiagnosticSummary(report, language, alias, logBundle, errorRecords),
    'report.json': JSON.stringify({ ...safe, archive, history, logs }, null, 2),
    ...logEntries,
  };
}

/** Write only a fresh temporary file until complete; never unlink the user's target on failure. */
export async function writeDiagnosticArchive(
  destination: string,
  entries: Record<string, string>,
  assertCurrent: () => void,
): Promise<void> {
  const bytes = Object.values(entries).reduce(
    (total, value) => total + Buffer.byteLength(value),
    0,
  );
  if (bytes > 10 * 1024 * 1024) throw new Error('size');
  const temporary = path.join(path.dirname(destination), `.diagnostics-${randomUUID()}.tmp`);
  const zip = new yazl.ZipFile();
  const output = fs.createWriteStream(temporary, { flags: 'wx' });
  zip.on('error', error => (zip.outputStream as import('node:stream').Readable).destroy(error));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const writing = pipeline(zip.outputStream, output, { signal: controller.signal });
    for (const [name, content] of Object.entries(entries))
      zip.addBuffer(Buffer.from(content), name);
    zip.end();
    await writing;
    assertCurrent();
    await fs.promises.rename(temporary, destination);
  } finally {
    clearTimeout(timer);
    output.destroy();
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
  }
}
