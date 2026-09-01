import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import type { AppReleaseHistory, AppUpdateState } from '@shared/appUpdate';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import { selectNewerAppUpdateState } from '@/features/settings/appUpdateState';
import { toSanitizedMarkdownHtml } from '@/libs/openclaw-chat/components/markdown';
import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/common/Modal';

const INITIAL_STATE: AppUpdateState = {
  revision: -1,
  phase: 'idle',
  currentVersion: '',
};

const statusKeyByPhase: Record<AppUpdateState['phase'], string> = {
  idle: 'appUpdateStatusIdle',
  checking: 'appUpdateStatusChecking',
  available: 'appUpdateStatusAvailable',
  downloading: 'appUpdateStatusDownloading',
  downloaded: 'appUpdateStatusDownloaded',
  'up-to-date': 'appUpdateStatusUpToDate',
  error: 'appUpdateStatusError',
  unsupported: 'appUpdateStatusUnsupported',
};

const statusPresentationByPhase: Record<
  AppUpdateState['phase'],
  { icon: React.ComponentType<React.SVGProps<SVGSVGElement>>; iconClassName: string }
> = {
  idle: {
    icon: InformationCircleIcon,
    iconClassName: 'bg-primary-muted text-primary',
  },
  checking: {
    icon: ArrowPathIcon,
    iconClassName: 'bg-primary-muted text-primary',
  },
  available: {
    icon: ArrowDownTrayIcon,
    iconClassName: 'bg-primary-muted text-primary',
  },
  downloading: {
    icon: ArrowDownTrayIcon,
    iconClassName: 'bg-primary-muted text-primary',
  },
  downloaded: {
    icon: CheckCircleIcon,
    iconClassName: 'bg-green-500/10 text-green-600 dark:text-green-400',
  },
  'up-to-date': {
    icon: CheckCircleIcon,
    iconClassName: 'bg-green-500/10 text-green-600 dark:text-green-400',
  },
  error: {
    icon: ExclamationTriangleIcon,
    iconClassName: 'bg-red-500/10 text-red-600 dark:text-red-400',
  },
  unsupported: {
    icon: InformationCircleIcon,
    iconClassName: 'bg-surface-raised text-secondary',
  },
};

