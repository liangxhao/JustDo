import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
} from '@heroicons/react/24/outline';
import type { AppUpdateState } from '@shared/appUpdate';
import React, { useEffect, useMemo, useState } from 'react';

import { selectNewerAppUpdateState } from '@/features/settings/appUpdateState';
import { toSanitizedMarkdownHtml } from '@/libs/openclaw-chat/components/markdown';
import { i18nService } from '@/services/i18n';

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

  const releaseNotesHtml = useMemo(
    () => (state.releaseNotes ? toSanitizedMarkdownHtml(state.releaseNotes) : ''),
    [state.releaseNotes],
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
            <p className="mb-2 text-xs font-medium text-secondary">
              {i18nService.t('appUpdateReleaseNotes')}
            </p>
            <div
              className="prose prose-sm max-w-none text-foreground dark:prose-invert"
              dangerouslySetInnerHTML={{ __html: releaseNotesHtml }}
            />
          </div>
        )}
      </div>
    </section>
  );
};

export default AppUpdateSection;
