import { KeyIcon, XMarkIcon } from '@heroicons/react/24/outline';
import type { BrowserPanelHttpAuthRequest, BrowserPanelHttpAuthResponse } from '@shared/browser/browser';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/ui/Modal';
import { isDomHTMLElement, useOwnerDocument } from '@/shared/dom/ownerDocument';

interface BrowserHttpAuthModalProps {
  request: BrowserPanelHttpAuthRequest;
  onRespond: (response: BrowserPanelHttpAuthResponse) => void;
}

const BrowserHttpAuthModal: React.FC<BrowserHttpAuthModalProps> = ({ request, onRespond }) => {
  const ownerDocument = useOwnerDocument();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const dialogRef = useRef<HTMLFormElement>(null);
  const usernameRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const site = request.port > 0 ? `${request.host}:${request.port}` : request.host;
  const cancel = useCallback(
    () => onRespond({ id: request.id, guestId: request.guestId }),
    [onRespond, request.guestId, request.id],
  );

  useEffect(() => {
    const previousFocus =
      isDomHTMLElement(ownerDocument.activeElement) ? ownerDocument.activeElement : null;
    usernameRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cancel();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = [
        ...(dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled)',
        ) ?? []),
      ];
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && ownerDocument.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && ownerDocument.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    ownerDocument.addEventListener('keydown', handleKeyDown);
    return () => {
      ownerDocument.removeEventListener('keydown', handleKeyDown);
      previousFocus?.focus();
    };
  }, [cancel, request.id, ownerDocument]);

  return createPortal(
    <Modal
      onClose={cancel}
      overlayClassName="fixed inset-0 z-[130] flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px]"
      className="w-full max-w-[420px] overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
    >
      <form
        ref={dialogRef}
        role="dialog"
        data-browser-http-auth-dialog
        aria-modal="true"
        aria-labelledby={titleId}
        className="outline-none"
        onSubmit={event => {
          event.preventDefault();
          onRespond({ id: request.id, guestId: request.guestId, username, password });
        }}
      >
        <div className="flex items-start gap-3 px-5 pb-3 pt-5">
          <div className="mt-0.5 rounded-xl bg-primary-muted p-2 text-primary">
            <KeyIcon className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-lg font-semibold tracking-tight">
              {i18nService.t('browserHttpAuthTitle')}
            </h2>
            <p className="mt-1 break-all text-sm text-secondary">{site}</p>
          </div>
          <button
            type="button"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-secondary hover:bg-surface-raised hover:text-foreground"
            aria-label={i18nService.t('close')}
            onClick={cancel}
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 px-5 pb-5">
          <p className="text-sm leading-5 text-secondary">
            {request.realm
              ? i18nService.t('browserHttpAuthRealm').replace('{realm}', request.realm)
              : i18nService.t('browserHttpAuthDescription')}
          </p>
          <label className="block text-sm font-medium">
            {i18nService.t('browserHttpAuthUsername')}
            <input
              ref={usernameRef}
              value={username}
              autoComplete="username"
              maxLength={4096}
              className="mt-1.5 w-full rounded-lg border border-border bg-surface px-3 py-2 text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              onChange={event => setUsername(event.target.value)}
            />
          </label>
          <label className="block text-sm font-medium">
            {i18nService.t('browserHttpAuthPassword')}
            <input
              type="password"
              value={password}
              autoComplete="current-password"
              maxLength={4096}
              className="mt-1.5 w-full rounded-lg border border-border bg-surface px-3 py-2 text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              onChange={event => setPassword(event.target.value)}
            />
          </label>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-surface-raised"
              onClick={cancel}
            >
              {i18nService.t('cancel')}
            </button>
            <button
              type="submit"
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              {i18nService.t('browserHttpAuthSignIn')}
            </button>
          </div>
        </div>
      </form>
    </Modal>,
    ownerDocument.body,
  );
};

export default BrowserHttpAuthModal;
