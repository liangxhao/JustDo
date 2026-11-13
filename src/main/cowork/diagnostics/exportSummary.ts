import { assessDiagnosticCoverage } from '../../../shared/cowork/diagnostics/diagnosticEvidenceCoverage';
import { buildDiagnosticFindings } from '../../../shared/cowork/diagnostics/diagnosticFindings';
import { DiagnosticRuntimeFailure } from '../../../shared/cowork/diagnostics/diagnosticRuntimeFailure';
import {
  projectDiagnosticGatewayInfo,
  projectDiagnosticRuntimeArtifact,
} from '../../../shared/cowork/diagnostics/diagnosticRuntimeInfo';
import { assessDiagnosticStop } from '../../../shared/cowork/diagnostics/diagnosticStop';
import {
  DiagnosticReason,
  type DiagnosticReport,
  diagnosticResponseIssues,
  diagnosticTimeoutPhases,
} from '../../../shared/cowork/diagnostics/sessionDiagnostics';
import {
  DIAGNOSTIC_ERRORS_FILE,
  type DiagnosticExportLogBundle,
  redactDiagnosticLog,
} from './exportLogs';
import { exportSummaryTranslations } from './exportSummaryTranslations';

const SOURCES = ['main', 'cowork', 'gateway', 'native'] as const;
const member = (value: unknown, choices: readonly string[]) =>
  typeof value === 'string' && choices.includes(value) ? value : 'unknown';
const amount = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const safeTime = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8.64e15
    ? value
    : undefined;
const escape = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_{}[\]()#+.!|~-]/g, '\\$&')
    .replace(/\r?\n/g, ' ');
