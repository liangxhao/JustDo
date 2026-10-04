import './sessionDiagnostics.css';

import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  ChartBarSquareIcon,
  CheckCircleIcon,
  ClipboardDocumentIcon,
  CloudIcon,
  FolderOpenIcon,
  ShieldCheckIcon,
  StopIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { diagnoseHistoryFailure } from '@shared/cowork/diagnosticHistoryFindings';
import type {
  DiagnosticFailure,
  DiagnosticReadResult,
  DiagnosticReport,
  DiagnosticRun,
  DiagnosticScanProgress,
} from '@shared/cowork/sessionDiagnostics';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/common/Modal';

import {
  DiagnosticEnvironment,
  DiagnosticEvidence,
  DiagnosticOverview,
  DiagnosticTimeline,
} from './SessionDiagnosticsEvidence';
import {
  summarizeDiagnosticFinding,
  summarizeDiagnosticStop,
  visibleDiagnosticFindings,
} from './sessionDiagnosticsPresentation';

interface Props {
  sessionId: string;
  sessionTitle: string;
  isCollaboration?: boolean;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}

const t = (key: string) => i18nService.t(key);
const date = (timestamp: number) =>
  new Date(timestamp).toLocaleString(i18nService.getLanguage() === 'zh' ? 'zh-CN' : 'en-US');
const buttonClass = 'diagnostics-button';

