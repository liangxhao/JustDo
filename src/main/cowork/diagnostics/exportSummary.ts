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
} from '../../../shared/cowork/diagnostics/sessionDiagnostics';
import { diagnosticExportTime } from './exportFormat';
import {
  DIAGNOSTIC_ERRORS_FILE,
  type DiagnosticExportLogBundle,
  redactDiagnosticLog,
} from './exportLogs';
import type { projectDiagnosticExportSessionDetails } from './exportSessionDetails';
import { exportSummaryTranslations } from './exportSummaryTranslations';

const SOURCES = ['main', 'cowork', 'gateway', 'native'] as const;
const member = (value: unknown, choices: readonly string[]) =>
  typeof value === 'string' && choices.includes(value) ? value : 'unknown';
const amount = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const escape = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_{}[\]()#+.!|~-]/g, '\\$&')
    .replace(/\r?\n/g, ' ');
const failureLead = (value: string) => {
  const lead = redactDiagnosticLog(value).trim().split(/\r?\n/u, 1)[0] ?? '';
  return escape(lead.length > 180 ? `${lead.slice(0, 180)}…` : lead);
};
const LOG_GAPS = [
  'missing',
  'unreadable',
  'unsafe_file',
  'limit',
  'malformed',
  'native_unavailable',
  'source_changed',
  'read_timeout',
  'canceled',
] as const;

