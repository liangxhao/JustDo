import { XMarkIcon } from '@heroicons/react/24/outline';
import type { ScheduledTaskRun } from '@shared/scheduledTask/types';
import { useEffect, useId, useRef } from 'react';

import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/ui/Modal';

import RunDiagnostics from './RunDiagnostics';
import { formatDateTime, formatDuration, getStatusLabelKey, getStatusTone } from './utils';

export default function RunDetailsModal({
  run,
  title,
  onClose,
}: {
  run: ScheduledTaskRun;
  title: string;
  onClose: () => void;
}) {
  const t = i18nService.t.bind(i18nService);
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [tabindex="0"]',
      );
      const first = items?.[0];
      const last = items?.[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener('keydown', handleKey, true);
    return () => {
      window.removeEventListener('keydown', handleKey, true);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  return (
    <Modal
      onClose={onClose}
      className="mx-4 w-full max-w-2xl overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[85vh] flex-col"
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border-subtle px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold text-foreground">
              {t('scheduledTasksResultsRunDetails')}
            </h2>
            <p className="mt-1 truncate text-sm text-secondary" title={title}>
              {title}
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label={t('close')}
            className="rounded-lg p-1 text-secondary hover:bg-surface-raised"
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>
        <div
          tabIndex={0}
          className="min-h-0 space-y-5 overflow-y-auto px-5 py-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40"
        >
          <p className={`text-sm font-medium ${getStatusTone(run.status)}`}>
            {t(getStatusLabelKey(run.status))}
          </p>
          <dl className="grid gap-4 rounded-xl bg-surface-raised/60 p-4 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-secondary">{t('scheduledTasksRunStartedAt')}</dt>
              <dd className="mt-1 text-foreground">{formatDateTime(new Date(run.startedAt))}</dd>
            </div>
            <div>
              <dt className="text-xs text-secondary">{t('scheduledTasksRunFinishedAt')}</dt>
              <dd className="mt-1 text-foreground">
                {run.finishedAt ? formatDateTime(new Date(run.finishedAt)) : '—'}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-secondary">{t('scheduledTasksRunDuration')}</dt>
              <dd className="mt-1 text-foreground">
                {run.durationMs === null ? '—' : formatDuration(run.durationMs)}
              </dd>
            </div>
          </dl>
          <RunDiagnostics run={run} expanded />
        </div>
      </div>
    </Modal>
  );
}
