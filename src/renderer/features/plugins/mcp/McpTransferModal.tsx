import {
  ArrowDownTrayIcon,
  ArrowsRightLeftIcon,
  ArrowUpTrayIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import type {
  McpImportCommitInput,
  McpImportCommitReceipt,
  McpTransferResult,
} from '@shared/plugins/mcpTransfer';
import { useId, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/ui/Modal';
import { useDialogFocusTrap } from '@/shared/hooks/useDialogFocusTrap';

import { McpTransferExport } from './McpTransferExport';
import { McpTransferImport } from './McpTransferImport';

interface McpTransferModalProps {
  knownNames: ReadonlySet<string>;
  onClose: () => void;
  onImport: (input: McpImportCommitInput) => Promise<McpTransferResult<McpImportCommitReceipt>>;
  onEditImported?: (id: string) => void;
}

export function McpTransferModal({
  knownNames,
  onClose,
  onImport,
  onEditImported,
}: McpTransferModalProps) {
  const headingId = useId();
  const importTabId = useId();
  const exportTabId = useId();
  const importPanelId = useId();
  const exportPanelId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const importTabRef = useRef<HTMLButtonElement>(null);
  const exportTabRef = useRef<HTMLButtonElement>(null);
  const [tab, setTab] = useState<'import' | 'export'>('import');
  const [busy, setBusy] = useState(false);
  const [importRevision, setImportRevision] = useState(0);

  useDialogFocusTrap(dialogRef, importTabRef, headingId);

  const close = () => {
    if (!busy) onClose();
  };

  const commit = async (input: McpImportCommitInput) => {
    const result = await onImport(input);
    if (result.success || result.operationUnconfirmed) setImportRevision(revision => revision + 1);
    return result;
  };

  const tabs = [
    {
      name: 'import',
      id: importTabId,
      panelId: importPanelId,
      ref: importTabRef,
      icon: ArrowUpTrayIcon,
      label: 'mcpTransferImport',
    },
    {
      name: 'export',
      id: exportTabId,
      panelId: exportPanelId,
      ref: exportTabRef,
      icon: ArrowDownTrayIcon,
      label: 'mcpTransferExport',
    },
  ] as const;

  return (
    <Modal
      onClose={close}
      overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-3 py-4 backdrop-blur-sm"
      className="w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-surface shadow-xl"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        className="flex max-h-[min(90dvh,48rem)] min-h-0 flex-col focus:outline-none"
        onKeyDown={event => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          close();
        }}
      >
        <header className="shrink-0 border-b border-border bg-gradient-to-r from-primary/10 to-surface px-4 pt-5 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
              <ArrowsRightLeftIcon className="size-5" aria-hidden="true" />
            </span>
            <h2
              id={headingId}
              className="min-w-0 flex-1 text-lg font-semibold text-foreground sm:text-xl"
            >
              {i18nService.t('mcpTransferTitle')}
            </h2>
            <button
              type="button"
              className="shrink-0 rounded-lg p-2 text-secondary hover:bg-surface-raised hover:text-foreground disabled:opacity-50"
              aria-label={i18nService.t('close')}
              disabled={busy}
              onClick={close}
            >
              <XMarkIcon className="size-5" aria-hidden="true" />
            </button>
          </div>
          <div
            role="tablist"
            aria-labelledby={headingId}
            className="mt-3 flex gap-2"
            onKeyDown={event => {
              if (busy || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const next =
                event.key === 'Home' || (event.key !== 'End' && tab === 'export')
                  ? 'import'
                  : 'export';
              setTab(next);
              (next === 'import' ? importTabRef : exportTabRef).current?.focus();
            }}
          >
            {tabs.map(({ name, id, panelId, ref, icon: Icon, label }) => (
              <button
                key={name}
                type="button"
                ref={ref}
                role="tab"
                id={id}
                aria-controls={panelId}
                aria-selected={name === tab}
                tabIndex={name === tab ? 0 : -1}
                disabled={busy}
                className="inline-flex items-center gap-2 rounded-t-lg border-b-2 border-transparent px-3 py-2.5 text-sm font-medium text-secondary hover:text-foreground aria-selected:border-primary aria-selected:bg-primary/5 aria-selected:text-primary"
                onClick={() => setTab(name)}
              >
                <Icon className="size-4" aria-hidden="true" />
                {i18nService.t(label)}
              </button>
            ))}
          </div>
        </header>
        <McpTransferImport
          active={tab === 'import'}
          id={importPanelId}
          tabId={importTabId}
          knownNames={knownNames}
          busy={busy}
          setBusy={setBusy}
          onClose={close}
          onImport={commit}
          onEditImported={onEditImported}
        />
        <McpTransferExport
          active={tab === 'export'}
          id={exportPanelId}
          tabId={exportTabId}
          importRevision={importRevision}
          busy={busy}
          setBusy={setBusy}
          onClose={close}
        />
      </div>
    </Modal>
  );
}
