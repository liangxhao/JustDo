import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import type { AppUpdateState } from '@shared/appUpdate';
import React from 'react';

import { i18nService } from '@/services/i18n';

type AppUpdateToastProps = {
  state: AppUpdateState;
  installError: boolean;
  installing: boolean;
  onDownload: () => void;
  onDismiss: () => void;
  onInstall: () => void;
};

const AppUpdateToast: React.FC<AppUpdateToastProps> = ({
  state,
  installError,
  installing,
  onDownload,
  onDismiss,
  onInstall,
}) => {
  const isDownloading = state.phase === 'downloading';
  const isDownloadError = state.phase === 'error' && state.errorCode === 'DOWNLOAD_FAILED';
  const shouldDownload = state.phase === 'available' || isDownloadError;
  const isBusy = installing || isDownloading;
  const hasError = installError || isDownloadError;
  const statusText = (() => {
    if (installError) return i18nService.t('appUpdateStatusInstallError');
    if (isDownloadError) return i18nService.t('appUpdateStatusDownloadError');
    if (isDownloading) {
      const percent =
        typeof state.downloadPercent === 'number' ? ` ${state.downloadPercent.toFixed(0)}%` : '';
      return `${i18nService.t('appUpdateStatusDownloading')}${percent}`;
    }
    if (state.phase === 'available') return i18nService.t('appUpdateToastAvailable');
    return i18nService.t('appUpdateToastTitle');
  })();
  const actionLabel = isDownloading
    ? i18nService.t('appUpdateStatusDownloading')
    : shouldDownload
      ? i18nService.t('appUpdateDownload')
      : i18nService.t('appUpdateRestartAndInstall');

  return (
    <div className="pointer-events-auto max-w-full">
      <div
        className={`flex h-8 items-center gap-2 rounded-full border px-2.5 text-xs shadow-subtle ${
          hasError
            ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950 dark:text-red-300'
            : 'border-border/70 bg-surface text-secondary'
        }`}
        role="status"
        aria-live="polite"
        aria-busy={isBusy}
      >
        {hasError ? (
          <ExclamationTriangleIcon
            className="h-4 w-4 shrink-0 text-red-600 dark:text-red-300"
            aria-hidden="true"
          />
        ) : isDownloading ? (
          <ArrowPathIcon className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
        ) : state.phase === 'available' ? (
          <ArrowDownTrayIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        ) : (
          <CheckCircleIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        )}
        <span className="min-w-0 truncate">
          {statusText}
          {state.availableVersion ? ` (${state.availableVersion})` : ''}
        </span>
        <button
          type="button"
          onClick={shouldDownload ? onDownload : onInstall}
          disabled={isBusy}
          className={`ml-1 inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            hasError
              ? 'bg-red-600 text-white hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-600'
              : 'bg-primary text-white hover:bg-primary-hover'
          }`}
        >
          {isBusy && <ArrowPathIcon className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          {actionLabel}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          disabled={isBusy}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={i18nService.t('appUpdateLater')}
        >
          <XMarkIcon className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
};

export default AppUpdateToast;
