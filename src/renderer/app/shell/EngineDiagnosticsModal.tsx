import type {
  EngineDiagnosticReport,
  EngineDiagnosticResult,
  EngineDiagnosticsQuery,
} from '@shared/openclaw/engineDiagnostics';
import { useEffect, useId, useRef, useState } from 'react';

import type { OpenClawEngineStatus } from '@/features/cowork/coworkTypes';
import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/ui/Modal';

import {
  engineDiagnosticDate,
  engineDiagnosticText,
  engineLogCoverageText,
} from './engineDiagnosticsPresentation';

interface Props {
  status: OpenClawEngineStatus;
  commandError: string | null;
  onClose: () => void;
  onStart: () => void;
}

// Keep the Main scan slot serialized across modal unmounts as well as refreshes.
// Cancellation is acknowledged by the previous collection promise settling.
let collectionQueue: Promise<void> = Promise.resolve();

export default function EngineDiagnosticsModal({ status, commandError, onClose, onStart }: Props) {
  const [report, setReport] = useState<EngineDiagnosticReport>();
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [copying, setCopying] = useState(false);
  const [revision, setRevision] = useState(0);
  const closeButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const titleId = useId();
  const t = (key: string) => i18nService.t(key);

  useEffect(() => {
    let active = true;
    let query: EngineDiagnosticsQuery | undefined;
    setLoading(true);
    setReport(undefined);
    setFailure(undefined);
    setNotice(undefined);
    const api = window.electron?.openclaw?.engine;
    collectionQueue = collectionQueue.then(async () => {
      if (!active) return;
      try {
        query = { requestId: crypto.randomUUID(), diagnosticId: status.diagnosticId };
        const result: EngineDiagnosticResult = await api.collectDiagnostics(query);
        if (!active) return;
        if (result.success) setReport(result.report);
        else
          setFailure(
            result.reason === 'stale'
              ? 'engineDiagnosticsChanged'
              : 'engineDiagnosticsCollectFailed',
          );
      } catch {
        if (active) setFailure('engineDiagnosticsCollectFailed');
      } finally {
        if (active) setLoading(false);
      }
    });
    return () => {
      active = false;
      if (query) void api?.cancelDiagnostics?.(query).catch(() => {});
    };
  }, [status.diagnosticId, revision]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close.current();
      }
      if (event.key !== 'Tab') return;
      const buttons = dialog.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), summary, [tabindex="0"]',
      );
      if (!buttons?.length) return;
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', keyboard);
    return () => {
      document.removeEventListener('keydown', keyboard);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const copy = async () => {
    if (!report || loading || copying) return;
    setCopying(true);
    try {
      await navigator.clipboard.writeText(engineDiagnosticText(report, commandError));
      setNotice('engineDiagnosticsCopied');
    } catch {
      setNotice('engineDiagnosticsCopyFailed');
    } finally {
      setCopying(false);
    }
  };
  const button =
    'rounded-lg px-3 py-1.5 text-sm hover:bg-surface-raised disabled:opacity-50 disabled:cursor-not-allowed';
  return (
    <Modal
      onClose={onClose}
      overlayClassName="non-draggable fixed inset-0 z-[70] flex items-center justify-center bg-black/50"
      className="mx-4 flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-surface text-foreground shadow-xl"
    >
      <section
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex min-h-0 flex-col"
      >
        <header className="flex shrink-0 items-center justify-between border-b border-border px-5 py-4">
          <h2 id={titleId} className="text-base font-semibold">
            {t('engineDiagnosticsTitle')}
          </h2>
          <button ref={closeButton} className={button} onClick={onClose}>
            {t('windowClose')}
          </button>
        </header>
        <div
          className="min-h-0 space-y-4 overflow-auto px-5 py-4 text-sm select-text"
          aria-busy={loading}
        >
          <p className="whitespace-pre-wrap break-words text-secondary">
            {commandError || status.message || t('engineReasonUnavailable')}
          </p>
          {loading && (
            <p role="status" className="text-secondary">
              {t('engineDiagnosticsCollecting')}
            </p>
          )}
          {failure && (
            <p role="alert" className="text-red-600 dark:text-red-300">
              {t(failure)}
            </p>
          )}
          {report && (
            <>
              {report.engineChanged && (
                <p role="alert" className="text-amber-700 dark:text-amber-300">
                  {t('engineDiagnosticsChanged')}
                </p>
              )}
              <p className="text-xs text-secondary">{t('engineDiagnosticsCorrelation')}</p>
              <div className="space-y-3">
                <h3 className="font-medium">{t('engineDiagnosticsFindings')}</h3>
                {report.findings.length === 0 && (
                  <p className="text-secondary">{t('engineDiagnosticsNoCause')}</p>
                )}
                {report.findings.map(id => {
                  const item = report.evidence.find(e => e.id === id);
                  return (
                    item && (
                      <article key={id} className="rounded-lg border border-border p-3">
                        <h4 className="font-medium">
                          {t(`engineDiagnosticsCause_${item.category}`)}
                        </h4>
                        <p className="mt-1 text-xs text-secondary">
                          {item.source} · {engineDiagnosticDate(item.timestamp)}
                        </p>
                        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs">
                          {item.text}
                        </pre>
                        {item.truncated && (
                          <p className="text-xs text-secondary">
                            {t('engineDiagnosticsTruncated')}
                          </p>
                        )}
                      </article>
                    )
                  );
                })}
              </div>
              <details>
                <summary className="cursor-pointer font-medium">
                  {t('engineDiagnosticsSources')}
                </summary>
                <p className="mt-2 text-xs text-secondary">
                  {t('engineDiagnosticsWindow')}: {engineDiagnosticDate(report.window.from)} —{' '}
                  {engineDiagnosticDate(report.window.to)}
                </p>
                {report.coverage.map(item => (
                  <p key={item.source} className="mt-2 text-xs text-secondary">
                    {item.source}: {engineLogCoverageText(item)}
                  </p>
                ))}
              </details>
              <details>
                <summary className="cursor-pointer font-medium">
                  {t('engineDiagnosticsEvidence')}
                </summary>
                {report.evidence.map(item => (
                  <div key={item.id} className="mt-3">
                    <p className="text-xs text-secondary">
                      {item.source} · {engineDiagnosticDate(item.timestamp)} · {item.level}
                    </p>
                    <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">
                      {item.text}
                    </pre>
                    {item.truncated && (
                      <p className="text-xs text-secondary">{t('engineDiagnosticsTruncated')}</p>
                    )}
                  </div>
                ))}
              </details>
            </>
          )}
        </div>
        <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">
          {notice && (
            <span role="status" className="mr-auto text-xs text-secondary">
              {t(notice)}
            </span>
          )}
          <button
            className={button}
            disabled={loading}
            onClick={() => setRevision(value => value + 1)}
          >
            {t('engineDiagnosticsRefresh')}
          </button>
          <button
            className={button}
            disabled={loading || !report || copying}
            onClick={() => void copy()}
          >
            {t('engineDiagnosticsCopy')}
          </button>
          {status.canRetry && (
            <button
              type="button"
              onClick={onStart}
              className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-hover"
            >
              {t('engineStart')}
            </button>
          )}
        </footer>
      </section>
    </Modal>
  );
}
