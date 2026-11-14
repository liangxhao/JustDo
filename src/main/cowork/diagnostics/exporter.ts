import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';

import yazl from 'yazl';

import { diagnosticSourceHasGaps } from '../../../shared/cowork/diagnostics/diagnosticEvidenceCoverage';
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
import type { SessionDiagnosticsStore } from '../../data/sessionDiagnosticsStore';
import { OPENCLAW_WIRE_VERSION } from '../../engine/openclaw/wire/v2026_10_6';
import {
  DIAGNOSTIC_CONTEXT_FILE,
  type DiagnosticContextEntry,
  type DiagnosticExportContext,
} from './exportContext';
import { diagnosticExportTime, formatDiagnosticJson } from './exportFormat';
import type { DiagnosticExportLogBundle } from './exportLogs';
import { DIAGNOSTIC_ERRORS_FILE, redactDiagnosticLog } from './exportLogs';
import {
  DIAGNOSTIC_PLUGIN_INVENTORY_FILE,
  type DiagnosticPluginInventory,
  serializeDiagnosticPluginInventory,
} from './exportPluginInventory';
import type { DiagnosticExportRequests } from './exportRequests';
import {
  diagnosticDetailText,
  type DiagnosticExportSessionDetails,
  projectDiagnosticExportSessionDetails,
} from './exportSessionDetails';
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

interface DiagnosticDetailEvidence {
  context?: DiagnosticExportContext;
  runs?: ReturnType<SessionDiagnosticsStore['listExportRuns']>;
  requests?: DiagnosticExportRequests;
  requestSessionIdentity?: 'gateway_describe' | 'saved_history_binding' | 'gateway_chat_history';
  plugins?: DiagnosticPluginInventory;
}

