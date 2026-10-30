import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/ui/Modal';
import { useOwnerDocument } from '@/shared/dom/ownerDocument';

import type { AppPluginReview } from '../../../../../plugins/sdk/app-plugin-sdk/contracts';

/** Native installation permission never silently approves privileged app code. */
export default function AppCodeReviewAction({ extensionId }: { extensionId: string }) {
  const document = useOwnerDocument();
  const [review, setReview] = useState<AppPluginReview | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState('');
  const generation = useRef(0);
  useEffect(() => {
    if (!window.electron?.appPlugins?.review) return;
    let live = true;
    const invalidate = () => ++generation.current;
    const refresh = () => {
      const request = invalidate();
      setReview(null);
      setOpen(false);
      setOutcome('');
      setBusy(false);
      void window.electron.appPlugins
        .review?.(extensionId)
        .then(value => {
          if (live && request === generation.current) setReview(value);
        })
        .catch(() => undefined);
    };
    const release = window.electron.extensions?.onChanged?.(event => {
      if (event.extensionId === extensionId) refresh();
    });
    refresh();
    return () => {
      live = false;
      invalidate();
      release?.();
    };
  }, [extensionId]);
  if (!review || review.approved) return null;
  const approve = async () => {
    if (busy) return;
    const request = generation.current;
    setBusy(true);
    try {
      const result = await window.electron.appPlugins.approve?.({
        id: review.id,
        hash: review.hash,
        token: review.token,
      });
      if (request === generation.current)
        setOutcome(
          result?.success
            ? result.restartRequired
              ? 'appPluginRestartRequired'
              : 'appPluginApproved'
            : 'appPluginReviewChanged',
        );
    } catch {
      if (request === generation.current) setOutcome('appPluginUnavailable');
    } finally {
      if (request === generation.current) setBusy(false);
    }
  };
  return (
    <>
      <button
        type="button"
        className="rounded-lg px-2 py-1 text-xs text-primary hover:bg-surface-raised"
        onClick={async event => {
          event.stopPropagation();
          const request = ++generation.current;
          const current = await window.electron.appPlugins.review?.(extensionId).catch(() => null);
          if (current && request === generation.current) {
            setReview(current);
            setOutcome('');
            setOpen(true);
          }
        }}
      >
        {i18nService.t('appPluginReview')}
      </button>
      {open &&
        createPortal(
          <Modal
            onClose={() => setOpen(false)}
            overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
            className="mx-4 w-full max-w-md rounded-xl border border-border bg-surface p-5 shadow-elevated"
          >
            <h2 className="text-base font-semibold">{i18nService.t('appPluginReview')}</h2>
            <p className="mt-3 text-sm text-secondary">
              {i18nService.t('appPluginTrustDescription')}
            </p>
            <p className="mt-3 text-sm">
              {review.id} · {review.version}
            </p>
            <p className="mt-1 break-all text-xs text-muted">{review.hash}</p>
            {outcome && (
              <p role="status" className="mt-3 text-sm text-secondary">
                {i18nService.t(outcome)}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-lg px-3 py-2 text-sm hover:bg-surface-raised"
                onClick={() => setOpen(false)}
              >
                {i18nService.t('cancel')}
              </button>
              <button
                type="button"
                disabled={busy || !!outcome}
                className="rounded-lg bg-primary px-3 py-2 text-sm text-white disabled:opacity-50"
                onClick={() => {
                  void approve();
                }}
              >
                {i18nService.t('appPluginApprove')}
              </button>
            </div>
          </Modal>,
          document.body,
        )}
    </>
  );
}