const AppUpdateSection: React.FC = () => {
  const [state, setState] = useState<AppUpdateState>(INITIAL_STATE);
  const [isReleaseHistoryOpen, setIsReleaseHistoryOpen] = useState(false);
  const [releaseHistory, setReleaseHistory] = useState<AppReleaseHistory>();
  const [expandedReleaseVersions, setExpandedReleaseVersions] = useState<Set<string>>(new Set());
  const [releaseHistoryStatus, setReleaseHistoryStatus] = useState<'idle' | 'loading' | 'error'>(
    'idle',
  );
  const releaseHistoryTriggerRef = useRef<HTMLButtonElement>(null);
  const releaseHistoryDialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    const unsubscribe = window.electron.appUpdate.onStateChanged(nextState => {
      if (active) setState(current => selectNewerAppUpdateState(current, nextState));
    });
    void window.electron.appUpdate
      .getState()
      .then(nextState => {
        if (active) setState(current => selectNewerAppUpdateState(current, nextState));
      })
      .catch(() => {
        if (active) {
          setState(current => ({ ...current, phase: 'error', errorCode: 'CHECK_FAILED' }));
        }
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!isReleaseHistoryOpen) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const dialog = releaseHistoryDialogRef.current;
    dialog?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setIsReleaseHistoryOpen(false);
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const focusableElements = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusableElements.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusableElements[0];
      const last = focusableElements[focusableElements.length - 1];
      if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === dialog)
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [isReleaseHistoryOpen]);

  const releaseNotesHtml = useMemo(
    () => (state.releaseNotes ? toSanitizedMarkdownHtml(state.releaseNotes) : ''),
    [state.releaseNotes],
  );
  const releaseHistoryEntries = useMemo(
    () =>
      releaseHistory?.releases.map(release => ({
        ...release,
        releaseNotesHtml: toSanitizedMarkdownHtml(release.releaseNotes),
      })) ?? [],
    [releaseHistory],
  );
  const isChecking = state.phase === 'checking';
  const canCheck =
    state.phase === 'idle' ||
    state.phase === 'up-to-date' ||
    (state.phase === 'error' && state.errorCode === 'CHECK_FAILED');
  const canDownload =
    state.phase === 'available' ||
    (state.phase === 'error' && state.errorCode === 'DOWNLOAD_FAILED');

  const handleCheck = async () => {
    try {
      await window.electron.appUpdate.check();
    } catch {
      setState(current => ({ ...current, phase: 'error', errorCode: 'CHECK_FAILED' }));
    }
  };

  const handleDownload = async () => {
    try {
      const result = await window.electron.appUpdate.download();
      if (!result.success) {
        setState(current => selectNewerAppUpdateState(current, result.state));
      }
    } catch {
      setState(current => ({ ...current, phase: 'error', errorCode: 'DOWNLOAD_FAILED' }));
    }
  };

  const handleInstall = async () => {
    try {
      const result = await window.electron.appUpdate.quitAndInstall();
      if (!result.success) {
        setState(current => selectNewerAppUpdateState(current, result.state));
      }
    } catch {
      setState(current => ({ ...current, phase: 'error', errorCode: 'INSTALL_FAILED' }));
    }
  };

  const loadReleaseHistory = async () => {
    setReleaseHistoryStatus('loading');
    try {
      const result = await window.electron.appUpdate.getReleaseHistory();
      if (!result.success || !result.history) {
        setReleaseHistoryStatus('error');
        return;
      }
      setReleaseHistory(result.history);
      setExpandedReleaseVersions(new Set([result.history.releases[0].version]));
      setReleaseHistoryStatus('idle');
    } catch {
      setReleaseHistoryStatus('error');
    }
  };

  const handleOpenReleaseHistory = () => {
    setIsReleaseHistoryOpen(true);
    if (releaseHistory) {
      setExpandedReleaseVersions(new Set([releaseHistory.releases[0].version]));
    }
    if (releaseHistoryStatus !== 'loading') {
      void loadReleaseHistory();
    }
  };

  const toggleReleaseVersion = (version: string) => {
    setExpandedReleaseVersions(current => {
      const next = new Set(current);
      if (next.has(version)) next.delete(version);
      else next.add(version);
      return next;
    });
  };

  const statusKey = (() => {
    if (state.phase !== 'error') return statusKeyByPhase[state.phase];
    if (state.errorCode === 'INSTALL_FAILED') return 'appUpdateStatusInstallError';
    if (state.errorCode === 'DOWNLOAD_FAILED') return 'appUpdateStatusDownloadError';
    return statusKeyByPhase.error;
  })();
  const statusText =
    state.phase === 'downloading' && typeof state.downloadPercent === 'number'
      ? `${i18nService.t(statusKey)} ${state.downloadPercent.toFixed(0)}%`
      : i18nService.t(statusKey);
  const statusPresentation = statusPresentationByPhase[state.phase];
  const StatusIcon = statusPresentation.icon;

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-lg font-semibold text-foreground">{i18nService.t('appUpdateTitle')}</h3>
        <p className="mt-1 text-sm text-secondary">{i18nService.t('appUpdateDescription')}</p>
      </div>
      <div className="space-y-4 rounded-2xl border border-border/60 bg-surface-raised/40 p-5 shadow-subtle">
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3.5">
            <div
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${statusPresentation.iconClassName}`}
            >
              <StatusIcon
                className={`h-5 w-5 ${isChecking ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
            </div>
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-medium text-foreground">{statusText}</p>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-secondary">
                {state.currentVersion && (
                  <span>
                    {i18nService.t('appUpdateCurrentVersion')}: {state.currentVersion}
                  </span>
                )}
                {state.availableVersion && (
                  <span>
                    {i18nService.t('appUpdateAvailableVersion')}: {state.availableVersion}
                  </span>
                )}
              </div>
            </div>
          </div>
          {canCheck && (
            <button
              type="button"
              onClick={() => void handleCheck()}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-primary/25 bg-primary-muted px-3.5 py-2 text-sm font-medium text-primary transition-colors hover:bg-primary/15"
            >
              <ArrowPathIcon className="h-4 w-4" aria-hidden="true" />
              {i18nService.t('appUpdateCheck')}
            </button>
          )}
          {isChecking && (
            <button
              type="button"
              disabled
              className="inline-flex shrink-0 cursor-not-allowed items-center gap-1.5 rounded-lg border border-border px-3.5 py-2 text-sm font-medium text-secondary opacity-50"
            >
              <ArrowPathIcon className="h-4 w-4 animate-spin" aria-hidden="true" />
              {i18nService.t('appUpdateChecking')}
            </button>
          )}
          {canDownload && (
            <button
              type="button"
              onClick={() => void handleDownload()}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
            >
              <ArrowDownTrayIcon className="h-4 w-4" aria-hidden="true" />
              {i18nService.t('appUpdateDownload')}
            </button>
          )}
          {state.phase === 'downloaded' && (
            <button
              type="button"
              onClick={() => void handleInstall()}
              className="inline-flex shrink-0 items-center rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
            >
              {i18nService.t('appUpdateRestartAndInstall')}
            </button>
          )}
        </div>

        {state.phase === 'downloading' && typeof state.downloadPercent === 'number' && (
          <div
            className="h-1.5 overflow-hidden rounded-full bg-border"
            role="progressbar"
            aria-label={i18nService.t('appUpdateDownloadProgress')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(state.downloadPercent)}
          >
            <div
              className="h-full rounded-full bg-primary transition-[width]"
              style={{ width: `${state.downloadPercent}%` }}
            />
          </div>
        )}

        {releaseNotesHtml && (
          <div className="border-t border-border/50 pt-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="text-xs font-medium text-secondary">
                {i18nService.t('appUpdateReleaseNotes')}
              </p>
              <button
                ref={releaseHistoryTriggerRef}
                type="button"
                onClick={handleOpenReleaseHistory}
                aria-haspopup="dialog"
                className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:opacity-80"
              >
                {i18nService.t('appUpdateViewReleaseHistory')}
                <ChevronDownIcon className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
            <div
              className="prose prose-sm max-w-none text-foreground dark:prose-invert"
              dangerouslySetInnerHTML={{ __html: releaseNotesHtml }}
            />
          </div>
        )}

        {!releaseNotesHtml && (
          <div className="border-t border-border/50 pt-3 text-right">
            <button
              ref={releaseHistoryTriggerRef}
              type="button"
              onClick={handleOpenReleaseHistory}
              aria-haspopup="dialog"
              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:opacity-80"
            >
              {i18nService.t('appUpdateViewReleaseHistory')}
              <ChevronDownIcon className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      <Modal
        isOpen={isReleaseHistoryOpen}
        onClose={() => setIsReleaseHistoryOpen(false)}
        overlayClassName="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-5 backdrop-blur-[2px]"
        className="flex max-h-[86vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-modal"
      >
        <div
          ref={releaseHistoryDialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="app-release-history-title"
          tabIndex={-1}
          className="outline-none"
        >
          <header className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
            <h2 id="app-release-history-title" className="text-base font-semibold text-foreground">
              {i18nService.t('appUpdateReleaseHistory')}
            </h2>
            <button
              type="button"
              onClick={() => setIsReleaseHistoryOpen(false)}
              aria-label={i18nService.t('close')}
              className="rounded-lg p-1.5 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
            >
              <XMarkIcon className="h-5 w-5" aria-hidden="true" />
            </button>
          </header>

          <div className="max-h-[calc(86vh-69px)] overflow-y-auto p-5">
            {releaseHistoryStatus === 'loading' && (
              <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-secondary">
                <ArrowPathIcon className="h-4 w-4 animate-spin" aria-hidden="true" />
                {i18nService.t('appUpdateReleaseHistoryLoading')}
              </div>
            )}
            {releaseHistoryStatus === 'error' && (
              <div className="flex min-h-48 flex-col items-center justify-center text-center text-sm text-secondary">
                <span>{i18nService.t('appUpdateReleaseHistoryError')}</span>
                <button
                  type="button"
                  onClick={() => void loadReleaseHistory()}
                  className="mt-3 rounded-lg bg-primary px-3 py-1.5 font-medium text-white hover:opacity-90"
                >
                  {i18nService.t('appUpdateReleaseHistoryRetry')}
                </button>
              </div>
            )}
            {releaseHistoryStatus === 'idle' && releaseHistory && (
              <div className="space-y-2">
                {releaseHistoryEntries.map(release => {
                  const isExpanded = expandedReleaseVersions.has(release.version);
                  const contentId = `app-release-${release.version.replace(/[^0-9A-Za-z_-]/g, '-')}`;
                  return (
                    <article
                      key={release.version}
                      className="overflow-hidden rounded-xl border border-border bg-surface-raised/40"
                    >
                      <button
                        type="button"
                        onClick={() => toggleReleaseVersion(release.version)}
                        aria-expanded={isExpanded}
                        aria-controls={contentId}
                        className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left hover:bg-surface-raised"
                      >
                        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                          <span className="text-sm font-semibold text-foreground">
                            v{release.version}
                          </span>
                          <time className="text-xs text-secondary" dateTime={release.releaseDate}>
                            {new Intl.DateTimeFormat(
                              i18nService.getLanguage() === 'zh' ? 'zh-CN' : 'en-US',
                              { year: 'numeric', month: 'short', day: 'numeric' },
                            ).format(new Date(release.releaseDate))}
                          </time>
                        </span>
                        {isExpanded ? (
                          <ChevronUpIcon
                            className="h-4 w-4 shrink-0 text-secondary"
                            aria-hidden="true"
                          />
                        ) : (
                          <ChevronDownIcon
                            className="h-4 w-4 shrink-0 text-secondary"
                            aria-hidden="true"
                          />
                        )}
                      </button>
                      {isExpanded && (
                        <div id={contentId} className="border-t border-border px-4 py-4">
                          <div
                            className="prose prose-sm max-w-none text-foreground dark:prose-invert"
                            dangerouslySetInnerHTML={{ __html: release.releaseNotesHtml }}
                          />
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </Modal>
    </section>
  );
};

export default AppUpdateSection;