/** Defense in depth: aliases for identity and finite values for every exported string. */
export function buildDiagnosticArchive(
  report: DiagnosticReport,
  appVersion: string,
  language: 'zh' | 'en',
  logBundle?: DiagnosticExportLogBundle,
  details?: DiagnosticExportSessionDetails,
  evidence?: DiagnosticDetailEvidence,
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
        collectedAt: diagnosticExportTime(report.runtimeInfo.collectedAt),
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
        collectedAt: diagnosticExportTime(report.logs.collectedAt),
        window: {
          from: diagnosticExportTime(report.logs.window.from),
          to: diagnosticExportTime(report.logs.window.to),
        },
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
          signalCounts:
            source.signalCounts &&
            Object.fromEntries(
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
                return value ? [[signal, value]] : [];
              }),
            ),
          status:
            !diagnosticSourceHasGaps(source) && source.status === 'partial'
              ? 'available'
              : member(source.status, ['available', 'partial', 'unavailable']),
          filesRead: count(source.filesRead),
          bytesRead: count(source.bytesRead),
          recordsRead: count(source.recordsRead),
          emitted: count(source.emitted),
          suppressed: count(source.suppressed),
          parseFailures: count(source.parseFailures),
          truncated: source.truncated || undefined,
          reasons: source.reasons
            .filter(reason => reason !== 'outside_window' && reason !== 'no_safe_fields')
            .slice(0, 12)
            .map(value =>
              member(value, [
                'missing',
                'unreadable',
                'unsafe_file',
                'limit',
                'malformed',
                'native_unavailable',
                'output_limit',
                'source_changed',
                'read_timeout',
                'canceled',
              ]),
            ),
        })),
        records: report.logs.records.slice(0, 400).map(record => {
          const location = locations.get(record.id);
          const metrics = Object.entries(record.metrics).filter(([key, value]) =>
            isDiagnosticMetricValue(key, value),
          );
          return {
            id: alias(record.id),
            source: member(record.source, sources),
            timestamp: diagnosticExportTime(record.timestamp),
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
            basis:
              record.basis === undefined
                ? undefined
                : member(record.basis, [
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
            metrics: metrics.length ? Object.fromEntries(metrics) : undefined,
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
    collectedAt: diagnosticExportTime(report.collectedAt),
    session: alias(report.sessionId),
    run: report.run
      ? {
          id: alias(report.run.id),
          startedAt: diagnosticExportTime(report.run.startedAt),
          endedAt: diagnosticExportTime(report.run.endedAt),
          state: member(report.run.state, ['running', 'completed', 'failed', 'aborted']),
          configuredModel: diagnosticDetailText(details?.runModelRef, 200),
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
      dropped: count(report.coverage.dropped) || undefined,
      collectorDropped: count(report.coverage.collectorDropped) || undefined,
      storageFailed: report.coverage.storageFailed || undefined,
      firstObservedAt: diagnosticExportTime(report.coverage.firstObservedAt),
    },
    connection: member(report.connection, ['connected', 'offline']),
    runtimeInfo,
    environment:
      report.environment.status === 'not_requested'
        ? undefined
        : {
            scope: 'global',
            status: member(report.environment.status, [
              'not_requested',
              'available',
              'unavailable',
            ]),
            collectedAt: diagnosticExportTime(report.environment.collectedAt),
            stabilityCount: count(report.environment.stabilityCount),
            stabilityDropped: count(report.environment.stabilityDropped),
            firstAt: diagnosticExportTime(report.environment.firstAt),
            lastAt: diagnosticExportTime(report.environment.lastAt),
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
      observedAt: diagnosticExportTime(event.observedAt),
      occurredAt: diagnosticExportTime(event.occurredAt),
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
  const sessionDetails = details
    ? projectDiagnosticExportSessionDetails(details, alias)
    : undefined;
  const extraEntries: Record<string, string> = {};
  const sessionContext = evidence?.context && {
    ...evidence.context.coverage,
    file: evidence.context.entry ? DIAGNOSTIC_CONTEXT_FILE : undefined,
  };
  if (evidence?.plugins) {
    extraEntries[DIAGNOSTIC_PLUGIN_INVENTORY_FILE] = serializeDiagnosticPluginInventory(
      evidence.plugins,
    );
  }
  const turnReceipts = evidence?.runs && {
    scope: 'conversation_at_export',
    limited: evidence.runs.limited,
    turns: evidence.runs.runs.map(run => ({
      id: alias(run.id),
      nativeRuns: run.nativeRunIds.map(alias),
      startedAt: diagnosticExportTime(run.startedAt),
      acceptedAt: diagnosticExportTime(run.acceptedAt),
      endedAt: diagnosticExportTime(run.endedAt),
      savedStatus: member(run.state, ['running', 'completed', 'failed', 'aborted']),
      configuredModel: diagnosticDetailText(run.configuredModel, 200),
    })),
  };
  const requestEvidence = evidence?.requests?.finish(alias);
  const requests = requestEvidence && {
    ...requestEvidence,
    calls: requestEvidence.calls.map(call => ({
      ...call,
      startedAt: diagnosticExportTime(call.startedAt),
      endedAt: diagnosticExportTime(call.endedAt),
    })),
    fallbackDecisions: requestEvidence.fallbackDecisions.map(decision => ({
      ...decision,
      at: diagnosticExportTime(decision.at),
    })),
    physicalSessionIdentitySource: evidence?.requestSessionIdentity,
  };
  const pluginInventory = evidence?.plugins && {
    file: DIAGNOSTIC_PLUGIN_INVENTORY_FILE,
  };
  const pluginGaps = evidence?.plugins && (() => {
    const { scope: _scope, collectedAt: _collectedAt, ...sources } = evidence.plugins;
    return Object.values(sources).filter(source =>
      source.status === 'unavailable' || source.gaps.some(gap => gap !== 'local_discovery_only'),
    ).length;
  })();
  const sessionTextMayIncludeTaskContent = Boolean(
    sessionDetails?.title ||
    sessionDetails?.workingDirectory ||
    sessionDetails?.groupName ||
    sessionDetails?.configuredModel ||
    sessionDetails?.usage?.models?.length ||
    safe.run?.configuredModel,
  );
  const hasFailureExcerpts = Boolean(report.history?.failures.length);
  const archive = {
    formatVersion: 5,
    redactionVersion: 2,
    appVersion: /^v?\d+(\.\d+){1,3}$/.test(appVersion) ? appVersion : 'unknown',
    files: [
      'summary.md',
      'report.json',
      ...(sessionContext?.file ? [sessionContext.file] : []),
      ...Object.keys(extraEntries),
      ...Object.keys(logEntries),
    ],
    sources: [
      'local_run_metadata',
      ...(sessionDetails ? ['local_session_metadata'] : []),
      ...(sessionDetails?.usage ? ['gateway_session_usage'] : []),
      ...(sessionContext?.file ? ['gateway_chat_history'] : []),
      ...(requestEvidence?.calls.length || requestEvidence?.fallbackDecisions.length
        ? ['native_model_call_logs']
        : []),
      ...(pluginInventory ? ['plugin_inventory'] : []),
      ...(report.environment.status === 'available' ? ['global_environment_snapshot'] : []),
      ...(logs ? ['sanitized_log_evidence'] : []),
    ],
    rawLogsIncluded: hasLogText,
    errorLog: errorRecords
      ? { file: DIAGNOSTIC_ERRORS_FILE, records: errorRecords, ranges: errorRanges }
      : undefined,
    exportedLogCoverage: logBundle?.coverage,
    transcriptsIncluded: Boolean(sessionContext?.messages),
    conversationFailureExcerptsIncluded: hasFailureExcerpts,
    ...(sessionDetails ? { sessionTextMayIncludeTaskContent } : {}),
    identifiersAliased:
      !hasLogText &&
      !hasFailureExcerpts &&
      !sessionTextMayIncludeTaskContent &&
      !sessionContext?.file &&
      !pluginInventory,
    metadataIdentifiersAliased: true,
    localTimestampAssumption: logs
      ? 'collector_local_timezone_historical_offset_unverified'
      : undefined,
  };
  const history = report.history
    ? {
        status: report.history.status,
        reason:
          report.history.reason === undefined
            ? undefined
            : member(report.history.reason, [
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
              timestamp: diagnosticExportTime(report.history.lastResponse.timestamp),
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
          timestamp: diagnosticExportTime(failure.timestamp),
          kind: failure.kind,
          tool: failure.tool ? redactDiagnosticLog(failure.tool).slice(0, 100) : undefined,
          excerpt: redactDiagnosticLog(failure.excerpt).slice(0, 1600),
          clipped: failure.clipped,
          association: failure.association,
          basis: member(failure.basis, ['activity', 'result', 'model', 'failure_receipt']),
          cause:
            failure.cause === undefined
              ? undefined
              : member(failure.cause, [
                  'state_contention',
                  DiagnosticRuntimeFailure.ReplayAdmissionRejected,
                ]),
          outcome:
            failure.outcome === undefined
              ? undefined
              : member(failure.outcome, ['failed', 'blocked', 'aborted']),
        })),
      }
    : undefined;
  return {
    'summary.md': buildDiagnosticSummary(
      report,
      language,
      alias,
      logBundle,
      errorRecords,
      sessionDetails,
      evidence
        ? {
            context: sessionContext,
            pluginsFile: pluginInventory?.file,
            calls: requestEvidence?.calls.length,
            turns: turnReceipts?.turns.length,
            callOmitted: requestEvidence?.coverage.callObservationsOmitted,
            fallbackOmitted: requestEvidence?.coverage.fallbackObservationsOmitted,
            turnsLimited: turnReceipts?.limited,
            pluginGaps,
          }
        : undefined,
    ),
    'report.json': formatDiagnosticJson({
      ...safe,
      sessionDetails: sessionDetails && {
        ...sessionDetails,
        collectedAt: diagnosticExportTime(sessionDetails.collectedAt),
        createdAt: diagnosticExportTime(sessionDetails.createdAt),
        updatedAt: diagnosticExportTime(sessionDetails.updatedAt),
        usage: sessionDetails.usage && {
          ...sessionDetails.usage,
          lastActivity: diagnosticExportTime(sessionDetails.usage.lastActivity),
        },
      },
      sessionContext,
      turnReceipts,
      requests,
      pluginInventory,
      archive,
      history,
      logs,
    }),
    ...extraEntries,
    ...logEntries,
    ...(evidence?.context?.entry ? { [DIAGNOSTIC_CONTEXT_FILE]: evidence.context.entry } : {}),
  };
}

const HARD_LINK_UNAVAILABLE_CODES = new Set(['EPERM', 'EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);

/** Finish the temporary ZIP before publishing it to the user's chosen path. */
export async function writeDiagnosticArchive(
  destination: string,
  entries: Record<string, string | DiagnosticContextEntry>,
  assertCurrent: () => void,
  options: { signal?: AbortSignal; replaceExisting?: boolean } = {},
): Promise<void> {
  const { signal, replaceExisting = true } = options;
  signal?.throwIfAborted();
  const bytes = Object.values(entries).reduce(
    (total, value) => total + (typeof value === 'string' ? Buffer.byteLength(value) : 0),
    0,
  );
  if (bytes > 24 * 1024 * 1024) throw new Error('size');
  const temporary = path.join(path.dirname(destination), `.diagnostics-${randomUUID()}.tmp`);
  const zip = new yazl.ZipFile();
  const zipStream = zip.outputStream as Readable;
  const outputFile = await fs.promises.open(temporary, 'wx', 0o600);
  const output = outputFile.createWriteStream();
  zip.on('error', error => zipStream.destroy(error));
  let input: Readable | undefined;
  let inputClosed: Promise<void> | undefined;
  const idle = new AbortController();
  const writeSignal = signal ? AbortSignal.any([signal, idle.signal]) : idle.signal;
  let lastBytesWritten = output.bytesWritten;
  let lastWrite = Date.now();
  const watchdog = setInterval(() => {
    if (output.bytesWritten !== lastBytesWritten) {
      lastBytesWritten = output.bytesWritten;
      lastWrite = Date.now();
    } else if (Date.now() - lastWrite >= 60_000) {
      idle.abort(new Error('Diagnostic archive write stalled'));
    }
  }, 5_000);
  watchdog.unref();
  const writing = pipeline(zipStream, output, { signal: writeSignal });
  try {
    for (const [name, content] of Object.entries(entries)) {
      if (typeof content === 'string') {
        zip.addBuffer(Buffer.from(content), name);
      } else {
        zip.addReadStreamLazy(name, { size: content.bytes }, callback => {
          if (writeSignal.aborted || zipStream.destroyed) {
            callback(new Error('Diagnostic export stopped'), undefined!);
            return;
          }
          try {
            const stream = content.open();
            input = stream;
            stream.on('error', error => zipStream.destroy(error));
            inputClosed = new Promise(resolve => stream.once('close', resolve));
            callback(null, stream);
          } catch (error) {
            zipStream.destroy(
              error instanceof Error ? error : new Error('Cannot open diagnostic context'),
            );
          }
        });
      }
    }
    zip.end();
    await writing;
    writeSignal.throwIfAborted();
    assertCurrent();
    if (replaceExisting) {
      await fs.promises.rename(temporary, destination);
      return;
    }
    try {
      await fs.promises.link(temporary, destination);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !HARD_LINK_UNAVAILABLE_CODES.has(code)) throw error;
      writeSignal.throwIfAborted();
      assertCurrent();
      await fs.promises.copyFile(temporary, destination, fs.constants.COPYFILE_EXCL);
    }
  } finally {
    clearInterval(watchdog);
    input?.destroy();
    zipStream.destroy();
    output.destroy();
    await writing.catch(() => {});
    await inputClosed;
    await finished(output).catch(() => {});
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
  }
}
