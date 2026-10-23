import { isWorkspaceFileName } from '@shared/preview/workspaceFiles';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/ui/Modal';
import { isDomHTMLElement, useOwnerDocument } from '@/shared/dom/ownerDocument';

interface WorkspaceFileNameDialogProps {
  initialName: string;
  isRenaming: boolean;
  selectBasename?: boolean;
  error: string;
  onChange: () => void;
  onCancel: () => void;
  onSubmit: (name: string) => void;
}

export default function WorkspaceFileNameDialog({
  initialName,
  isRenaming,
  selectBasename = false,
  error,
  onChange,
  onCancel,
  onSubmit,
}: WorkspaceFileNameDialogProps) {
  const ownerDocument = useOwnerDocument();
  const titleId = useId();
  const errorId = useId();
  const input = useRef<HTMLInputElement>(null);
  const content = useRef<HTMLFormElement>(null);
  const composing = useRef(false);
  const [name, setName] = useState(initialName);
  const [validationError, setValidationError] = useState('');
  const displayedError = validationError || error;

  useEffect(() => {
    const previous = ownerDocument.activeElement;
    input.current?.focus();
    const extensionIndex = selectBasename ? initialName.lastIndexOf('.') : -1;
    input.current?.setSelectionRange(0, extensionIndex > 0 ? extensionIndex : initialName.length);
    return () => {
      if (
        isDomHTMLElement(previous) &&
        previous.isConnected &&
        previous.ownerDocument === ownerDocument
      )
        previous.focus();
    };
  }, [initialName, ownerDocument, selectBasename]);

  return createPortal(
    <Modal
      onClose={onCancel}
      overlayClassName="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-5"
      className="w-full max-w-sm rounded-xl border border-border bg-surface p-5 text-foreground shadow-2xl"
    >
      <form
        ref={content}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={event => {
          event.preventDefault();
          if (composing.current) return;
          if (!isWorkspaceFileName(name)) {
            setValidationError(i18nService.t('coworkWorkspaceFilesInvalidName'));
            input.current?.focus();
            return;
          }
          onSubmit(name);
        }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
            if (event.key === 'Enter') event.preventDefault();
            event.stopPropagation();
            return;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
            return;
          }
          if (event.key !== 'Tab') return;
          const controls = Array.from(
            content.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled)',
            ) ?? [],
          );
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (
            event.shiftKey
              ? ownerDocument.activeElement === first
              : ownerDocument.activeElement === last
          ) {
            event.preventDefault();
            (event.shiftKey ? last : first)?.focus();
          }
        }}
      >
        <h2 id={titleId} className="mb-4 text-base font-semibold">
          {i18nService.t(
            isRenaming ? 'coworkWorkspaceFilesRename' : 'coworkWorkspaceFilesNewFolder',
          )}
        </h2>
        <label className="block text-sm text-secondary">
          {i18nService.t('coworkWorkspaceFilesName')}
          <input
            ref={input}
            value={name}
            maxLength={255}
            aria-invalid={Boolean(displayedError)}
            aria-describedby={displayedError ? errorId : undefined}
            onChange={event => {
              setName(event.target.value);
              setValidationError('');
              onChange();
            }}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            className="mt-2 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/60"
          />
        </label>
        {displayedError && (
          <p id={errorId} className="mt-2 text-xs text-destructive" role="alert">
            {displayedError}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-3 py-2 text-sm text-secondary hover:bg-surface-raised"
          >
            {i18nService.t('cancel')}
          </button>
          <button
            type="submit"
            className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            {i18nService.t(
              isRenaming ? 'coworkWorkspaceFilesRename' : 'coworkWorkspaceFilesCreate',
            )}
          </button>
        </div>
      </form>
    </Modal>,
    ownerDocument.body,
  );
}