export default function CoworkSessionDiagnosticsModal({
  sessionId,
  sessionTitle,
  isCollaboration,
  returnFocusRef,
  onClose,
}: Props) {
  const [runs, setRuns] = useState<DiagnosticRun[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [selected, setSelected] = useState('');
  const [report, setReport] = useState<DiagnosticReport>();
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<DiagnosticScanProgress>();
  const collectingQuery = useRef<{
    sessionId: string;
    sessionRunId?: string;
    snapshotId: string;
  }>();
  const [loading, setLoading] = useState(true);
  const [listing, setListing] = useState(false);
  const [working, setWorking] = useState<false | 'refresh' | 'collect' | 'export' | 'copy'>(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [missing, setMissing] = useState(false);
  const [revision, setRevision] = useState(0);
  const request = useRef(0);
  const mounted = useRef(false);
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const scanTask = useRef<Promise<DiagnosticReadResult>>();
  const collect = useCallback(
    async (
      query: { sessionId: string; sessionRunId?: string; snapshotId: string },
      token: number,
    ) => {
      if (collectingQuery.current)
        await window.electron.cowork.diagnostics.cancel?.(collectingQuery.current);
      await scanTask.current?.catch(() => {});
      if (!mounted.current || request.current !== token) return;
      collectingQuery.current = query;
      setScanning(true);
      setProgress(undefined);
      const task = window.electron.cowork.diagnostics.collect(query);
      scanTask.current = task;
      try {
        return await task;
      } finally {
        if (scanTask.current === task) {
          scanTask.current = undefined;
          if (mounted.current) setScanning(false);
        }
        if (collectingQuery.current === query) collectingQuery.current = undefined;
      }
    },
    [],
  );
  const titleId = useId();
  useEffect(() => {
    const unsubscribe = window.electron.cowork.diagnostics.onProgress?.(value => {
      if (value.snapshotId === collectingQuery.current?.snapshotId) setProgress(value);
    });
    return () => {
      unsubscribe?.();
      if (collectingQuery.current)
        void window.electron.cowork.diagnostics.cancel?.(collectingQuery.current);
    };
  }, []);

  useEffect(() => {
    mounted.current = true;
    const previous = returnFocusRef?.current ?? (document.activeElement as HTMLElement | null);
    // The originating row may be removed while this dialog is open. Capture its
    // ancestors so focus can return to the nearest surviving list container.
    const ancestors: HTMLElement[] = [];
    for (let node = previous?.parentElement; node; node = node.parentElement) ancestors.push(node);
    closeButton.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close.current();
      } else if (event.key === 'Tab') {
        const nodes = Array.from(
          dialog.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), select:not(:disabled), summary, [tabindex="0"]',
          ) ?? [],
        );
        const visibleNodes = nodes.filter(node => {
          const closed = node.closest('details:not([open])');
          return !closed || (node.tagName === 'SUMMARY' && node.parentElement === closed);
        });
        const first = visibleNodes[0];
        const last = visibleNodes[visibleNodes.length - 1];
        // Starting an action can disable the focused footer button. It remains
        // the active element, but native Tab would skip past the modal's end.
        const activeIsFocusable = visibleNodes.includes(document.activeElement as HTMLElement);
        if (event.shiftKey && (document.activeElement === first || !activeIsFocusable)) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !activeIsFocusable)) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', keydown, true);
    return () => {
      mounted.current = false;
      request.current += 1;
      document.removeEventListener('keydown', keydown, true);
      if (previous?.isConnected) previous.focus();
      else {
        const fallback = ancestors.find(node => node.isConnected);
        if (fallback) {
          const priorTabIndex = fallback.getAttribute('tabindex');
          fallback.tabIndex = -1;
          fallback.focus();
          if (priorTabIndex === null) fallback.removeAttribute('tabindex');
          else fallback.setAttribute('tabindex', priorTabIndex);
        }
      }
    };
  }, [returnFocusRef]);

  const fail = useCallback((failure: DiagnosticFailure) => {
    setError(t(`diagnosticsError_${failure.reason}`));
    if (failure.reason === 'missing') {
      request.current += 1;
      setLoading(false);
      setWorking(false);
      setReport(undefined);
      setMissing(true);
    }
  }, []);

  useEffect(() => {
    let active = true;
    setRuns([]);
    setCursor(undefined);
    setSelected('');
    setMissing(false);
    setListing(true);
    void window.electron.cowork.diagnostics
      .list({ sessionId })
      .then(result => {
        if (!active) return;
        if (result.success) {
          setRuns(result.runs);
          setCursor(result.nextCursor);
        } else fail(result);
      })
      .catch(() => {
        if (active) setError(t('diagnosticsError_unavailable'));
      })
      .finally(() => {
        if (active) setListing(false);
      });
    return () => {
      active = false;
    };
  }, [sessionId, fail]);

  useEffect(() => {
    const token = ++request.current;
    setReport(undefined);
    setLoading(true);
    setWorking(false);
    setNotice(undefined);
    setError(undefined);
    void window.electron.cowork.diagnostics
      .read({ sessionId, ...(selected ? { sessionRunId: selected } : {}) })
      .then(async result => {
        if (!mounted.current || token !== request.current) return;
        if (!result.success) {
          fail(result);
          return;
        }
        setReport(result.report);
        // Opening diagnostics requests a usable evidence bundle, including historical logs.
        // Keep local metadata visible if optional collection fails.
        if (!result.report.logs) {
          const query = {
            sessionId,
            sessionRunId: result.report.run?.id,
            snapshotId: result.report.snapshotId,
          };
          const collected = await collect(query, token);
          if (!collected || !mounted.current || token !== request.current) return;
          if (collected.success) setReport(collected.report);
          else fail(collected);
        }
      })
      .catch(() => {
        if (mounted.current && token === request.current)
          setError(t('diagnosticsError_unavailable'));
      })
      .finally(() => {
        if (mounted.current && token === request.current) setLoading(false);
      });
    return () => {
      request.current += 1;
    };
  }, [sessionId, selected, revision, fail, collect]);

  const loadMore = async () => {
    if (!cursor || listing) return;
    const targetSession = sessionId;
    const token = request.current;
    setListing(true);
    try {
      const result = await window.electron.cowork.diagnostics.list({
        sessionId: targetSession,
        cursor,
      });
      if (!mounted.current || token !== request.current) return;
      if (result.success) {
        setRuns(previous => [
          ...previous,
          ...result.runs.filter(run => !previous.some(item => item.id === run.id)),
        ]);
        setCursor(result.nextCursor);
      } else fail(result);
    } catch {
      if (mounted.current && token === request.current) setError(t('diagnosticsError_unavailable'));
    } finally {
      if (mounted.current) setListing(false);
    }
  };

  const perform = async (action: 'refresh' | 'collect' | 'export' | 'copy') => {
    if (!report || loading || working || missing) return;
    const snapshot = report;
    const token = request.current;
    const query = { sessionId, sessionRunId: snapshot.run?.id, snapshotId: snapshot.snapshotId };
    setWorking(action);
    setError(undefined);
    setNotice(undefined);
    try {
      if (action === 'copy') {
        await navigator.clipboard.writeText(
          [
            t('diagnosticsTitle'),
            `${t('diagnosticsCollected')}: ${date(snapshot.collectedAt)}`,
            summarizeDiagnosticStop(snapshot),
            ...(snapshot.history
              ? [
                  t(`diagnosticsHistory_${snapshot.history.status}`).replace(
                    '{count}',
                    String(snapshot.history.messagesScanned),
                  ),
                  ...(snapshot.history.reason
                    ? [t(`diagnosticsHistoryReason_${snapshot.history.reason}`)]
                    : []),
                  t('diagnosticsHistoryScope'),
                ]
              : []),
            ...(snapshot.history?.failures ?? []).map(
              failure =>
                `${date(failure.timestamp)} · ${failure.tool ?? t(failure.kind === 'tool' ? 'diagnosticsKind_tool' : failure.kind === 'runtime' ? 'diagnosticsHistoryRuntime' : 'diagnosticsHistoryModel')} · ${t(`diagnosticsHistoryOutcome_${failure.outcome ?? 'failed'}`)}\n${t(`diagnosticsHistoryAssociation_${failure.association}`)}\n${failure.excerpt || t('diagnosticsHistoryNoText')}\n${t(diagnoseHistoryFailure(failure).adviceKey)}${diagnoseHistoryFailure(failure).inferred ? `\n${t('diagnosticsHistoryInferred')}` : ''}`,
            ),
            ...visibleDiagnosticFindings(snapshot).map(finding =>
              summarizeDiagnosticFinding(finding, snapshot),
            ),
            t('diagnosticsPartial'),
            `${t('diagnosticsDropped')}: ${snapshot.coverage.dropped}`,
            ...(snapshot.coverage.collectorDropped
              ? [`${t('diagnosticsCollectorDropped')}: ${snapshot.coverage.collectorDropped}`]
              : []),
            ...(snapshot.coverage.storageFailed ? [t('diagnosticsStorageFailed')] : []),
            t(`diagnosticsConnection_${snapshot.connection}`),
          ].join('\n'),
        );
        if (mounted.current && token === request.current) setNotice(t('diagnosticsCopied'));
      } else if (action === 'refresh' || action === 'collect') {
        const result =
          action === 'collect'
            ? await collect(query, token)
            : await window.electron.cowork.diagnostics.refresh(query);
        if (!result || !mounted.current || token !== request.current) return;
        if (result.success) setReport(result.report);
        else fail(result);
      } else {
        const result = await window.electron.cowork.diagnostics.export(query);
        if (!mounted.current || token !== request.current) return;
        if (!result.success) fail(result);
        else if (!result.canceled) setNotice(t('diagnosticsExported'));
      }
    } catch {
      if (mounted.current && token === request.current)
        setError(
          t(
            action === 'copy'
              ? 'diagnosticsCopyFailed'
              : action === 'export'
                ? 'diagnosticsError_export_failed'
                : 'diagnosticsError_unavailable',
          ),
        );
    } finally {
      if (mounted.current && token === request.current) setWorking(false);
    }
  };

  const busy = loading || Boolean(working);
  const filePercent =
    progress && progress.fileBytesTotal > 0
      ? Math.min(
          100,
          Math.max(0, Math.round((progress.fileBytesRead / progress.fileBytesTotal) * 100)),
        )
      : undefined;

  return (
    <Modal onClose={onClose} className="diagnostics-modal" overlayClassName="diagnostics-overlay">
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="session-diagnostics"
      >
        <header className="diagnostics-header">
          <div className="diagnostics-brand">
            <span className="diagnostics-brand-icon">
              <ChartBarSquareIcon aria-hidden="true" />
            </span>
            <div className="diagnostics-heading">
              <div className="diagnostics-title-line">
                <h2 id={titleId}>{t('diagnosticsTitle')}</h2>
                <span className="diagnostics-local-badge">
                  <ShieldCheckIcon aria-hidden="true" />
                  {t('diagnosticsLocalBadge')}
                </span>
              </div>
              <p className="diagnostics-session-title" title={sessionTitle}>
                {sessionTitle}
              </p>
              {isCollaboration && <p className="diagnostics-muted">{t('diagnosticsMain')}</p>}
            </div>
          </div>
          <button
            ref={closeButton}
            className="diagnostics-icon-button"
            onClick={onClose}
            aria-label={t('close')}
            title={t('close')}
          >
            <XMarkIcon aria-hidden="true" />
          </button>
        </header>

        <div className="diagnostics-body">
          <div className="diagnostics-toolbar">
            <label className="diagnostics-run-picker">
              <span>
                <FolderOpenIcon aria-hidden="true" />
                {t('diagnosticsRun')}
              </span>
              <select
                aria-label={t('diagnosticsRun')}
                value={selected}
                disabled={missing}
                onChange={event => {
                  request.current += 1;
                  setReport(undefined);
                  setSelected(event.target.value);
                }}
              >
                <option value="">{t('diagnosticsLatest')}</option>
                {runs.map(run => (
                  <option key={run.id} value={run.id}>
                    {date(run.startedAt)} · {t(`diagnosticsState_${run.state}`)}
                  </option>
                ))}
              </select>
            </label>
            {cursor && (
              <button
                className={buttonClass}
                disabled={listing || missing}
                onClick={() => void loadMore()}
              >
                {t('diagnosticsMore')}
              </button>
            )}
            <span className="diagnostics-toolbar-note">
              <ShieldCheckIcon aria-hidden="true" />
              {t('diagnosticsPrivacyNote')}
            </span>
          </div>

          {(loading || scanning) && (
            <section className="diagnostics-scan" aria-label={t('diagnosticsScanTitle')}>
              <div className="diagnostics-scan-heading">
                <span className="diagnostics-scan-icon">
                  <ArrowPathIcon aria-hidden="true" />
                </span>
                <div className="diagnostics-scan-copy">
                  <p role="status">{t(report ? 'diagnosticsCollecting' : 'diagnosticsLoading')}</p>
                  {progress && (
                    <p className="diagnostics-muted">
                      {t(`diagnosticsSource_${progress.source}`)} · {t('diagnosticsScanProgress')}:{' '}
                      {progress.filesCompleted} · {(progress.bytesRead / 1048576).toFixed(1)} MiB
                    </p>
                  )}
                </div>
                {scanning && collectingQuery.current && (
                  <button
                    className="diagnostics-button diagnostics-button-quiet"
                    onClick={() => {
                      if (collectingQuery.current)
                        void window.electron.cowork.diagnostics.cancel(collectingQuery.current);
                    }}
                  >
                    <StopIcon aria-hidden="true" />
                    {t('diagnosticsCancelScan')}
                  </button>
                )}
              </div>
              {progress && (
                <div className="diagnostics-progress-caption">
                  <span>{t('diagnosticsCurrentFile')}</span>
                  <span>{filePercent === undefined ? '—' : `${filePercent}%`}</span>
                </div>
              )}
              <div
                className={`diagnostics-progress-track${filePercent === undefined ? ' is-indeterminate' : ''}`}
                role="progressbar"
                aria-label={t('diagnosticsCurrentFile')}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={filePercent}
              >
                <div style={filePercent === undefined ? undefined : { width: `${filePercent}%` }} />
              </div>
            </section>
          )}
          {working === 'export' && (
            <p role="status" className="diagnostics-section-description">
              {t('diagnosticsExportingLogs')}
            </p>
          )}
          {error && (
            <p role="alert" className="diagnostics-message diagnostics-message-error">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="diagnostics-message diagnostics-message-success">
              <CheckCircleIcon aria-hidden="true" />
              {notice}
            </p>
          )}

          {report && (
            <>
              <DiagnosticOverview report={report} />
              <details className="diagnostics-technical diagnostics-supporting">
                <summary>
                  <span>{t('diagnosticsSupporting')}</span>
                  <span className="diagnostics-muted">{t('diagnosticsSupportingHint')}</span>
                </summary>
                <DiagnosticEvidence report={report} />
                <div className="diagnostics-bottom-grid">
                  <DiagnosticTimeline report={report} />
                  <DiagnosticEnvironment report={report} />
                </div>
              </details>
              <details className="diagnostics-technical">
                <summary>
                  <span>{t('diagnosticsTechnical')}</span>
                  <span className="diagnostics-muted">{t('diagnosticsTechnicalHint')}</span>
                </summary>
                <pre>
                  {JSON.stringify(
                    {
                      sessionId: report.sessionId,
                      run: report.run,
                      conclusion: report.conclusion,
                      events: report.events,
                      logs: report.logs,
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
            </>
          )}
        </div>

        <footer className="diagnostics-footer">
          <div className="diagnostics-actions">
            <div className="diagnostics-secondary-actions">
              <button
                className={buttonClass}
                disabled={busy || missing}
                onClick={() => setRevision(value => value + 1)}
              >
                <ArrowPathIcon aria-hidden="true" />
                {t('diagnosticsRead')}
              </button>
              <button
                className={buttonClass}
                disabled={!report || busy || missing}
                onClick={() => void perform('collect')}
              >
                <FolderOpenIcon aria-hidden="true" />
                {t('diagnosticsCollect')}
              </button>
              <button
                className={buttonClass}
                disabled={!report || busy || report.connection !== 'connected' || missing}
                onClick={() => void perform('refresh')}
              >
                <CloudIcon aria-hidden="true" />
                {t('diagnosticsRefresh')}
              </button>
            </div>
            <div className="diagnostics-primary-actions">
              <button
                className={buttonClass}
                disabled={!report || busy || missing}
                onClick={() => void perform('copy')}
              >
                <ClipboardDocumentIcon aria-hidden="true" />
                {t('diagnosticsCopy')}
              </button>
              <button
                className="diagnostics-button diagnostics-button-primary"
                disabled={!report || busy || missing}
                onClick={() => void perform('export')}
              >
                <ArrowDownTrayIcon aria-hidden="true" />
                {t('diagnosticsExport')}
              </button>
            </div>
          </div>
          <p className="diagnostics-export-note">
            <ShieldCheckIcon aria-hidden="true" />
            {t('diagnosticsExportScope')}
          </p>
        </footer>
      </div>
    </Modal>
  );
}
