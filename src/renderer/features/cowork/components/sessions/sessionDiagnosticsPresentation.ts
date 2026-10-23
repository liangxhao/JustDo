import { assessDiagnosticCoverage } from '@shared/cowork/diagnostics/diagnosticEvidenceCoverage';
import {
  buildDiagnosticFindings,
  type DiagnosticFinding,
} from '@shared/cowork/diagnostics/diagnosticFindings';
import { diagnoseHistoryFailure } from '@shared/cowork/diagnostics/diagnosticHistoryFindings';
import { DiagnosticRuntimeFailure } from '@shared/cowork/diagnostics/diagnosticRuntimeFailure';
import { assessDiagnosticStop } from '@shared/cowork/diagnostics/diagnosticStop';
import type {
  DiagnosticEvent,
  DiagnosticExportSummary,
  DiagnosticLogRecord,
  DiagnosticReport,
} from '@shared/cowork/diagnostics/sessionDiagnostics';

import { i18nService } from '@/services/i18n';

const t = (key: string) => i18nService.t(key);

export function presentDiagnosticRuntimeFailure(event: DiagnosticEvent) {
  if (
    (event.kind !== 'lifecycle' && event.kind !== 'chat') ||
    event.phase !== 'error' ||
    event.runtimeFailure !== DiagnosticRuntimeFailure.ReplayAdmissionRejected
  )
    return;
  return {
    title: t('diagnosticsRuntimeFailure_replay_admission_rejected'),
    adviceKey: 'diagnosticsHistoryAdvice_replay_admission_rejected',
  };
}

export function presentDiagnosticStop(report: DiagnosticReport) {
  const assessment = assessDiagnosticStop(report);
  const explained =
    !!assessment.modelReplyEnded || !['completed', 'unknown'].includes(assessment.reason);
  const certainty =
    !explained || assessment.basis === 'unknown'
      ? 'unknown'
      : assessment.basis === 'terminal'
        ? 'confirmed'
        : 'observed';
  const incomplete = assessDiagnosticCoverage(report).hasGaps;
  const title = assessment.modelReplyEnded
    ? t('diagnosticsModelReplyEnded')
    : ['reasoning_only', 'empty_response', 'incomplete_response'].includes(assessment.reason)
      ? t(`diagnosticsStop_${assessment.reason}`)
      : t(`diagnosticsReason_${assessment.reason}`);
  return {
    ...assessment,
    certainty,
    incomplete,
    title,
    details: [
      t(
        assessment.modelReplyEnded
          ? 'diagnosticsModelReplyEndedEvidence'
          : assessment.reason === 'completed'
            ? 'diagnosticsStopBasis_completed'
            : `diagnosticsStopBasis_${assessment.basis}`,
      ),
      ...(assessment.timeoutPhase ? [t(`diagnosticsTimeout_${assessment.timeoutPhase}`)] : []),
      ...(assessment.outputIssue && assessment.outputIssue !== assessment.reason
        ? [t(`diagnosticsStop_${assessment.outputIssue}`)]
        : []),
      ...(assessment.outputLimited ? [t('diagnosticsStopOutputLimit')] : []),
      ...(assessment.recoveryExhausted ? [t('diagnosticsStopRetriesExhausted')] : []),
    ],
    advice: t(
      assessment.modelReplyEnded
        ? 'diagnosticsModelReplyEndedAdvice'
        : `diagnosticsStopAdvice_${assessment.reason}`,
    ),
  };
}

export function summarizeDiagnosticStop(report: DiagnosticReport) {
  const stop = presentDiagnosticStop(report);
  return [
    t('diagnosticsStopTitle'),
    stop.title,
    t(`diagnosticsAnswer_${stop.certainty}`),
    ...(stop.incomplete ? [t('diagnosticsAnswerIncomplete')] : []),
    ...stop.details,
    stop.advice,
  ].join('\n');
}
/** Keep the report and clipboard consistent when stored errors replace generic markers. */
export function visibleDiagnosticFindings(report: DiagnosticReport): DiagnosticFinding[] {
  return buildDiagnosticFindings(report).filter(
    finding =>
      !(
        finding.signal === 'tool' &&
        presentDiagnosticFinding(finding, report).toolLimit &&
        finding.eventIds.every(id => {
          const event = report.events.find(item => item.id === id);
          return (
            event &&
            (report.history?.failures ?? []).some(
              failure =>
                failure.kind === 'tool' &&
                Math.abs(failure.timestamp - (event.occurredAt ?? event.observedAt)) <= 1000,
            )
          );
        })
      ),
  );
}

