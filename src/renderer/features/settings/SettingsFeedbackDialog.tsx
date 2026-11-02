import { ExclamationTriangleIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { useEffect, useId, useRef } from 'react';

import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/ui/Modal';

interface SettingsFeedbackDialogProps {
  message: string;
  onClose: () => void;
  isError?: boolean;
}

export const SettingsFeedbackDialog = ({
  message,
  onClose,
  isError = true,
}: SettingsFeedbackDialogProps) => {
  const titleId = useId();
  const messageId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const returnFocus = document.activeElement;
    confirmRef.current?.focus();
    return () => {
      if (returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus();
    };
  }, []);

  return (
    <Modal
      onClose={onClose}
      overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4"
      className="w-full max-w-md rounded-2xl border border-border bg-background p-5 shadow-modal"
    >
      <div
        ref={dialogRef}
        role={isError ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        onKeyDown={event => {
          event.stopPropagation();
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          } else if (event.key === 'Tab') {
            const buttons = dialogRef.current?.querySelectorAll<HTMLButtonElement>('button');
            const first = buttons?.[0];
            const last = buttons?.[buttons.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h4
            id={titleId}
            className="flex items-center gap-2 text-sm font-semibold text-foreground"
          >
            {isError && (
              <ExclamationTriangleIcon
                className="h-5 w-5 shrink-0 text-red-500"
                aria-hidden="true"
              />
            )}
            {i18nService.t(isError ? 'settingsOperationFailed' : 'settingsNoticeTitle')}
          </h4>
          <button
            type="button"
            onClick={onClose}
            aria-label={i18nService.t('close')}
            className="rounded-md p-1 text-secondary hover:bg-surface-raised hover:text-foreground"
          >
            <XMarkIcon className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <div
          id={messageId}
          className="max-h-[50vh] select-text overflow-y-auto whitespace-pre-wrap break-words text-sm leading-6 text-foreground [overflow-wrap:anywhere]"
        >
          {message}
        </div>
        <div className="mt-5 flex justify-end">
          <button
            ref={confirmRef}
            type="button"
            onClick={onClose}
            className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
          >
            {i18nService.t('confirm')}
          </button>
        </div>
      </div>
    </Modal>
  );
};
