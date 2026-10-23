import { assessDiagnosticCoverage } from '../../../shared/cowork/diagnostics/diagnosticEvidenceCoverage';
import { buildDiagnosticFindings } from '../../../shared/cowork/diagnostics/diagnosticFindings';
import {
  diagnosticErrorCodes,
  isDiagnosticMetricValue,
} from '../../../shared/cowork/diagnostics/diagnosticLogDetails';
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
import { type DiagnosticExportLogBundle, redactDiagnosticLog } from './exportLogs';
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

/** The report, readable overview and timeline share the same deterministic assessments and aliases. */
export function buildDiagnosticReadableFiles(
  report: DiagnosticReport,
  language: 'zh' | 'en',
  alias: (value: unknown) => string | undefined,
  bundle?: DiagnosticExportLogBundle,
): Record<string, string> {
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
  const retainedIndex = SOURCES.flatMap(source =>
    (bundle?.index ?? [])
      .filter(
        record =>
          record.source === source &&
          new RegExp(`^log-${source}-\\d+$`).test(record.id) &&
          Number.isSafeInteger(record.line) &&
          record.line > 0 &&
          Number.isSafeInteger(record.endLine) &&
          record.endLine >= record.line,
      )
      .slice(0, 2048),
  );
  const index = new Map(retainedIndex.map(record => [record.id, record]));
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
  const hasLogText = bundle && Object.values(bundle.entries).some(value => value.trim().length > 0);
  const summary =
    [
      `# ${strings.title}`,
      `## ${strings.reason}`,
      reason,
      `${strings.confidence}: ${certainty === 'confirmed' ? strings.confirmed : certainty === 'observed' ? strings.observed : strings.unknownConfidence}.`,
      ...(stop.timeoutPhase
        ? [
            `${strings.timeoutStage}: ${strings[`timeout_${member(stop.timeoutPhase, ['queue', 'preflight', 'provider', 'post_turn', 'gateway_draining'])}` as keyof typeof strings] ?? strings.unknown}`,
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
        ? [
            `${strings.evidence}: ${references.map(id => `\`${id}\``).join(', ')} — report.json${stop.logIds.length ? ' / logs/index.json' : ''}`,
          ]
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
                `${strings.association}: ${member(failure.association, ['run', 'run_window'])}; session-evidence.json → failures[${Math.max(0, failures.length - 8) + position}]${failure.clipped ? ' (clipped)' : ''}`,
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
      bundle ? strings.filesGuide : strings.metadataFilesGuide,
      ...(bundle ? [strings.retention] : []),
      strings.privacy,
    ].join('\n\n') + '\n';

  const rows: Array<{ at?: number; order: number; cells: string[] }> = [];
  for (const event of report.events.slice(0, 232)) {
    const details = [
      `${member(event.kind, ['lifecycle', 'chat', 'tool', 'command', 'connection', 'cancel'])}.${member(event.phase, ['start', 'finishing', 'end', 'error', 'final', 'aborted', 'connected', 'disconnected', 'requested', 'acknowledged', 'failed'])}`,
      ...(event.executionSettled === true ? ['executionSettled=true'] : []),
      ...(event.stopReason
        ? [
            `stopReason=${member(event.stopReason, ['stop', 'end_turn', 'completed', 'length', 'max_tokens', 'aborted', 'timeout', 'restart', 'superseded', 'error'])}`,
          ]
        : []),
      ...(event.errorCategory
        ? [
            `category=${member(event.errorCategory, ['auth', 'rate_limit', 'billing', 'timeout', 'network', 'context', 'provider'])}`,
          ]
        : []),
      ...(event.errorCode ? [`code=${member(event.errorCode, diagnosticErrorCodes)}`] : []),
      ...(event.runtimeFailure === DiagnosticRuntimeFailure.ReplayAdmissionRejected
        ? [`runtimeFailure=${event.runtimeFailure}`]
        : []),
      ...(isDiagnosticMetricValue('exitCode', event.exitCode)
        ? [`exitCode=${event.exitCode}`]
        : []),
    ];
    rows.push({
      at: safeTime(event.occurredAt ?? event.observedAt),
      order: rows.length,
      cells: [
        time(event.occurredAt ?? event.observedAt),
        alias(event.id) ?? '',
        details.join('; '),
        'report.json',
      ],
    });
  }
  for (const record of (report.logs?.records ?? []).slice(0, 400)) {
    const raw = index.get(record.id);
    const details = [
      member(record.source, SOURCES),
      member(record.level, ['error', 'warn', 'info', 'debug', 'unknown']),
      member(record.signal, [
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
      `association=${member(record.association, ['run', 'session', 'time_window'])}`,
      ...Object.entries(record.metrics)
        .filter(([key, value]) => isDiagnosticMetricValue(key, value))
        .map(([key, value]) => `${key}=${value}`),
    ];
    rows.push({
      at: safeTime(record.timestamp),
      order: rows.length,
      cells: [
        time(record.timestamp),
        alias(record.id) ?? '',
        details.join('; '),
        raw
          ? `logs/${raw.source}.log:${raw.line}–${raw.endLine} (${raw.id})`
          : `logs.json (${bundle ? strings.rawNotRetained : strings.rawNotIncluded})`,
      ],
    });
  }
  failures.forEach((failure, index) =>
    rows.push({
      at: safeTime(failure.timestamp),
      order: rows.length,
      cells: [
        time(failure.timestamp),
        `history-${index + 1}`,
        `${member(failure.kind, ['tool', 'model', 'runtime'])}; association=${member(failure.association, ['run', 'run_window'])}`,
        `session-evidence.json → failures[${index}]`,
      ],
    }),
  );
  rows.sort(
    (left, right) =>
      Number(left.at === undefined) - Number(right.at === undefined) ||
      (left.at !== undefined && right.at !== undefined ? left.at - right.at : 0) ||
      left.order - right.order,
  );
  const entries: Record<string, string> = {
    'summary.md': summary,
    'evidence-timeline.md': `# ${strings.timeline}\n\n${strings.timelineScope}\n\n| ${strings.time} | ${strings.record} | ${strings.observation} | ${strings.location} |\n| --- | --- | --- | --- |\n${rows.map(row => `| ${row.cells.map(escape).join(' | ')} |`).join('\n')}\n`,
  };
  if (bundle)
    entries['logs/index.json'] = JSON.stringify({
      version: 1,
      selection: 'evidence_priority_with_recent_context',
      sources: SOURCES.map(source => ({
        file: `logs/${source}.log`,
        records: retainedIndex
          .filter(record => record.source === source)
          .map(record => ({
            id: alias(record.id),
            marker: record.id,
            line: record.line,
            endLine: record.endLine,
            at: safeTime(record.timestamp),
            association: member(record.association, ['run', 'session', 'time_window']),
            level: member(record.level, ['error', 'warn', 'info', 'debug', 'unknown']),
          })),
      })),
    });
  return entries;
}