export const formatDiagnosticTime = (time: number) =>
  new Date(time).toLocaleString(i18nService.getLanguage() === 'zh' ? 'zh-CN' : 'en-US');

function adviceFor(
  signal: DiagnosticFinding['signal'],
  code?: string,
  stage?: DiagnosticLogRecord['stage'],
  basis?: DiagnosticLogRecord['basis'],
): string {
  if (code) return `diagnosticsRemedy_${code}`;
  if (basis === 'command_exit' || basis === 'command_timeout' || basis === 'command_error')
    return `diagnosticsRemedy_${basis}`;
  if (
    stage !== 'model' &&
    ['auth', 'rate_limit', 'billing', 'provider', 'network'].includes(signal)
  )
    return `diagnosticsRemedy_service_${signal}`;
  return `diagnosticsAdvice_${signal}`;
}

/** One evidence projection for the report and clipboard, retaining association limits. */
export function presentDiagnosticFinding(finding: DiagnosticFinding, report: DiagnosticReport) {
  const groups = new Map<
    string,
    {
      time?: number;
      description: string;
      sources: Set<string>;
      count: number;
      detail: number;
      adviceKey?: string;
    }
  >();
  const add = (
    time: number | undefined,
    description: string,
    source: string,
    detail = 0,
    adviceKey?: string,
  ) => {
    // Group identical projections displayed within the same second; never claim distinct failures.
    const key = JSON.stringify([
      time === undefined ? undefined : Math.floor(time / 1000),
      description,
    ]);
    const previous = groups.get(key);
    if (previous) {
      previous.count++;
      previous.sources.add(source);
    } else
      groups.set(key, {
        time,
        description,
        sources: new Set([source]),
        count: 1,
        detail,
        adviceKey,
      });
  };
  for (const id of finding.eventIds) {
    const event = report.events.find(item => item.id === id)!;
    const runtimeFailure = presentDiagnosticRuntimeFailure(event);
    let description = event.responseIssue
      ? t(`diagnosticsResponseEvidence_${event.responseIssue}`)
      : event.toolValidationFailed
        ? t('diagnosticsInvalidToolArguments')
        : event.kind === 'command'
          ? t(
              event.stopReason === 'timeout'
                ? 'diagnosticsEvidenceBasis_command_timeout'
                : event.exitCode !== undefined && event.exitCode !== 0
                  ? 'diagnosticsEvidenceBasis_command_exit'
                  : 'diagnosticsEvidenceBasis_command_error',
            )
          : event.toolFailed
            ? t('diagnosticsEvidenceToolFailed')
            : event.errorCategory
              ? t('diagnosticsEvidenceCategory').replace(
                  '{category}',
                  t(`diagnosticsCategory_${event.errorCategory}`),
                )
              : event.stopReason === 'timeout'
                ? t('diagnosticsReason_timeout')
                : event.phase === 'disconnected'
                  ? t('diagnosticsReason_disconnected')
                  : t('diagnosticsEvidenceEventError');
    if (runtimeFailure) description = runtimeFailure.title;
    if (event.operation)
      description = `${t(`diagnosticsOperation_${event.operation}`)} · ${description}`;
    if (event.exitCode !== undefined)
      description += ` · ${t('diagnosticsMetric_exitCode')}: ${event.exitCode}`;
    if (event.errorCode)
      description += ` · ${t(`diagnosticsCode_${event.errorCode}`)} (${event.errorCode})`;
    if (event.statusCode !== undefined) description += ` · HTTP ${event.statusCode}`;
    if (event.durationMs !== undefined)
      description += ` · ${t('diagnosticsMetric_durationMs')}: ${event.durationMs}`;
    if (event.timeoutPhase) description += ` · ${t(`diagnosticsTimeout_${event.timeoutPhase}`)}`;
    add(
      event.occurredAt ?? event.observedAt,
      description,
      t(`diagnosticsKind_${event.kind}`),
      runtimeFailure
        ? 5
        : event.toolValidationFailed
          ? 4
          : event.errorCode
            ? 3
            : event.statusCode || event.exitCode !== undefined
              ? 2
              : 0,
      runtimeFailure?.adviceKey ??
        (event.toolValidationFailed
          ? 'diagnosticsRemedy_invalid_arguments'
          : adviceFor(
              finding.signal,
              event.errorCode,
              event.kind === 'command' ? 'command' : undefined,
              event.kind === 'command'
                ? event.stopReason === 'timeout'
                  ? 'command_timeout'
                  : event.exitCode !== undefined && event.exitCode !== 0
                    ? 'command_exit'
                    : 'command_error'
                : undefined,
            )),
    );
  }
  for (const id of finding.logIds) {
    const record = report.logs!.records.find(item => item.id === id)!;
    const basis = record.basis ?? 'unknown';
    let description = t(`diagnosticsEvidenceBasis_${basis}`).replace(
      '{category}',
      t(`diagnosticsLogSignal_${record.signal}`),
    );
    if (record.stage) description = `${t(`diagnosticsStage_${record.stage}`)} · ${description}`;
    if (record.responseIssue)
      description = t(`diagnosticsResponseEvidence_${record.responseIssue}`);
    if (record.responseRecovery)
      description += ` · ${t(`diagnosticsResponseRecovery_${record.responseRecovery}`)}`;
    if (record.errorCode)
      description += ` · ${t(`diagnosticsCode_${record.errorCode}`)} (${record.errorCode})`;
    const metrics = Object.entries(record.metrics).map(
      ([key, value]) => `${t(`diagnosticsMetric_${key}`)}: ${value}`,
    );
    if (metrics.length) description += ` · ${metrics.join(' · ')}`;
    add(
      record.timestamp,
      description,
      t(`diagnosticsSource_${record.source}`),
      record.errorCode ? 3 : Object.keys(record.metrics).length ? 2 : record.stage ? 1 : 0,
      record.responseIssue
        ? `diagnosticsStopAdvice_${record.responseIssue}`
        : adviceFor(finding.signal, record.errorCode, record.stage, record.basis),
    );
  }
  const rows = [...groups.values()].sort(
    (a, b) => b.detail - a.detail || (a.time ?? 0) - (b.time ?? 0),
  );
  const related = finding.association === 'event' || finding.association === 'run';
  const logs = (report.logs?.records ?? []).filter(record => finding.logIds.includes(record.id));
  const inferredOnly =
    !finding.eventIds.length &&
    logs.length > 0 &&
    logs.every(
      record => record.basis === 'error_text' || record.basis === 'keyword' || !record.basis,
    );
  const limitedTool =
    finding.signal === 'tool' &&
    finding.association === 'event' &&
    !finding.logIds.length &&
    finding.eventIds.every(id => {
      const event = report.events.find(item => item.id === id)!;
      return (
        event.kind === 'tool' &&
        !event.toolValidationFailed &&
        !event.errorCode &&
        !event.statusCode &&
        !event.errorCategory &&
        event.stopReason !== 'timeout'
      );
    });
  const operations = new Set(
    finding.eventIds.map(id => report.events.find(event => event.id === id)?.operation),
  );
  const soleOperation = operations.size === 1 ? [...operations][0] : undefined;
  const title = limitedTool
    ? soleOperation
      ? t('diagnosticsOperationCauseMissing').replace(
          '{operation}',
          t(`diagnosticsOperation_${soleOperation}`),
        )
      : t('diagnosticsToolCauseMissing')
    : inferredOnly
      ? t('diagnosticsSuspectedProblem').replace(
          '{category}',
          t(`diagnosticsLogSignal_${finding.signal}`),
        )
      : t(`diagnosticsProblem_${finding.signal}`);
  return {
    title,
    related,
    rows,
    advice: limitedTool
      ? t('diagnosticsLocateToolFailure')
      : related
        ? t(rows[0]?.adviceKey ?? `diagnosticsAdvice_${finding.signal}`)
        : t('diagnosticsEvidenceUnrelated'),
    toolLimit: limitedTool,
  };
}

