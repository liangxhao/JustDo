import { CheckCircleIcon, ExclamationTriangleIcon, XMarkIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/common/Modal';

export type OperationResult = {
  type: 'success' | 'error';
  title: string;
  message?: string;
  items?: Array<{ label: string; message: string; type?: 'success' | 'error' }>;
};

interface OperationResultModalProps {
  result: OperationResult | null;
  onClose: () => void;
}

const StructuredMessage: React.FC<{ message: string; type: OperationResult['type'] }> = ({
  message,
  type,
}) => {
  const blocks = message
    .split(/\n{2,}/)
    .map(block => block.trim())
    .filter(Boolean);

  return (
    <div className="space-y-3">
      {blocks.map((block, blockIndex) => {
        const lines = block
          .split('\n')
          .map(line => line.trim())
          .filter(Boolean);
        const listItems = lines.slice(1).filter(line => /^•\s*/.test(line));

        if (lines.length > 1 && listItems.length === lines.length - 1) {
          const processGroups = new Map<string, string[]>();
          for (const item of listItems) {
            const label = item.replace(/^•\s*/, '');
            const match = label.match(/^(.*?)\s+\(PID\s+(\d+)\)$/i);
            const name = match?.[1] || label;
            const pids = processGroups.get(name) ?? [];
            if (match?.[2]) pids.push(match[2]);
            processGroups.set(name, pids);
          }

          return (
            <div key={`${block}:${blockIndex}`}>
              <div className="mb-2 text-[11px] font-medium text-secondary">{lines[0]}</div>
              <div className="flex flex-wrap gap-1.5">
                {[...processGroups.entries()].map(([name, pids]) => (
                  <span
                    key={name}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-surface px-2.5 py-1 text-xs text-foreground shadow-sm"
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        type === 'error' ? 'bg-red-400' : 'bg-green-400'
                      }`}
                    />
                    <span className="font-medium">{name}</span>
                    {pids.length > 0 && (
                      <span className="text-[10px] text-secondary">PID {pids.join(' · ')}</span>
                    )}
                  </span>
                ))}
              </div>
            </div>
          );
        }

        if (lines.length > 1) {
          return (
            <div key={`${block}:${blockIndex}`}>
              <div className="mb-1.5 text-[11px] font-medium text-secondary">{lines[0]}</div>
              <div className="rounded-lg bg-surface-raised/70 px-3 py-2 font-mono text-[11px] leading-5 text-foreground/75 [overflow-wrap:anywhere]">
                {lines.slice(1).join('\n')}
              </div>
            </div>
          );
        }

        return (
          <div
            key={`${block}:${blockIndex}`}
            className={`rounded-lg px-3 py-2.5 text-xs leading-5 ${
              type === 'error'
                ? 'bg-red-500/[0.06] text-foreground/70'
                : 'bg-green-500/[0.06] text-foreground/70'
            }`}
          >
            {block}
          </div>
        );
      })}
    </div>
  );
};

const OperationResultModal: React.FC<OperationResultModalProps> = ({ result, onClose }) => {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const isOpen = result !== null;
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.querySelector<HTMLElement>('[data-primary-action]')?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = [
        ...dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ].filter(element => !element.hasAttribute('disabled'));
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
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
      previousFocus?.focus();
    };
  }, [isOpen]);

  if (!result) return null;

  return createPortal(
    <Modal
      onClose={onClose}
      closeOnBackdrop={false}
      overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-[2px]"
      className="mx-4 w-full max-w-lg overflow-hidden rounded-[20px] border border-border/80 bg-surface shadow-2xl"
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="flex items-center gap-3 px-6 pb-4 pt-5">
          <div
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
              result.type === 'success' ? 'bg-green-500/10' : 'bg-red-500/10'
            }`}
          >
            {result.type === 'success' ? (
              <CheckCircleIcon className="h-5 w-5 text-green-500" />
            ) : (
              <ExclamationTriangleIcon className="h-5 w-5 text-red-500" />
            )}
          </div>
          <div id={titleId} className="min-w-0 flex-1 text-lg font-semibold text-foreground">
            {result.title}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
            aria-label={i18nService.t('close')}
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[55vh] overflow-y-auto px-6 pb-5">
          <div className="space-y-3">
            {result.message && <StructuredMessage message={result.message} type={result.type} />}
            {result.items?.map((item, index) => (
              <div
                key={`${item.label}:${index}`}
                className="rounded-xl border border-border/60 bg-surface-raised/30 p-4"
              >
                <div className="mb-3 flex items-center gap-2">
                  <span
                    className={`h-2 w-2 rounded-full ${
                      (item.type ?? result.type) === 'success' ? 'bg-green-500' : 'bg-red-500'
                    }`}
                  />
                  <div
                    className="truncate text-sm font-semibold text-foreground"
                    title={item.label}
                  >
                    {item.label}
                  </div>
                </div>
                <StructuredMessage message={item.message} type={item.type ?? result.type} />
              </div>
            ))}
          </div>
        </div>

        <div className="flex justify-end border-t border-border/60 bg-surface-raised/20 px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            autoFocus
            data-primary-action
            className="min-w-20 rounded-xl bg-primary px-5 py-2 text-sm font-medium text-white shadow-sm transition-all hover:brightness-105 active:scale-[0.98]"
          >
            {i18nService.t('confirm')}
          </button>
        </div>
      </div>
    </Modal>,
    document.body,
  );
};

export default OperationResultModal;
