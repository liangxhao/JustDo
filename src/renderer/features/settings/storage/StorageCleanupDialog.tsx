import { ArrowPathIcon, CheckCircleIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { StorageCleanupPhase, StorageDirectoryError } from '@shared/storage/storageDirectory';
import { useId, useRef } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/ui/Modal';
import { useDialogFocusTrap } from '@/shared/hooks/useDialogFocusTrap';

import CacheBroomIcon from './CacheBroomIcon';
import { type StorageCleanupFeedback, StorageCleanupView } from './useStorageCleanupFeedback';

export default function StorageCleanupDialog({ feedback, onConfirm }: {
  feedback: StorageCleanupFeedback;
  onConfirm: () => void;
}) {
  const t = (key: string) => i18nService.t(key);
  const titleId = useId();
  const descriptionId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const initialFocus = useRef<HTMLButtonElement>(null);
  useDialogFocusTrap(dialog, initialFocus, feedback.view ?? '', true, feedback.visible);
  if (!feedback.visible || !feedback.view) return null;
  const confirming = feedback.view === StorageCleanupView.Confirm;
  const refreshing = feedback.view === StorageCleanupView.Refreshing;
  const result = feedback.view === StorageCleanupView.Result;
  const success = result && feedback.outcome?.success;
  const phase = feedback.progress?.phase ?? StorageCleanupPhase.Preparing;
  const title = t('storageDirectoryClearCache');
  const failureCode = Object.values(StorageDirectoryError).includes(feedback.outcome?.error as StorageDirectoryError)
    ? feedback.outcome?.error : StorageDirectoryError.Unavailable;
  const message = confirming ? t('storageCleanupCacheConfirm')
    : result ? t(success ? 'storageDirectoryCacheCleared' : `storageDirectoryCacheError_${failureCode}`)
      : refreshing ? t('storageCleanupRefreshing') : t(`storageCleanupPhase_${phase}`);
  const Icon = confirming ? CacheBroomIcon : result ? success ? CheckCircleIcon : ExclamationTriangleIcon : ArrowPathIcon;
  const count = feedback.progress;
  const details = feedback.running && !refreshing && count?.sessionsTotal !== undefined
      ? t('storageCleanupSessions').replace('{done}', String(count.sessionsCompleted ?? 0)).replace('{total}', String(count.sessionsTotal))
      : undefined;
  return createPortal(
    <Modal onClose={feedback.close}
      overlayClassName="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4 backdrop-blur-[2px]"
      className="storage-cleanup-dialog w-full max-w-[420px] rounded-2xl border border-border bg-surface p-6 shadow-modal">
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}
        aria-busy={feedback.running} tabIndex={-1}
        onKeyDown={event => {
          event.stopPropagation();
          if (event.key === 'Escape') { event.preventDefault(); feedback.close(); }
        }}>
        <div className="flex items-center gap-3">
          <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${result
            ? success ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
            : 'bg-primary/10 text-primary'}`}>
            <Icon className={`h-5 w-5 ${feedback.running ? 'animate-spin' : ''}`} aria-hidden="true" />
          </span>
          <h3 id={titleId} className="text-base font-semibold text-foreground">{title}</h3>
        </div>
        <div id={descriptionId} className="mt-5 space-y-2" aria-live="polite">
          <p role={result && !success ? 'alert' : 'status'} className="text-sm leading-6 text-foreground">{message}</p>
          {details && <p className="text-xs tabular-nums text-secondary">{details}</p>}
          {feedback.running && (
            <>
              <div role="progressbar" aria-label={message} className="storage-cleanup-track mt-4 h-1.5 overflow-hidden rounded-full bg-primary/10">
                <span className="storage-cleanup-indicator block h-full w-1/3 rounded-full bg-primary" />
              </div>
              <p className="pt-1 text-xs tabular-nums text-secondary">{t('storageCleanupElapsed').replace('{seconds}', String(feedback.elapsed))}
                {feedback.progressUnavailable && ` · ${t('storageCleanupProgressUnavailable')}`}</p>
            </>
          )}
          {result && feedback.outcome?.scanFailed && <p className="text-xs text-secondary">{t('storageCleanupScanFailed')}</p>}
          {result && feedback.outcome?.unknown && <p className="text-xs text-secondary">{t('storageCleanupUnknown')}</p>}
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button ref={initialFocus} type="button" onClick={feedback.close}
            className={`rounded-lg px-3.5 py-2 text-sm ${confirming ? 'border border-border text-foreground hover:bg-surface-raised'
              : 'bg-primary text-white hover:bg-primary-hover'}`}>
            {t(confirming ? 'cancel' : feedback.running ? 'storageCleanupBackground' : 'storageCleanupDone')}
          </button>
          {confirming && <button type="button" onClick={onConfirm}
            className="rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-white hover:bg-primary-hover">
            {t('storageCleanupConfirm')}
          </button>}
        </div>
      </div>
    </Modal>, document.body,
  );
}