export function summarizeDiagnosticFinding(
  finding: DiagnosticFinding,
  report: DiagnosticReport,
): string {
  const presentation = presentDiagnosticFinding(finding, report);
  const evidence = presentation.rows[0];
  return [
    `${presentation.title} · ${t(`diagnosticsFindingAssociation_${finding.association}`)}`,
    ...(!presentation.toolLimit && evidence
      ? [
          `${evidence.description} · ${evidence.time === undefined ? t('diagnosticsLogsUnknownTime') : formatDiagnosticTime(evidence.time)} · ${[...evidence.sources].join(' / ')}`,
        ]
      : []),
    ...(presentation.toolLimit
      ? [
          presentation.rows
            .map(row =>
              row.time === undefined
                ? t('diagnosticsLogsUnknownTime')
                : formatDiagnosticTime(row.time),
            )
            .join(' / '),
        ]
      : []),
    presentation.advice,
  ].join('\n');
}

/** Describe collection gaps separately from intentional preview sampling. */
export function presentDiagnosticCoverage(report: DiagnosticReport) {
  const coverage = assessDiagnosticCoverage(report);
  const replaceCount = (key: string, count: number) =>
    t(key).replace(
      '{count}',
      count.toLocaleString(i18nService.getLanguage() === 'zh' ? 'zh-CN' : 'en-US'),
    );
  const associations = report.logs?.records.reduce(
    (counts, record) => ({ ...counts, [record.association]: counts[record.association] + 1 }),
    { run: 0, session: 0, time_window: 0 },
  ) ?? { run: 0, session: 0, time_window: 0 };
  const counts = t('diagnosticsCollectionCounts')
    .replace('{events}', String(report.events.length))
    .replace('{failures}', String(report.history?.failures.length ?? 0))
    .replace('{logs}', String(report.logs?.records.length ?? 0));
  const association = t('diagnosticsCollectionAssociations')
    .replace('{run}', String(associations.run))
    .replace('{session}', String(associations.session))
    .replace('{window}', String(associations.time_window));
  const sourceLines = coverage.sources.map(source => {
    const details = [
      `${t(`diagnosticsSource_${source.source}`)}: ${t(`diagnosticsSourceStatus_${source.status}`)}`,
      replaceCount('diagnosticsCollectionMatched', source.matched),
      ...source.reasons
        .filter(reason => !['outside_window', 'no_safe_fields', 'output_limit'].includes(reason))
        .map(reason => t(`diagnosticsLogReason_${reason}`)),
      ...(source.parseFailures
        ? [replaceCount('diagnosticsCollectionParseFailures', source.parseFailures)]
        : []),
      ...(source.truncated && !source.reasons.includes('limit') ? [t('diagnosticsLogsTail')] : []),
      ...(source.previewOmitted
        ? [replaceCount('diagnosticsCollectionPreviewOmitted', source.previewOmitted)]
        : []),
    ];
    return details.join(' · ');
  });
  const notes = [
    ...(coverage.eventLosses ? [`${t('diagnosticsDropped')}: ${coverage.eventLosses}`] : []),
    ...(coverage.storageFailed ? [t('diagnosticsStorageFailed')] : []),
    ...(coverage.history.status
      ? [
          t(`diagnosticsHistory_${coverage.history.status}`).replace(
            '{count}',
            String(report.history?.messagesScanned ?? 0),
          ),
        ]
      : []),
    ...(coverage.history.reason ? [t(`diagnosticsHistoryReason_${coverage.history.reason}`)] : []),
    ...(coverage.history.omitted
      ? [replaceCount('diagnosticsHistoryOmitted', coverage.history.omitted)]
      : []),
    ...(coverage.collectorLosses
      ? [`${t('diagnosticsCollectorDropped')}: ${coverage.collectorLosses}`]
      : []),
  ];
  return {
    ...coverage,
    title: t(
      coverage.hasGaps
        ? 'diagnosticsCollectionGaps'
        : coverage.logsCollected
          ? 'diagnosticsCollectionReady'
          : 'diagnosticsCollectionPending',
    ),
    counts,
    association,
    window: report.logs
      ? `${t('diagnosticsLogsWindow')}: ${formatDiagnosticTime(report.logs.window.from)} – ${formatDiagnosticTime(report.logs.window.to)}`
      : undefined,
    sourceLines,
    notes,
  };
}

