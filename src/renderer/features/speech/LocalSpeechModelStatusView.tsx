import { CheckCircleIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import type { LocalSpeechModelStatus } from '@shared/speech/localSpeechModels';
import React from 'react';

import { i18nService } from '@/services/i18n';

const LocalSpeechModelStatusView: React.FC<{
  status: LocalSpeechModelStatus | null;
  loading: boolean;
  showInstallAction: boolean;
  showModelId?: boolean;
  onRetry: () => void;
  onRemove?: () => void;
}> = ({ status, loading, showInstallAction, showModelId = true, onRetry, onRemove }) => {
  const busy = status?.phase === 'downloading' || status?.phase === 'installing';
  const available = status?.phase === 'ready';
  const statusText = (() => {
    if (loading) return i18nService.t('voiceModelChecking');
    if (status?.phase === 'downloading') {
      return `${i18nService.t('voiceModelDownloading')} ${status.downloadPercent ?? 0}%`;
    }
    if (status?.phase === 'installing') return i18nService.t('voiceModelInstalling');
    if (available) return i18nService.t('voiceModelReady');
    if (status?.phase === 'error') return status.error || i18nService.t('voiceModelDownloadFailed');
    return i18nService.t('voiceModelNotInstalled');
  })();
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-secondary"
      role="status"
      aria-live="polite"
    >
      {loading || busy ? (
        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
      ) : available ? (
        <CheckCircleIcon className="h-4 w-4 text-green-500" />
      ) : (
        <ExclamationTriangleIcon className="h-4 w-4 text-amber-500" />
      )}
      <span>{statusText}</span>
      {showModelId && status?.id ? (
        <code className="max-w-full truncate rounded bg-surface-raised px-1.5 py-0.5">
          {status.id}
        </code>
      ) : null}
      {status?.downloadBytes ? (
        <span>{`${status.downloadBytesExact === false ? '≈' : ''}${(status.downloadBytes / 1024 / 1024).toFixed(1)} MiB`}</span>
      ) : null}
      {showInstallAction && (status?.phase === 'error' || status?.phase === 'not-installed') ? (
        <button
          type="button"
          onClick={onRetry}
          className="font-medium text-primary hover:underline"
        >
          {status.phase === 'error' ? i18nService.t('retry') : i18nService.t('voiceModelDownload')}
        </button>
      ) : null}
      {available && onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          className="font-medium text-secondary hover:underline"
        >
          {i18nService.t('voiceModelRemove')}
        </button>
      ) : null}
    </div>
  );
};

export default LocalSpeechModelStatusView;
