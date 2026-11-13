import {
  ArrowPathIcon,
  BoltIcon,
  ChatBubbleLeftRightIcon,
  ChevronDownIcon,
  CircleStackIcon,
  ClockIcon,
  CodeBracketIcon,
  CommandLineIcon,
  ExclamationTriangleIcon,
  MagnifyingGlassIcon,
  ServerStackIcon,
  SignalIcon,
  Squares2X2Icon,
  StopCircleIcon,
  WifiIcon,
  WrenchScrewdriverIcon,
} from '@heroicons/react/24/outline';
import { diagnosticSourceHasGaps } from '@shared/cowork/diagnostics/diagnosticEvidenceCoverage';
import { type DiagnosticFinding } from '@shared/cowork/diagnostics/diagnosticFindings';
import type {
  DiagnosticEvent,
  DiagnosticLogCoverage,
  DiagnosticReport,
} from '@shared/cowork/diagnostics/sessionDiagnostics';
import { useState } from 'react';

import { diagnoseHistoryFailure } from '@/features/cowork/components/sessions/diagnosticHistoryFindings';
import { i18nService } from '@/services/i18n';

import {
  presentDiagnosticCoverage,
  presentDiagnosticFinding,
  presentDiagnosticRuntimeFailure,
  presentDiagnosticStop,
  visibleDiagnosticFindings,
} from './sessionDiagnosticsPresentation';

const t = (key: string) => i18nService.t(key);
const date = (value: number) =>
  new Date(value).toLocaleString(i18nService.getLanguage() === 'zh' ? 'zh-CN' : 'en-US');
const number = (value: number) =>
  value.toLocaleString(i18nService.getLanguage() === 'zh' ? 'zh-CN' : 'en-US');
const bytes = (value: number) =>
  value >= 1048576 ? `${(value / 1048576).toFixed(1)} MiB` : `${(value / 1024).toFixed(1)} KiB`;
const sources = {
  main: { icon: Squares2X2Icon, tone: 'violet' },
  cowork: { icon: BoltIcon, tone: 'blue' },
  gateway: { icon: ServerStackIcon, tone: 'teal' },
  native: { icon: CommandLineIcon, tone: 'orange' },
} as const;

function SectionHeading({
  icon: Icon,
  title,
  count,
}: {
  icon: typeof ClockIcon;
  title: string;
  count?: number;
}) {
  return (
    <div className="diagnostics-section-heading">
      <h3>
        <Icon aria-hidden="true" />
        {title}
      </h3>
      {count !== undefined && <span className="diagnostics-count">{number(count)}</span>}
    </div>
  );
}