/** The report and summary share the same deterministic assessments and aliases. */
export function buildDiagnosticSummary(
  report: DiagnosticReport,
  language: 'zh' | 'en',
  alias: (value: unknown) => string | undefined,
  bundle?: DiagnosticExportLogBundle,
  errorRecords = 0,
  sessionDetails?: ReturnType<typeof projectDiagnosticExportSessionDetails>,
  detailed?: {
    context?: { file?: string; messages: number; reasons: readonly string[]; status: string };
    pluginsFile?: string;
    calls?: number;
    turns?: number;
    callOmitted?: number;
    fallbackOmitted?: number;
    turnsLimited?: boolean;
    pluginGaps?: number;
  },
): string {
  const strings = exportSummaryTranslations[language];
  const time = (value: unknown) => diagnosticExportTime(value) ?? strings.noTimestamp;
  const coverage = assessDiagnosticCoverage(report);
  const stop = assessDiagnosticStop(report);
  const reason = stop.modelReplyEnded
    ? strings.modelReplyEnded
    : stop.basis === 'log' && stop.recoveryExhausted
      ? strings.logRecoveryExhausted
      : [...Object.values(DiagnosticReason), ...diagnosticResponseIssues].includes(stop.reason) &&
          Object.hasOwn(strings, stop.reason)
        ? strings[stop.reason as keyof typeof strings]
        : strings.unknown;
  const stopReferences = [...stop.eventIds, ...stop.logIds].slice(0, 8);
  const references = stopReferences.map(alias).filter(Boolean);
  const rawCoverage = new Map(bundle?.coverage.map(source => [source.source, source]));
  const failures = (report.history?.failures ?? []).slice(0, 40);
  const displayedFailures = failures.slice(-8);
  const findings = buildDiagnosticFindings(report).filter(
    finding =>
      finding.signal !== 'unknown' ||
      ![...finding.eventIds, ...finding.logIds].every(id => stopReferences.includes(id)),
  );
  const replayAdmissionObserved = report.events.some(
    event => event.runtimeFailure === DiagnosticRuntimeFailure.ReplayAdmissionRejected,
  );
  const stopDetails = [
    ...(stop.reason !== 'unknown' || references.length ? [reason] : []),
    ...(stop.confidence === 'observed' && stop.basis !== 'log'
      ? [`${strings.confidence}: ${strings.observed}.`]
      : []),
    ...(stop.timeoutPhase
      ? [`${strings.timeoutStage}: ${strings[`timeout_${stop.timeoutPhase}`] ?? strings.unknown}`]
      : []),
    ...(stop.outputIssue && stop.outputIssue !== stop.reason ? [strings[stop.outputIssue]] : []),
    ...(stop.outputLimited ? [strings.outputLimited] : []),
    ...(replayAdmissionObserved ? [strings.replayAdmission] : []),
    ...(references.length
      ? [`${strings.evidence}: ${references.map(id => `\`${id}\``).join(', ')} · report.json`]
      : []),
  ];
  const hasErrorText = Boolean(bundle?.entries[DIAGNOSTIC_ERRORS_FILE]?.trim());
  const hasContext = SOURCES.some(source => bundle?.entries[`logs/${source}.log`]?.trim());
  const hasLogText = hasErrorText || hasContext;
  const context = detailed?.context;
  const gaps: string[] = [];
  if (context && (!context.file || context.status !== 'complete' || context.reasons.length)) {
    const details = context.reasons.map(reason => `\`${escape(reason)}\``).join(', ');
    gaps.push(
      `${context.file ? strings.contextGaps : strings.contextUnavailable}${details ? ` (${details})` : ''}.`,
    );
  }
  if (detailed?.callOmitted) gaps.push(`${strings.callOmitted}: ${amount(detailed.callOmitted)}`);
  if (detailed?.fallbackOmitted)
    gaps.push(`${strings.fallbackOmitted}: ${amount(detailed.fallbackOmitted)}`);
  if (detailed?.turnsLimited) gaps.push(strings.turnsLimited);
  if (detailed?.pluginGaps)
    gaps.push(strings.pluginGaps.replace('{count}', String(amount(detailed.pluginGaps))));
  if (!coverage.logsCollected) gaps.push(strings.noLogCollection);
  else if (bundle && !hasLogText) gaps.push(strings.noLogs);
  if (!report.history) gaps.push(strings.noHistory);
  else if (report.history.status !== 'scanned') {
    const status = member(report.history.status, ['partial', 'unavailable', 'changed']);
    const detail =
      report.history.reason &&
      member(report.history.reason, [
        'offline',
        'no_run',
        'no_binding',
        'canceled',
        'timeout',
        'read_failed',
        'page_limit',
        'history_changed',
      ]);
    gaps.push(
      `${strings.historyStatus}: ${status}${detail && detail !== 'unknown' ? ` (${detail})` : ''}`,
    );
  }
  if (coverage.eventLosses) gaps.push(`${strings.losses}: ${amount(coverage.eventLosses)}`);
  if (coverage.collectorLosses)
    gaps.push(`${strings.collectorLosses}: ${amount(coverage.collectorLosses)}`);
  if (coverage.storageFailed) gaps.push(strings.storageFailed);
  if (coverage.history.omitted)
    gaps.push(`${strings.historyOmitted}: ${amount(coverage.history.omitted)}`);
  for (const source of coverage.sources) {
    if (source.hasGaps) {
      const reasons = source.reasons.filter(reason => LOG_GAPS.some(gap => gap === reason));
      const details = [
        source.scanComplete === false && strings.scanIncomplete,
        source.parseFailures > 0 && `${strings.parseFailures}: ${amount(source.parseFailures)}`,
        reasons.join(', '),
      ].filter(Boolean);
      gaps.push(
        `${member(source.source, SOURCES)}: ${details.join(' · ') || (source.status === 'unavailable' ? strings.scanUnavailable : strings.scanPartial)}`,
      );
    }
  }
  for (const source of bundle?.coverage ?? []) {
    if (source.omitted)
      gaps.push(
        `${member(source.source, SOURCES)}: ${strings.rawOmitted}: ${amount(source.omitted)}`,
      );
  }
  const sources = SOURCES.filter(
    source => coverage.sources.some(item => item.source === source) || rawCoverage.has(source),
  );
  const environment = report.runtimeInfo;
  const gateway =
    environment?.gateway.status === 'connected'
      ? projectDiagnosticGatewayInfo({
          server: environment.gateway,
          protocol: environment.gateway.protocol,
        }).version
      : environment?.gateway.status;
  const artifact = environment?.installedArtifact
    ? projectDiagnosticRuntimeArtifact(environment.installedArtifact)?.version
    : undefined;
  const sessionLines = sessionDetails
    ? [
        sessionDetails.title && `- ${strings.sessionTitle}: ${escape(sessionDetails.title)}`,
        sessionDetails.createdAt !== undefined &&
          `- ${strings.sessionCreated}: ${time(sessionDetails.createdAt)}`,
        sessionDetails.usage?.lastActivity !== undefined
          ? `- ${strings.sessionLastActivity}: ${time(sessionDetails.usage.lastActivity)}`
          : sessionDetails.updatedAt !== undefined &&
            `- ${strings.sessionUpdated}: ${time(sessionDetails.updatedAt)}`,
        sessionDetails.configuredModel &&
          `- ${strings.sessionConfiguredModel}: ${escape(sessionDetails.configuredModel)}`,
        !!sessionDetails.usage?.models?.length &&
          `- ${strings.sessionModels}: ${sessionDetails.usage.models.map(escape).join(', ')}`,
        sessionDetails.usage?.messages?.total !== undefined &&
          `- ${strings.sessionMessages}: ${sessionDetails.usage.messages.total}`,
        sessionDetails.usage?.tokens?.total !== undefined &&
          `- ${strings.sessionTokens}: ${sessionDetails.usage.tokens.total}`,
      ]
        .filter(Boolean)
        .join('\n')
    : '';
  return (
    [
      `# ${strings.title}`,
      ...(stopDetails.length ? [`## ${strings.reason}`, ...stopDetails] : []),
      ...(gaps.length ? [`## ${strings.gaps}`, gaps.map(gap => `- ${gap}`).join('\n')] : []),
      `## ${report.run ? strings.run : strings.collection}`,
      [
        ...(report.run ? [`- ${strings.run}: ${alias(report.run.id)}`] : []),
        `- ${strings.collected}: ${time(report.logs?.collectedAt ?? report.collectedAt)}`,
        ...(report.run ? [`- ${strings.started}: ${time(report.run.startedAt)}`] : []),
        ...(report.run?.endedAt !== undefined
          ? [`- ${strings.ended}: ${time(report.run.endedAt)}`]
          : []),
        ...(report.run && report.run.state !== stop.reason
          ? [
              `- ${strings.savedState}: ${member(report.run.state, ['running', 'completed', 'failed', 'aborted'])}`,
            ]
          : []),
        ...(report.run?.endedAt !== undefined &&
        diagnosticExportTime(report.run.startedAt) !== undefined &&
        diagnosticExportTime(report.run.endedAt) !== undefined &&
        report.run.endedAt >= report.run.startedAt
          ? [`- ${strings.duration}: ${report.run.endedAt - report.run.startedAt} ms`]
          : []),
        ...(report.logs
          ? [
              `- ${strings.window}: ${time(report.logs.window.from)} → ${time(report.logs.window.to)}`,
            ]
          : []),
      ].join('\n'),
      ...(sessionLines ? [`## ${strings.sessionDetails}`, sessionLines] : []),
      ...(displayedFailures.length
        ? [
            `## ${strings.failures}`,
            displayedFailures
              .map((failure, position) => {
                const tool = failure.tool ? failureLead(failure.tool) : undefined;
                const lead = failureLead(failure.excerpt);
                const location = `report.json → history.failures[${failures.length - displayedFailures.length + position}]`;
                return [
                  `- ${time(failure.timestamp)} · ${tool || member(failure.kind, ['tool', 'model', 'runtime'])} · ${member(failure.association, ['run', 'run_window'])} · ${location}${lead ? ` · ${lead}` : ''}`,
                  ...(!replayAdmissionObserved &&
                  failure.cause === DiagnosticRuntimeFailure.ReplayAdmissionRejected &&
                  displayedFailures.findIndex(item => item.cause === failure.cause) === position
                    ? [`  ${strings.replayAdmission}`]
                    : []),
                ].join('\n');
              })
              .join('\n'),
          ]
        : []),
      ...(findings.length || errorRecords ? [`## ${strings.findings}`] : []),
      ...(errorRecords ? [strings.errorsFileGuide.replace('{count}', String(errorRecords))] : []),
      findings.length
        ? findings
            .map(
              finding =>
                `- ${member(finding.signal, ['auth', 'rate_limit', 'billing', 'context', 'timeout', 'network', 'tls', 'provider', 'tool', 'permission', 'storage', 'process_exit', 'disconnect', 'retry', 'unknown'])}; ${strings.association}: ${member(finding.association, ['event', 'run', 'session', 'time_window'])}; ${[
                  ...finding.eventIds,
                  ...finding.logIds,
                ]
                  .slice(0, 5)
                  .map(alias)
                  .filter(Boolean)
                  .map(id => `\`${id}\``)
                  .join(', ')}`,
            )
            .join('\n')
        : '',
      ...(findings.some(
        finding => finding.association !== 'event' && finding.association !== 'run',
      ) || displayedFailures.some(failure => failure.association === 'run_window')
        ? [strings.associations]
        : []),
      ...(sources.length
        ? [
            `## ${strings.coverage}`,
            `| ${strings.source} | ${strings.scan} | ${strings.retained} |\n| --- | --- | ---: |\n${sources
              .map(source => {
                const scan = coverage.sources.find(item => item.source === source);
                const raw = rawCoverage.get(source);
                const status = !scan
                  ? strings.notCollected
                  : scan.status === 'unavailable'
                    ? strings.scanUnavailable
                    : scan.hasGaps
                      ? strings.scanPartial
                      : strings.scanRead;
                return `| ${source} | ${status} | ${raw ? amount(raw.records) : '—'} |`;
              })
              .join('\n')}`,
          ]
        : []),
      ...(gateway || artifact
        ? [
            `## ${strings.environment}`,
            strings.environmentScope,
            [
              ...(gateway ? [`- ${strings.gateway}: ${gateway}`] : []),
              ...(artifact ? [`- ${strings.artifact}: ${artifact}`] : []),
            ].join('\n'),
          ]
        : []),
      `## ${strings.files}`,
      strings.filesGuide,
      ...(context?.file
        ? [
            strings.contextFile
              .replace('{file}', context.file)
              .replace('{count}', String(context.messages)),
          ]
        : []),
      ...(detailed?.turns !== undefined
        ? [strings.turnDetails.replace('{count}', String(detailed.turns))]
        : []),
      ...(detailed?.calls !== undefined
        ? [strings.callDetails.replace('{count}', String(detailed.calls))]
        : []),
      ...(detailed?.pluginsFile
        ? [strings.pluginInventory.replace('{file}', detailed.pluginsFile)]
        : []),
      ...(hasLogText ? [strings.logFilesGuide] : []),
      detailed ? strings.detailedPrivacy : strings.privacy,
    ]
      .filter(Boolean)
      .join('\n\n') + '\n'
  );
}