const excerptBlock = (value: string) => {
  const safe = redactDiagnosticLog(value).slice(0, 1600);
  const fence = '`'.repeat(
    Math.max(3, ...[...safe.matchAll(/`+/g)].map(match => match[0].length + 1)),
  );
  return `${fence}text\n${safe}\n${fence}`;
};

/** The report and summary share the same deterministic assessments and aliases. */
export function buildDiagnosticSummary(
  report: DiagnosticReport,
  language: 'zh' | 'en',
  alias: (value: unknown) => string | undefined,
  bundle?: DiagnosticExportLogBundle,
  errorRecords = 0,
): string {
  const strings = exportSummaryTranslations[language];
  const time = (value: unknown) => {
    const valid = safeTime(value);
    return valid === undefined ? strings.noTimestamp : new Date(valid).toISOString();
  };
  const coverage = assessDiagnosticCoverage(report);
  const stop = assessDiagnosticStop(report);
  const explained =
    Boolean(stop.modelReplyEnded) || !['completed', 'unknown'].includes(stop.reason);
  const certainty =
    !explained || stop.basis === 'unknown'
      ? 'unknown'
      : stop.basis === 'terminal'
        ? 'confirmed'
        : 'observed';
  const reason = stop.modelReplyEnded
    ? strings.modelReplyEnded
    : [...Object.values(DiagnosticReason), ...diagnosticResponseIssues].includes(stop.reason) &&
        Object.hasOwn(strings, stop.reason)
      ? strings[stop.reason as keyof typeof strings]
      : strings.unknown;
  const references = [...stop.eventIds, ...stop.logIds].map(alias).filter(Boolean);
  const rawCoverage = new Map(bundle?.coverage.map(source => [source.source, source]));
  const failures = (report.history?.failures ?? []).slice(0, 40);
  const findings = buildDiagnosticFindings(report);
  const gaps: string[] = [];
  if (!coverage.logsCollected) gaps.push(strings.noLogCollection);
  if (!report.history) gaps.push(strings.noHistory);
  else if (report.history.status !== 'scanned')
    gaps.push(
      `${strings.historyStatus}: ${member(report.history.status, ['partial', 'unavailable', 'changed'])} / ${member(report.history.reason, ['offline', 'no_run', 'no_binding', 'canceled', 'timeout', 'read_failed', 'page_limit', 'history_changed'])}`,
    );
  if (coverage.eventLosses) gaps.push(`${strings.losses}: ${amount(coverage.eventLosses)}`);
  if (coverage.collectorLosses)
    gaps.push(`${strings.collectorLosses}: ${amount(coverage.collectorLosses)}`);
  if (coverage.storageFailed) gaps.push(strings.storageFailed);
  if (coverage.history.omitted)
    gaps.push(`${strings.historyOmitted}: ${amount(coverage.history.omitted)}`);
  for (const source of coverage.sources) {
    if (source.hasGaps)
      gaps.push(
        `${member(source.source, SOURCES)}: ${source.scanComplete === false ? strings.scanIncomplete : member(source.status, ['available', 'partial', 'unavailable'])}${source.parseFailures ? `; ${strings.parseFailures}: ${amount(source.parseFailures)}` : ''}${source.reasons.length ? ` (${source.reasons.map(reason => member(reason, ['missing', 'unreadable', 'unsafe_file', 'limit', 'malformed', 'native_unavailable', 'outside_window', 'no_safe_fields', 'output_limit', 'source_changed', 'read_timeout', 'canceled'])).join(', ')})` : ''}`,
      );
  }
  for (const source of bundle?.coverage ?? []) {
    if (source.omitted)
      gaps.push(
        `${member(source.source, SOURCES)}: ${strings.rawOmitted}: ${amount(source.omitted)}`,
      );
  }
  const hasErrorText = Boolean(bundle?.entries[DIAGNOSTIC_ERRORS_FILE]?.trim());
  const hasContext = SOURCES.some(source => bundle?.entries[`logs/${source}.log`]?.trim());
  const hasLogText = hasErrorText || hasContext;
  return (
    [
      `# ${strings.title}`,
      `## ${strings.reason}`,
      reason,
      `${strings.confidence}: ${certainty === 'confirmed' ? strings.confirmed : certainty === 'observed' ? strings.observed : strings.unknownConfidence}.`,
      ...(stop.timeoutPhase
        ? [
            `${strings.timeoutStage}: ${strings[`timeout_${member(stop.timeoutPhase, diagnosticTimeoutPhases)}` as keyof typeof strings] ?? strings.unknown}`,
          ]
        : []),
      ...(stop.outputIssue && stop.outputIssue !== stop.reason ? [strings[stop.outputIssue]] : []),
      ...(stop.outputLimited ? [strings.outputLimited] : []),
      ...(stop.recoveryExhausted ? [strings.recoveryExhausted] : []),
      ...(report.events.some(
        event => event.runtimeFailure === DiagnosticRuntimeFailure.ReplayAdmissionRejected,
      )
        ? [strings.replayAdmission]
        : []),
      ...(references.length
        ? [`${strings.evidence}: ${references.map(id => `\`${id}\``).join(', ')} · report.json`]
        : []),
      `## ${strings.gaps}`,
      ...(bundle && !hasLogText ? [strings.noLogs] : []),
      gaps.length ? gaps.map(gap => `- ${gap}`).join('\n') : strings.noGaps,
      `## ${strings.run}`,
      [
        `- ${strings.run}: ${alias(report.run?.id) ?? strings.notCollected}`,
        `- ${strings.collected}: ${time(report.logs?.collectedAt ?? report.collectedAt)}`,
        `- ${strings.started}: ${time(report.run?.startedAt)}`,
        `- ${strings.ended}: ${report.run?.endedAt === undefined ? strings.noEnd : time(report.run.endedAt)}`,
        `- ${strings.savedState}: ${member(report.run?.state, ['running', 'completed', 'failed', 'aborted'])}`,
        ...(report.run?.endedAt !== undefined &&
        safeTime(report.run.startedAt) !== undefined &&
        safeTime(report.run.endedAt) !== undefined &&
        report.run.endedAt >= report.run.startedAt
          ? [`- ${strings.duration}: ${report.run.endedAt - report.run.startedAt} ms`]
          : []),
        ...(report.logs
          ? [
              `- ${strings.window}: ${time(report.logs.window.from)} → ${time(report.logs.window.to)}`,
            ]
          : []),
      ].join('\n'),
      `## ${strings.failures}`,
      failures.length
        ? failures
            .slice(-8)
            .map((failure, position) =>
              [
                `### ${time(failure.timestamp)} · ${member(failure.kind, ['tool', 'model', 'runtime'])}${failure.tool ? ` · ${escape(redactDiagnosticLog(failure.tool).slice(0, 100))}` : ''}`,
                `${strings.association}: ${member(failure.association, ['run', 'run_window'])}; report.json → history.failures[${Math.max(0, failures.length - 8) + position}]${failure.clipped ? ' (clipped)' : ''}`,
                excerptBlock(failure.excerpt),
                ...(failure.kind === 'runtime' &&
                failure.basis === 'failure_receipt' &&
                failure.cause === DiagnosticRuntimeFailure.ReplayAdmissionRejected
                  ? [strings.replayAdmission]
                  : []),
              ].join('\n\n'),
            )
            .join('\n\n')
        : strings.noFailures,
      `## ${strings.findings}`,
      ...(errorRecords ? [strings.errorsFileGuide.replace('{count}', String(errorRecords))] : []),
      findings.length
        ? findings
            .map(
              finding =>
                `- ${member(finding.signal, ['auth', 'rate_limit', 'billing', 'context', 'timeout', 'network', 'tls', 'provider', 'tool', 'permission', 'storage', 'process_exit', 'disconnect', 'retry', 'unknown'])}; ${strings.association}: ${member(finding.association, ['event', 'run', 'session', 'time_window'])}; ${[
                  ...finding.eventIds,
                  ...finding.logIds,
                ]
                  .map(alias)
                  .filter(Boolean)
                  .map(id => `\`${id}\``)
                  .join(', ')}`,
            )
            .join('\n')
        : strings.noFindings,
      strings.associations,
      `## ${strings.coverage}`,
      `| ${strings.source} | ${strings.scan} | ${strings.retained} | ${strings.omitted} | ${strings.preview} |\n| --- | --- | ---: | ---: | ---: |\n${SOURCES.map(
        source => {
          const scan = coverage.sources.find(item => item.source === source);
          const raw = rawCoverage.get(source);
          return `| ${source} | ${scan ? `${member(scan.status, ['available', 'partial', 'unavailable'])}; scanComplete=${scan.scanComplete === true ? 'true' : scan.scanComplete === false ? 'false' : 'unknown'}` : strings.notCollected} | ${raw ? amount(raw.records) : '—'} | ${raw ? amount(raw.omitted) : '—'} | ${scan ? `${amount(scan.emitted)} / ${amount(scan.previewOmitted)}` : '—'} |`;
        },
      ).join('\n')}`,
      `## ${strings.environment}`,
      strings.environmentScope,
      [
        `${strings.gateway}: ${report.runtimeInfo?.gateway.status === 'connected' ? (projectDiagnosticGatewayInfo({ server: report.runtimeInfo.gateway, protocol: report.runtimeInfo.gateway.protocol }).version ?? strings.notCollected) : report.runtimeInfo ? member(report.runtimeInfo.gateway.status, ['offline', 'changed']) : strings.notCollected}`,
        `${strings.artifact}: ${report.runtimeInfo?.installedArtifact ? (projectDiagnosticRuntimeArtifact(report.runtimeInfo.installedArtifact)?.version ?? strings.notCollected) : strings.notCollected}`,
      ].join('\n\n'),
      `## ${strings.next}`,
      strings.nextText,
      `## ${strings.files}`,
      strings.filesGuide,
      ...(hasLogText ? [strings.logFilesGuide] : []),
      ...(hasLogText ? [strings.retention] : []),
      strings.privacy,
    ].join('\n\n') + '\n'
  );
}