export function DiagnosticOverview({ report }: { report: DiagnosticReport }) {
  const stop = presentDiagnosticStop(report);
  const reason = stop.reason;
  const { certainty } = stop;
  const showStop = reason !== 'unknown' || stop.specifics.length > 0;
  const advice =
    ['completed', 'failed', 'unknown', 'running'].includes(reason) && !stop.modelReplyEnded
      ? undefined
      : stop.advice;
  const tone = [
    'failed',
    'timeout',
    'conflict',
    'reasoning_only',
    'empty_response',
    'incomplete_response',
  ].includes(reason)
    ? 'red'
    : ['running', 'waiting'].includes(reason)
      ? 'blue'
      : 'amber';
  return (
    <>
      {showStop && (
        <section
          className={`diagnostics-answer diagnostics-tone-${tone}`}
          aria-label={t('diagnosticsStopTitle')}
        >
          <div className="diagnostics-answer-heading">
            <SectionHeading icon={StopCircleIcon} title={t('diagnosticsStopTitle')} />
            {certainty === 'observed' && (
              <span className="diagnostics-answer-badge">{t('diagnosticsAnswer_observed')}</span>
            )}
          </div>
          {reason !== 'unknown' && (
            <p className="diagnostics-answer-title">
              {reason === 'completed' && !stop.modelReplyEnded
                ? t('diagnosticsTurnEnded')
                : stop.title}
            </p>
          )}
          {stop.specifics.length > 0 && (
            <ul className="diagnostics-answer-specifics">
              {stop.specifics.map(detail => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          )}
          {advice && <p className="diagnostics-stop-advice">{advice}</p>}
        </section>
      )}
      <DiagnosticFindings report={report} />
    </>
  );
}

export function DiagnosticCollectionSummary({ report }: { report: DiagnosticReport }) {
  const coverage = presentDiagnosticCoverage(report);
  return (
    <section
      className="diagnostics-collection-summary"
      aria-label={t('diagnosticsCollectionTitle')}
    >
      <SectionHeading icon={CircleStackIcon} title={t('diagnosticsCollectionTitle')} />
      <p>{coverage.counts}</p>
      {coverage.logsCollected && <p className="diagnostics-muted">{coverage.association}</p>}
      {coverage.window && <p className="diagnostics-muted">{coverage.window}</p>}
      {(coverage.sourceLines.length > 0 || coverage.notes.length > 0) && (
        <ul>
          {[...coverage.sourceLines, ...coverage.notes].map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function DiagnosticRunDetails({ report }: { report: DiagnosticReport }) {
  return (
    <div className="diagnostics-overview-meta">
      {report.run ? (
        <div>
          <span>{t('diagnosticsRecordedState')}</span>
          <strong className={`diagnostics-state-${report.run.state}`}>
            {t(`diagnosticsState_${report.run.state}`)}
          </strong>
          <small>
            {date(report.run.startedAt)}
            {report.run.endedAt !== undefined && ` – ${date(report.run.endedAt)}`}
          </small>
        </div>
      ) : (
        <p>{t('diagnosticsNoRun')}</p>
      )}
      <div>
        <span>{t('diagnosticsCollected')}</span>
        <strong>{date(report.collectedAt)}</strong>
      </div>
      {report.conclusion.toolFailures > 0 && (
        <div>
          {t('diagnosticsToolFailureCount').replace(
            '{count}',
            number(report.conclusion.toolFailures),
          )}
        </div>
      )}
    </div>
  );
}

function DiagnosticFindings({ report }: { report: DiagnosticReport }) {
  const findings = visibleDiagnosticFindings(report);
  const history = report.history;
  const failures = history?.failures ?? [];
  const related = findings.filter(item => ['event', 'run'].includes(item.association));
  const others = findings.filter(item => !['event', 'run'].includes(item.association));
  const hasFailures = related.length > 0 || failures.length > 0;
  if (!hasFailures && !others.length) return null;
  const cards = (items: DiagnosticFinding[]) => (
    <ul className="diagnostics-finding-list">
      {items.map(finding => {
        const presentation = presentDiagnosticFinding(finding, report);
        return (
          <li
            key={finding.signal}
            className={`diagnostics-finding-card diagnostics-tone-${
              ['tool', 'permission', 'storage'].includes(finding.signal)
                ? 'violet'
                : ['network', 'tls', 'disconnect'].includes(finding.signal)
                  ? 'blue'
                  : 'amber'
            }`}
          >
            <div className="diagnostics-finding-heading">
              <ExclamationTriangleIcon aria-hidden="true" />
              <strong>{presentation.title}</strong>
              <span>{t(`diagnosticsFindingAssociation_${finding.association}`)}</span>
            </div>
            {['event', 'run'].includes(finding.association) ? (
              <>
                {presentation.toolLimit ? (
                  <p>
                    {t('diagnosticsFailureTimes')}:{' '}
                    {[
                      ...new Set(
                        presentation.rows.map(row =>
                          row.time === undefined ? t('diagnosticsLogsUnknownTime') : date(row.time),
                        ),
                      ),
                    ]
                      .slice(0, 5)
                      .join(' / ')}
                  </p>
                ) : (
                  <FindingEvidence finding={finding} report={report} compact />
                )}
                <p className="diagnostics-finding-action">
                  <strong>{t('diagnosticsNextStep')}</strong> {presentation.advice}
                </p>
              </>
            ) : null}
            {!presentation.toolLimit && (
              <details>
                <summary>
                  {t('diagnosticsFindingEvidence')} (
                  {finding.eventIds.length + finding.logIds.length})
                </summary>
                <FindingEvidence finding={finding} report={report} />
              </details>
            )}
          </li>
        );
      })}
    </ul>
  );
  return (
    <section className="diagnostics-panel diagnostics-findings">
      {hasFailures && (
        <SectionHeading
          icon={MagnifyingGlassIcon}
          title={t('diagnosticsReportTitle')}
          count={related.length + failures.length}
        />
      )}
      {failures.length > 0 && (
        <ul className="diagnostics-finding-list">
          {failures.map((failure, index) => (
            <li key={index} className="diagnostics-finding-card diagnostics-tone-violet">
              <div className="diagnostics-finding-heading">
                <ExclamationTriangleIcon aria-hidden="true" />
                <strong>
                  {failure.tool ??
                    t(
                      failure.kind === 'tool'
                        ? 'diagnosticsKind_tool'
                        : failure.kind === 'runtime'
                          ? 'diagnosticsHistoryRuntime'
                          : 'diagnosticsHistoryModel',
                    )}{' '}
                  · {t(`diagnosticsHistoryOutcome_${failure.outcome ?? 'failed'}`)}
                </strong>
                <span>{t(`diagnosticsHistoryAssociation_${failure.association}`)}</span>
              </div>
              <p className="diagnostics-muted">{date(failure.timestamp)}</p>
              {failure.basis && (
                <p className="diagnostics-muted">{t(`diagnosticsHistoryBasis_${failure.basis}`)}</p>
              )}
              <pre className="diagnostics-history-error">
                {failure.excerpt || t('diagnosticsHistoryNoText')}
              </pre>
              <p>{t(diagnoseHistoryFailure(failure).adviceKey)}</p>
              {diagnoseHistoryFailure(failure).inferred && (
                <p className="diagnostics-muted">{t('diagnosticsHistoryInferred')}</p>
              )}
              {failure.clipped && (
                <p className="diagnostics-muted">{t('diagnosticsHistoryClipped')}</p>
              )}
            </li>
          ))}
        </ul>
      )}
      {related.length > 0 && cards(related)}
      {others.length > 0 && (
        <details className="diagnostics-other-clues">
          <summary>
            {t('diagnosticsOtherClues')} ({others.length})
          </summary>
          {cards(others)}
        </details>
      )}
    </section>
  );
}

function FindingEvidence({
  finding,
  report,
  compact = false,
}: {
  compact?: boolean;
  finding: DiagnosticFinding;
  report: DiagnosticReport;
}) {
  const presentation = presentDiagnosticFinding(finding, report);
  const rows = [...presentation.rows]
    .sort((a, b) => (compact ? b.detail - a.detail : 0) || (a.time ?? 0) - (b.time ?? 0))
    .map((group, index) => (
      <div key={index} className="diagnostics-evidence-row">
        <strong>{group.description}</strong>
        <p>
          {group.time === undefined ? t('diagnosticsLogsUnknownTime') : date(group.time)} ·{' '}
          {[...group.sources].join(' / ')}
        </p>
        {group.count > 1 && (
          <p>{t('diagnosticsEvidenceGrouped').replace('{count}', number(group.count))}</p>
        )}
      </div>
    ));
  if (compact) return <div className="diagnostics-location">{rows.slice(0, 1)}</div>;
  return (
    <>
      {rows.slice(0, 5)}
      {rows.length > 5 && (
        <details>
          <summary>
            {t('diagnosticsEvidenceMore').replace('{count}', number(rows.length - 5))}
          </summary>
          {rows.slice(5)}
        </details>
      )}
    </>
  );
}

function SourceCard({ source }: { source: DiagnosticLogCoverage }) {
  const { icon: Icon, tone } = sources[source.source];
  const complete = source.scanComplete === true && !diagnosticSourceHasGaps(source);
  return (
    <li className={`diagnostics-source-card diagnostics-tone-${tone}`}>
      <div className="diagnostics-source-heading">
        <span className="diagnostics-source-icon">
          <Icon aria-hidden="true" />
        </span>
        <div>
          <h4>
            {t(`diagnosticsSource_${source.source}`)} ·{' '}
            {t(`diagnosticsSourceStatus_${source.status}`)}
          </h4>
          <span className={`diagnostics-source-state is-${complete ? 'complete' : 'partial'}`}>
            <span />
            {t(complete ? 'diagnosticsScanDoneShort' : 'diagnosticsScanGapShort')}
          </span>
        </div>
      </div>
      <dl className="diagnostics-source-metrics">
        <div>
          <dt>{t('diagnosticsLogsFiles')}</dt>
          <dd>{number(source.filesRead)}</dd>
        </div>
        <div>
          <dt>{t('diagnosticsDataScanned')}</dt>
          <dd>{bytes(source.bytesRead)}</dd>
        </div>
        <div>
          <dt>{t('diagnosticsLogsEmitted')}</dt>
          <dd>{number(source.emitted)}</dd>
        </div>
      </dl>
      {Object.keys(source.signalCounts ?? {}).length > 0 && (
        <div className="diagnostics-signal-chips">
          {Object.entries(source.signalCounts ?? {}).map(([signal, count]) => (
            <span key={signal}>
              {t(`diagnosticsLogSignal_${signal}`)}
              <b>{number(count!)}</b>
            </span>
          ))}
        </div>
      )}
      <details className="diagnostics-source-details">
        <summary>
          {t('diagnosticsCoverageDetails')}
          <ChevronDownIcon aria-hidden="true" />
        </summary>
        <div className="diagnostics-source-detail-content">
          <p>{t(source.scanComplete ? 'diagnosticsScanComplete' : 'diagnosticsScanIncomplete')}</p>
          <p>
            {t('diagnosticsLogsRead')}: {number(source.recordsRead)} ·{' '}
            {t('diagnosticsLogsSuppressed')}: {number(source.suppressed)} ·{' '}
            {t('diagnosticsLogsMalformed')}: {number(source.parseFailures)}
          </p>
          {source.matched !== undefined && (
            <p>
              {t('diagnosticsMatched')}: {number(source.matched)} · {t('diagnosticsOutputOmitted')}:{' '}
              {number(source.outputOmitted ?? 0)}
            </p>
          )}
          {source.truncated && <p>{t('diagnosticsLogsTail')}</p>}
          {source.reasons.map(reason => (
            <p key={reason}>{t(`diagnosticsLogReason_${reason}`)}</p>
          ))}
        </div>
      </details>
    </li>
  );
}

export function DiagnosticEvidence({ report }: { report: DiagnosticReport }) {
  const [filter, setFilter] = useState<'all' | 'alerts'>('all');
  const logs = report.logs;
  const records =
    logs?.records.filter(record => filter === 'all' || ['error', 'warn'].includes(record.level)) ??
    [];
  return (
    <section className="diagnostics-evidence-section">
      <SectionHeading icon={CircleStackIcon} title={t('diagnosticsLogsTitle')} />
      <p className="diagnostics-section-description">{t('diagnosticsLogsScope')}</p>
      {!logs ? (
        <div className="diagnostics-empty diagnostics-empty-logs">
          <CircleStackIcon aria-hidden="true" />
          <p>{t('diagnosticsLogsNotCollected')}</p>
        </div>
      ) : (
        <>
          <ul className="diagnostics-sources">
            {logs.sources.map(source => (
              <SourceCard key={source.source} source={source} />
            ))}
          </ul>
          <div className="diagnostics-log-context">
            <p>
              <ClockIcon aria-hidden="true" />
              {t('diagnosticsLogsWindow')}: {date(logs.window.from)} – {date(logs.window.to)}
            </p>
            <p>
              {t('diagnosticsLogsTimezone')}: UTC{logs.localTimezoneOffsetMinutes <= 0 ? '+' : '−'}
              {Math.floor(Math.abs(logs.localTimezoneOffsetMinutes) / 60)
                .toString()
                .padStart(2, '0')}
              :{(Math.abs(logs.localTimezoneOffsetMinutes) % 60).toString().padStart(2, '0')}
            </p>
            <p>
              {t('diagnosticsCollected')}: {date(logs.collectedAt)}
            </p>
            <p>{t('diagnosticsLogsPartial')}</p>
          </div>
          <details className="diagnostics-records">
            <summary>
              <span>
                <CodeBracketIcon aria-hidden="true" />
                {t('diagnosticsLogsRecords')}{' '}
                <b className="diagnostics-count">{number(logs.records.length)}</b>
              </span>
              <ChevronDownIcon aria-hidden="true" />
            </summary>
            <div
              className="diagnostics-record-filters"
              role="group"
              aria-label={t('diagnosticsFilterLabel')}
            >
              {(['all', 'alerts'] as const).map(value => (
                <button
                  key={value}
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                >
                  {t(value === 'all' ? 'diagnosticsFilterAll' : 'diagnosticsFilterAlerts')}
                </button>
              ))}
              <span>
                {number(records.length)} / {number(logs.records.length)}
              </span>
            </div>
            {records.length === 0 ? (
              <div className="diagnostics-empty">
                <MagnifyingGlassIcon aria-hidden="true" />
                <p>{t('diagnosticsNoMatchingRecords')}</p>
              </div>
            ) : (
              <ol className="diagnostics-record-list">
                {records.map(record => (
                  <li
                    key={record.id}
                    className={`diagnostics-record diagnostics-level-${record.level}`}
                  >
                    <div className="diagnostics-record-heading">
                      <span className="diagnostics-level-badge">
                        {t(`diagnosticsLogLevel_${record.level}`)}
                      </span>
                      <strong>{t(`diagnosticsLogSignal_${record.signal}`)}</strong>
                      <span className="diagnostics-record-source">
                        {t(`diagnosticsSource_${record.source}`)}
                      </span>
                    </div>
                    <p className="diagnostics-record-time">
                      {record.timestamp === undefined
                        ? t('diagnosticsLogsUnknownTime')
                        : date(record.timestamp)}{' '}
                      · {t(`diagnosticsAssociation_${record.association}`)}
                      {record.inferred ? ` · ${t('diagnosticsLogsInferred')}` : ''}
                    </p>
                    {Object.keys(record.metrics).length > 0 && (
                      <div className="diagnostics-record-metrics">
                        {Object.entries(record.metrics).map(([metric, value]) => (
                          <span key={metric}>
                            {t(`diagnosticsMetric_${metric}`)}: {value}
                          </span>
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </details>
        </>
      )}
    </section>
  );
}

const eventIcons = {
  lifecycle: BoltIcon,
  chat: ChatBubbleLeftRightIcon,
  tool: WrenchScrewdriverIcon,
  command: CommandLineIcon,
  connection: WifiIcon,
  cancel: StopCircleIcon,
};
function eventTone(event: DiagnosticEvent) {
  if (
    event.errorCategory ||
    event.toolFailed ||
    ['error', 'failed'].includes(event.phase) ||
    ['timeout', 'error'].includes(event.stopReason ?? '')
  )
    return 'red';
  if (event.aborted || ['aborted', 'disconnected'].includes(event.phase)) return 'amber';
  return event.kind === 'tool' ? 'violet' : event.kind === 'connection' ? 'teal' : 'blue';
}

export function DiagnosticTimeline({ report }: { report: DiagnosticReport }) {
  return (
    <section className="diagnostics-panel diagnostics-timeline-panel">
      <SectionHeading
        icon={ClockIcon}
        title={t('diagnosticsTimeline')}
        count={report.events.length}
      />
      {!report.events.length ? (
        <div className="diagnostics-empty">
          <ClockIcon aria-hidden="true" />
          <strong>{t('diagnosticsTimelineEmpty')}</strong>
          <p>{t('diagnosticsNoRecord')}</p>
        </div>
      ) : (
        <ol className="diagnostics-timeline">
          {report.events.map(event => {
            const Icon = eventIcons[event.kind];
            const runtimeFailure = presentDiagnosticRuntimeFailure(event);
            return (
              <li
                key={event.id}
                className={`diagnostics-timeline-event diagnostics-tone-${eventTone(event)}`}
              >
                <span className="diagnostics-timeline-dot">
                  <Icon aria-hidden="true" />
                </span>
                <div className="diagnostics-timeline-content">
                  <div className="diagnostics-timeline-title">
                    <strong>{t(`diagnosticsKind_${event.kind}`)}</strong>
                    <span>{t(`diagnosticsPhase_${event.phase}`)}</span>
                  </div>
                  {event.kind === 'lifecycle' &&
                    (event.executionSettled === true ? (
                      <p className="diagnostics-event-label">{t('diagnosticsRunTerminal')}</p>
                    ) : ['finishing', 'end', 'error'].includes(event.phase) ? (
                      <p className="diagnostics-muted">{t('diagnosticsAttemptObservation')}</p>
                    ) : null)}
                  {event.errorCategory && (
                    <p className="diagnostics-event-error">
                      {t(`diagnosticsCategory_${event.errorCategory}`)}
                    </p>
                  )}
                  {runtimeFailure && (
                    <>
                      <p className="diagnostics-event-error">{runtimeFailure.title}</p>
                      <p className="diagnostics-muted">{t(runtimeFailure.adviceKey)}</p>
                    </>
                  )}
                  <p className="diagnostics-event-time">
                    {t('diagnosticsObserved')}: {date(event.observedAt)}
                    {event.occurredAt !== undefined && (
                      <>
                        {' '}
                        · {t('diagnosticsOccurred')}: {date(event.occurredAt)}
                      </>
                    )}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

export function DiagnosticEnvironment({ report }: { report: DiagnosticReport }) {
  return (
    <section className="diagnostics-panel diagnostics-environment">
      <SectionHeading icon={SignalIcon} title={t('diagnosticsEnvironmentTitle')} />
      <div
        className={`diagnostics-connection ${report.connection === 'connected' ? 'is-connected' : ''}`}
      >
        <WifiIcon aria-hidden="true" />
        <span>{t(`diagnosticsConnection_${report.connection}`)}</span>
      </div>
      <div className="diagnostics-environment-status">
        <span className="diagnostics-environment-icon">
          <ArrowPathIcon aria-hidden="true" />
        </span>
        <p>{t(`diagnosticsEnvironment_${report.environment.status}`)}</p>
      </div>
      <p className="diagnostics-section-description">{t('diagnosticsEnvironment')}</p>
      {report.environment.signals && (
        <>
          <p className="diagnostics-muted">{t('diagnosticsEnvironmentScope')}</p>
          {report.environment.firstAt !== undefined && report.environment.lastAt !== undefined && (
            <p className="diagnostics-muted">
              {date(report.environment.firstAt)} – {date(report.environment.lastAt)}
            </p>
          )}
          {Object.entries(report.environment.signals).map(([key, count]) => (
            <p key={key}>
              {t(`diagnosticsEnvironmentSignal_${key}`)}: {number(count)}
            </p>
          ))}
          {Object.keys(report.environment.signals).length === 0 && (
            <p>{t('diagnosticsEnvironmentNoSignals')}</p>
          )}
        </>
      )}
      {report.environment.collectedAt !== undefined && (
        <p className="diagnostics-muted">
          {t('diagnosticsCollected')}: {date(report.environment.collectedAt)}
        </p>
      )}
      {report.environment.stabilityCount !== undefined && (
        <p className="diagnostics-environment-count">
          {t('diagnosticsEnvironmentCount')}: {report.environment.stabilityCount}
        </p>
      )}
      {report.environment.stabilityDropped !== undefined && (
        <p className="diagnostics-environment-count">
          {t('diagnosticsEnvironmentDropped')}: {report.environment.stabilityDropped}
        </p>
      )}
    </section>
  );
}
