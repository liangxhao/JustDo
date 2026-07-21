import {
  ArrowDownTrayIcon,
  CheckIcon,
  DocumentTextIcon,
  ShieldCheckIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import React, { useEffect, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/common/Modal';

interface ExportSessionModalProps {
  isOpen: boolean;
  sessionTitle: string;
  messageCount: number;
  onClose: () => void;
  onExport: (includeRawData: boolean) => Promise<boolean>;
}

const ExportSessionModal: React.FC<ExportSessionModalProps> = ({
  isOpen,
  sessionTitle,
  messageCount,
  onClose,
  onExport,
}) => {
  const [includeRawData, setIncludeRawData] = useState(true);
  const [isExporting, setIsExporting] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const previouslyFocused = document.activeElement;
    const focusFrame = requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => {
      cancelAnimationFrame(focusFrame);
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      setIncludeRawData(true);
      setIsExporting(false);
      return;
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isExporting) onClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isExporting, isOpen, onClose]);

  if (!isOpen) return null;

  const handleExport = async () => {
    setIsExporting(true);
    try {
      if (await onExport(includeRawData)) onClose();
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <Modal
      onClose={onClose}
      closeOnBackdrop={!isExporting}
      overlayClassName="fixed inset-0 z-[100] flex items-center justify-center modal-backdrop p-5 backdrop-blur-[2px]"
      className="modal-content w-full max-w-[560px] overflow-hidden rounded-[20px] border border-border/80 bg-surface shadow-modal"
    >
      <div
        className="relative"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-session-title"
      >
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/70 to-transparent" />
        <div className="flex items-center justify-between border-b border-border/70 px-6 py-5">
          <div className="flex min-w-0 items-center gap-3.5">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-primary/20 to-primary/5 text-primary ring-1 ring-inset ring-primary/20">
              <ArrowDownTrayIcon className="h-[22px] w-[22px]" />
            </div>
            <div className="min-w-0">
              <h2
                id="export-session-title"
                className="text-lg font-semibold tracking-tight text-foreground"
              >
                {i18nService.t('coworkExportSession')}
              </h2>
              <p className="mt-0.5 truncate text-xs text-muted">{sessionTitle}</p>
            </div>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            disabled={isExporting}
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl text-muted transition-colors hover:bg-surface-raised hover:text-foreground disabled:opacity-50"
            aria-label={i18nService.t('close')}
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-3.5 px-6 py-5">
          <div className="overflow-hidden rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/[0.08] via-primary/[0.035] to-transparent">
            <div className="flex items-start gap-3.5 p-4">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface text-primary shadow-sm ring-1 ring-inset ring-border/70">
                <DocumentTextIcon className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-foreground">
                    {i18nService.t('coworkExportOpenAiFormat')}
                  </p>
                  <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-[10px] font-semibold tracking-wide text-primary ring-1 ring-inset ring-primary/15">
                    <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                    JSON
                  </span>
                </div>
                <p className="mt-1.5 text-xs leading-5 text-secondary">
                  {i18nService.t('coworkExportOpenAiFormatDescription')}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 border-t border-primary/10 bg-surface/35 px-4 py-2.5">
              <span className="rounded-md bg-surface-raised/80 px-2 py-1 text-[11px] font-medium text-secondary">
                {i18nService
                  .t('coworkExportMessageCountValue')
                  .replace('{count}', String(messageCount))}
              </span>
              <span className="rounded-md bg-surface-raised/80 px-2 py-1 text-[11px] font-medium text-secondary">
                UTF-8
              </span>
            </div>
          </div>

          <label
            className={`group flex cursor-pointer items-center gap-3 rounded-2xl border px-4 py-3.5 transition-all focus-within:ring-2 focus-within:ring-primary/30 focus-within:ring-offset-2 focus-within:ring-offset-surface ${
              includeRawData
                ? 'border-primary/30 bg-primary/[0.055] shadow-sm'
                : 'border-border bg-transparent hover:border-primary/20 hover:bg-surface-raised/40'
            }`}
          >
            <input
              type="checkbox"
              checked={includeRawData}
              onChange={event => setIncludeRawData(event.target.checked)}
              className="sr-only"
            />
            <span
              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-colors ${
                includeRawData
                  ? 'border-primary bg-primary text-white'
                  : 'border-border bg-surface text-transparent group-hover:border-primary/40'
              }`}
              aria-hidden="true"
            >
              <CheckIcon className="h-3.5 w-3.5 stroke-[2.5]" />
            </span>
            <span className="text-sm leading-5 text-foreground">
              {i18nService.t('coworkExportIncludeRaw')}
            </span>
          </label>

          <div className="flex items-start gap-2.5 rounded-xl bg-surface-raised/55 px-3.5 py-3 text-muted ring-1 ring-inset ring-border/50">
            <ShieldCheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-secondary" />
            <p className="text-xs leading-5">{i18nService.t('coworkExportPrivacyNotice')}</p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2.5 border-t border-border/70 bg-background/35 px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={isExporting}
            className="rounded-xl px-4 py-2.5 text-sm font-medium text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:opacity-50"
          >
            {i18nService.t('cancel')}
          </button>
          <button
            type="button"
            onClick={handleExport}
            disabled={isExporting}
            className="inline-flex min-w-[138px] items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-white shadow-sm shadow-primary/20 transition-all hover:-translate-y-px hover:shadow-md hover:shadow-primary/20 disabled:translate-y-0 disabled:opacity-50"
          >
            <ArrowDownTrayIcon className="h-4 w-4 stroke-2" />
            {isExporting ? i18nService.t('coworkExportSaving') : i18nService.t('coworkExportSave')}
          </button>
        </div>
      </div>
    </Modal>
  );
};

export default ExportSessionModal;