/** Clipboard and the page use the same conclusion, evidence and collection limits. */
export function summarizeDiagnosticReport(report: DiagnosticReport): string {
  const coverage = presentDiagnosticCoverage(report);
  return [
    t('diagnosticsTitle'),
    `${t('diagnosticsCollected')}: ${formatDiagnosticTime(report.collectedAt)}`,
    ...(report.run
      ? [
          `${t('diagnosticsRun')}: ${formatDiagnosticTime(report.run.startedAt)}${report.run.endedAt === undefined ? '' : ` – ${formatDiagnosticTime(report.run.endedAt)}`}`,
        ]
      : []),
    summarizeDiagnosticStop(report),
    ...(report.history?.failures ?? []).map(failure => {
      const diagnosis = diagnoseHistoryFailure(failure);
      return [
        `${formatDiagnosticTime(failure.timestamp)} · ${failure.tool ?? t(failure.kind === 'tool' ? 'diagnosticsKind_tool' : failure.kind === 'runtime' ? 'diagnosticsHistoryRuntime' : 'diagnosticsHistoryModel')} · ${t(`diagnosticsHistoryOutcome_${failure.outcome ?? 'failed'}`)}`,
        t(`diagnosticsHistoryAssociation_${failure.association}`),
        failure.excerpt || t('diagnosticsHistoryNoText'),
        t(diagnosis.adviceKey),
        ...(diagnosis.inferred ? [t('diagnosticsHistoryInferred')] : []),
      ].join('\n');
    }),
    ...(report.history?.failures.length ? [t('diagnosticsHistoryScope')] : []),
    ...visibleDiagnosticFindings(report).map(finding =>
      summarizeDiagnosticFinding(finding, report),
    ),
    coverage.title,
    coverage.counts,
    coverage.association,
    ...(coverage.window ? [coverage.window] : []),
    ...coverage.sourceLines,
    ...coverage.notes,
    t('diagnosticsCollectionScope'),
    t(`diagnosticsConnection_${report.connection}`),
  ].join('\n');
}

export function presentDiagnosticExport(summary: DiagnosticExportSummary): string {
  return [
    t('diagnosticsExportedCounts').replace('{count}', String(summary.logRecords)),
    `${t('diagnosticsCollected')}: ${formatDiagnosticTime(summary.collectedAt)}`,
    ...(summary.logRecords === 0 ? [t('diagnosticsExportNoLogs')] : []),
    ...(summary.unavailableSources.length
      ? [
          t('diagnosticsExportMissing').replace(
            '{sources}',
            summary.unavailableSources.map(source => t(`diagnosticsSource_${source}`)).join(' / '),
          ),
        ]
      : []),
    ...(summary.partialSources.length
      ? [
          t('diagnosticsExportPartial').replace(
            '{sources}',
            summary.partialSources.map(source => t(`diagnosticsSource_${source}`)).join(' / '),
          ),
        ]
      : []),
    ...(summary.omittedLogRecords
      ? [t('diagnosticsExportOmitted').replace('{count}', String(summary.omittedLogRecords))]
      : []),
  ].join('\n');
}
