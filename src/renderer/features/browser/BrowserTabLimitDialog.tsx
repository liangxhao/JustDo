import { XMarkIcon } from '@heroicons/react/24/outline';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/ui/Modal';
import { isDomElement, isDomHTMLElement, useOwnerDocument } from '@/shared/dom/ownerDocument';

import { BROWSER_TAB_CAPACITY_EVENT } from './browserTabCapacity';
import { useBrowserTabLimit } from './useBrowserTabLimit';

const MODAL_DIALOG_SELECTOR = '[role="dialog"][aria-modal="true"], dialog[open]';

const findOtherDialog = (ownerDocument: Document, current: Element | null) =>
  [...ownerDocument.querySelectorAll(MODAL_DIALOG_SELECTOR)].find(
    element => element !== current && !element.closest('[hidden], [aria-hidden="true"]'),
  );

interface BrowserTabLimitItem {
  id: string;
  label: string;
  onSelect: () => void;
  onClose?: () => void | boolean | Promise<void | boolean>;
}

interface BrowserTabLimitDialogProps {
  sessionKey?: string;
  tabs: BrowserTabLimitItem[];
}

export default function BrowserTabLimitDialog({ sessionKey, tabs }: BrowserTabLimitDialogProps) {
  const ownerDocument = useOwnerDocument();
  const maximumTabs = useBrowserTabLimit();
  const [requestedSessionKey, setRequestedSessionKey] = useState<string | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [closeFailed, setCloseFailed] = useState(false);
  const scopeRef = useRef({ sessionKey });
  if (scopeRef.current.sessionKey !== sessionKey) scopeRef.current = { sessionKey };
  const dialogRef = useRef<HTMLDivElement>(null);
  const dismissRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const open = Boolean(sessionKey && requestedSessionKey === sessionKey);

  useEffect(() => {
    setRequestedSessionKey(null);
    setCloseFailed(false);
    setClosingId(null);
    const handleCapacity = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionKey?: unknown }>).detail;
      if (!sessionKey) return;
      // A mounted workspace also consumes stale requests from another session;
      // only an unmounted workspace needs the global notification fallback.
      if (detail?.sessionKey !== sessionKey) {
        event.preventDefault();
        return;
      }
      // Existing dialogs such as website authentication keep their input focus.
      if (findOtherDialog(ownerDocument, dialogRef.current)) return;
      event.preventDefault();
      setRequestedSessionKey(sessionKey);
    };
    window.addEventListener(BROWSER_TAB_CAPACITY_EVENT, handleCapacity);
    return () => window.removeEventListener(BROWSER_TAB_CAPACITY_EVENT, handleCapacity);
  }, [ownerDocument, sessionKey]);

  useEffect(() => {
    const currentDialog = dialogRef.current;
    if (!open || !currentDialog) return;
    if (findOtherDialog(ownerDocument, currentDialog)) {
      setRequestedSessionKey(null);
      return;
    }
    const previousFocus = isDomHTMLElement(ownerDocument.activeElement)
      ? ownerDocument.activeElement
      : null;
    dismissRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      const targetDialog = isDomElement(event.target)
        ? event.target.closest(MODAL_DIALOG_SELECTOR)
        : null;
      if (targetDialog && targetDialog !== currentDialog) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setRequestedSessionKey(null);
      }
      if (event.key !== 'Tab') return;
      const controls = [
        ...currentDialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
      ];
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!first || !last) return;
      if (!currentDialog.contains(ownerDocument.activeElement)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && ownerDocument.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && ownerDocument.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const keepFocus = (event: FocusEvent) => {
      if (event.composedPath().includes(currentDialog)) return;
      const targetDialog = isDomElement(event.target)
        ? event.target.closest(MODAL_DIALOG_SELECTOR)
        : null;
      if (targetDialog) setRequestedSessionKey(null);
      else dismissRef.current?.focus();
    };
    ownerDocument.addEventListener('keydown', handleKeyDown, true);
    ownerDocument.addEventListener('focusin', keepFocus);
    return () => {
      ownerDocument.removeEventListener('keydown', handleKeyDown, true);
      ownerDocument.removeEventListener('focusin', keepFocus);
      if (previousFocus?.isConnected && !findOtherDialog(ownerDocument, currentDialog))
        previousFocus.focus();
    };
  }, [open, ownerDocument]);

  useEffect(() => {
    if (!open) return;
    if (findOtherDialog(ownerDocument, dialogRef.current)) setRequestedSessionKey(null);
    else if (!dialogRef.current?.contains(ownerDocument.activeElement)) dismissRef.current?.focus();
  }, [open, ownerDocument, tabs]);

  if (!open) return null;
  return createPortal(
    <Modal
      onClose={() => setRequestedSessionKey(null)}
      overlayClassName="fixed inset-0 z-[130] flex items-center justify-center bg-black/55 p-4"
      className="w-full max-w-lg overflow-hidden rounded-2xl border border-border bg-background text-foreground shadow-2xl"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={event => event.stopPropagation()}
      >
        <div className="flex items-start gap-3 p-5 pb-3">
          <h2 id={titleId} className="min-w-0 flex-1 text-lg font-semibold">
            {i18nService.t('browserTabCapacityTitle')}
          </h2>
          <button
            ref={dismissRef}
            type="button"
            onClick={() => setRequestedSessionKey(null)}
            aria-label={i18nService.t('close')}
            className="rounded-lg p-1 text-secondary hover:bg-surface-raised"
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>
        <p id={descriptionId} className="px-5 text-sm text-secondary">
          {i18nService.t('browserTabCapacityDescription').replace('{limit}', String(maximumTabs))}
        </p>
        <p className="px-5 pt-3 text-xs text-secondary">
          {i18nService.t('browserTabCapacitySidebarPages')}
        </p>
        <ul className="m-3 max-h-[45vh] overflow-y-auto rounded-lg border border-border">
          {tabs.map(tab => (
            <li
              key={tab.id}
              className="flex items-center gap-2 border-b border-border p-2 last:border-b-0"
            >
              <button
                type="button"
                title={tab.label}
                className="min-w-0 flex-1 truncate rounded px-2 py-1 text-left text-sm hover:bg-surface-raised"
                onClick={() => {
                  setRequestedSessionKey(null);
                  tab.onSelect();
                }}
              >
                {tab.label}
              </button>
              {tab.onClose && (
                <button
                  type="button"
                  disabled={closingId !== null}
                  aria-label={i18nService
                    .t('browserTabCapacityClosePage')
                    .replace('{title}', tab.label)}
                  className="shrink-0 rounded p-1 text-secondary hover:bg-surface-raised disabled:opacity-40"
                  onClick={async () => {
                    const scope = scopeRef.current;
                    setClosingId(tab.id);
                    setCloseFailed(false);
                    try {
                      await tab.onClose?.();
                    } catch {
                      if (scopeRef.current === scope) setCloseFailed(true);
                    } finally {
                      if (scopeRef.current === scope) setClosingId(null);
                    }
                  }}
                >
                  <XMarkIcon className="h-4 w-4" />
                </button>
              )}
            </li>
          ))}
          {tabs.length === 0 && (
            <li className="p-3 text-sm text-secondary">
              {i18nService.t('browserTabCapacityNoSidebarPages')}
            </li>
          )}
        </ul>
        {closeFailed && (
          <p role="alert" className="px-5 text-sm text-error">
            {i18nService.t('browserTabCapacityCloseFailed')}
          </p>
        )}
        <div className="flex justify-end p-4 pt-1">
          <button
            type="button"
            className="rounded-lg bg-primary px-4 py-2 text-sm text-white"
            onClick={() => setRequestedSessionKey(null)}
          >
            {i18nService.t('browserTabCapacityDone')}
          </button>
        </div>
      </div>
    </Modal>,
    ownerDocument.body,
  );
}
