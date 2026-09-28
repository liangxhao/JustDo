import {
  ArrowPathIcon,
  BoltIcon,
  ChatBubbleLeftRightIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  CircleStackIcon,
  ClockIcon,
  CodeBracketIcon,
  CommandLineIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  MagnifyingGlassIcon,
  ServerStackIcon,
  ShieldCheckIcon,
  SignalIcon,
  Squares2X2Icon,
  StopCircleIcon,
  WifiIcon,
  WrenchScrewdriverIcon,
} from '@heroicons/react/24/outline';
import type {
  DiagnosticEvent,
  DiagnosticLogCoverage,
  DiagnosticReport,
} from '@shared/cowork/sessionDiagnostics';
import { useState } from 'react';

import { i18nService } from '@/services/i18n';

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
  const reason = report.conclusion.reason;
  const tone = ['failed', 'timeout', 'conflict'].includes(reason)
    ? 'red'
    : reason === 'completed'
      ? 'teal'
      : ['running', 'waiting'].includes(reason)
        ? 'blue'
        : 'amber';
  const Icon =
    reason === 'completed'
      ? CheckCircleIcon
      : tone === 'red'
        ? ExclamationTriangleIcon
        : InformationCircleIcon;
  const logSources = report.logs?.sources ?? [];
  const completed = logSources.filter(source => source.scanComplete).length;
  const matched = logSources.reduce((sum, source) => sum + (source.matched ?? source.emitted), 0);
  const readBytes = logSources.reduce((sum, source) => sum + source.bytesRead, 0);
  const metrics = [
    {
      icon: ClockIcon,
      tone: 'blue',
      label: 'diagnosticsTimeline',
      value: number(report.events.length),
      hint: 'diagnosticsEventHint',
    },
    {
      icon: MagnifyingGlassIcon,
      tone: 'violet',
      label: 'diagnosticsMatched',
      value: report.logs ? number(matched) : '—',
      hint: 'diagnosticsMatchHint',
    },
    {
      icon: CircleStackIcon,
      tone: 'teal',
      label: 'diagnosticsDataScanned',
      value: report.logs ? bytes(readBytes) : '—',
      hint: 'diagnosticsDataHint',
    },
    {
      icon: ShieldCheckIcon,
      tone: 'orange',
      label: 'diagnosticsSourcesScanned',
      value: report.logs ? `${completed} / ${logSources.length}` : '—',
      hint: 'diagnosticsSourcesHint',
    },
  ];
  return (
    <>
      <section className={`diagnostics-overview diagnostics-tone-${tone}`}>
        <div className="diagnostics-overview-main">
          <span className="diagnostics-outcome-icon">
            <Icon aria-hidden="true" />
          </span>
          <div className="diagnostics-overview-copy">
            <div className="diagnostics-eyebrow">
              {t('diagnosticsOverview')}
              <span className="diagnostics-outcome-badge">
                {t(`diagnosticsConfidence_${report.conclusion.confidence}`)}
              </span>
            </div>
            <p className="diagnostics-conclusion">{t(`diagnosticsReason_${reason}`)}</p>
            <p className="diagnostics-overview-caption">{t('diagnosticsPartial')}</p>
          </div>
        </div>
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
        </div>
      </section>
      <div className="diagnostics-metrics">
        {metrics.map(({ icon: MetricIcon, ...metric }) => (
          <div className={`diagnostics-metric diagnostics-tone-${metric.tone}`} key={metric.label}>
            <span className="diagnostics-metric-label">
              <MetricIcon aria-hidden="true" />
              {t(metric.label)}
            </span>
            <strong>{metric.value}</strong>
            <small>{t(metric.hint)}</small>
          </div>
        ))}
      </div>
      {(report.coverage.dropped > 0 ||
        !!report.coverage.collectorDropped ||
        report.coverage.storageFailed ||
        report.conclusion.toolFailures > 0) && (
        <div className="diagnostics-coverage-notice">
          <InformationCircleIcon aria-hidden="true" />
          <div>
            {report.coverage.dropped > 0 && (
              <p>
                {t('diagnosticsDropped')}: {report.coverage.dropped}
              </p>
            )}
            {!!report.coverage.collectorDropped && (
              <p>
                {t('diagnosticsCollectorDropped')}: {report.coverage.collectorDropped}
              </p>
            )}
            {report.coverage.storageFailed && <p role="alert">{t('diagnosticsStorageFailed')}</p>}
            {report.conclusion.toolFailures > 0 && (
              <p>
                {t('diagnosticsToolFailures')}: {report.conclusion.toolFailures}
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function SourceCard({ source }: { source: DiagnosticLogCoverage }) {
  const { icon: Icon, tone } = sources[source.source];
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
          <span
            className={`diagnostics-source-state is-${source.scanComplete ? 'complete' : 'partial'}`}
          >
            <span />
            {t(source.scanComplete ? 'diagnosticsScanDoneShort' : 'diagnosticsScanGapShort')}
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
