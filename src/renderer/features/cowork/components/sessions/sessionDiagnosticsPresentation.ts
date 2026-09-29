import { buildDiagnosticFindings, type DiagnosticFinding } from '@shared/cowork/diagnosticFindings';
import type { DiagnosticLogRecord, DiagnosticReport } from '@shared/cowork/sessionDiagnostics';

import { i18nService } from '@/services/i18n';

const t = (key: string) => i18nService.t(key);
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
    let description = event.toolValidationFailed
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
    if (event.operation)
      description = `${t(`diagnosticsOperation_${event.operation}`)} · ${description}`;
    if (event.exitCode !== undefined)
      description += ` · ${t('diagnosticsMetric_exitCode')}: ${event.exitCode}`;
    if (event.errorCode)
      description += ` · ${t(`diagnosticsCode_${event.errorCode}`)} (${event.errorCode})`;
    if (event.statusCode !== undefined) description += ` · HTTP ${event.statusCode}`;
    if (event.durationMs !== undefined)
      description += ` · ${t('diagnosticsMetric_durationMs')}: ${event.durationMs}`;
    add(
      event.occurredAt ?? event.observedAt,
      description,
      t(`diagnosticsKind_${event.kind}`),
      event.toolValidationFailed
        ? 4
        : event.errorCode
          ? 3
          : event.statusCode || event.exitCode !== undefined
            ? 2
            : 0,
      event.toolValidationFailed
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
          ),
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
      adviceFor(finding.signal, record.errorCode, record.stage, record.basis),
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
