import type {
  StorageRelocationPlan,
  StorageRelocationStatus,
} from '@shared/storage/storageRelocation';
import { useEffect, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

export default function StorageRelocationControls() {
  const t = (key: string) => i18nService.t(key);
  const errorText = (code: string) => t(`storageRelocationError_${[
    'unavailable', 'busy', 'unsupported', 'target-not-empty', 'cancelled',
  ].includes(code) ? code : 'unavailable'}`);
  const [status, setStatus] = useState<StorageRelocationStatus>();
  const [plan, setPlan] = useState<StorageRelocationPlan>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const alive = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    let cancelled = false;
    alive.current = true;
    if (window.electron.storageRelocation)
      void window.electron.storageRelocation
        .status()
        .then(result => {
          if (!cancelled && result.success) setStatus(result.value);
        })
        .catch(() => {
          if (!cancelled) setError('unavailable');
        });
    return () => {
      cancelled = true;
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (plan) dialog.current?.showModal();
  }, [plan]);
  const prepare = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await window.electron.storageRelocation.prepare();
      if (!alive.current) return;
      if (result.success) setPlan(result.value);
      else if (result.code !== 'cancelled') setError(result.code);
    } catch {
      if (alive.current) setError('unavailable');
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const discard = async () => {
    if (!plan || busy) return;
    setBusy(true);
    try {
      const result = await window.electron.storageRelocation.discard(plan.planId);
      if (!alive.current) return;
      if (result.success) setPlan(undefined);
      else setError(result.code);
    } catch {
      if (alive.current) setError('unavailable');
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const commit = async () => {
    if (!plan || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await window.electron.storageRelocation.commit(plan.planId);
      if (!alive.current) return;
      if (!result.success) {
        setError(result.code);
        setBusy(false);
      } else setStatus(current => (current ? { ...current, pending: true } : current));
    } catch {
      if (alive.current) {
        setError('unavailable');
        setBusy(false);
      }
    }
  };
  if (!status?.available) return null;
  return (
    <>
      <button
        type="button"
        disabled={busy || status.pending}
        onClick={() => void prepare()}
        className="shrink-0 rounded-lg bg-primary px-3.5 py-2.5 text-xs font-medium text-white shadow-sm hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
      >
        {t('storageRelocationChange')}
      </button>
      {status.pending && (
        <p className="col-span-3 text-xs leading-6 text-secondary">{t('storageRelocationPending')}</p>
      )}
      {error && !plan && (
        <p role="alert" className="col-span-3 text-xs leading-6 text-secondary">
          {errorText(error)}
        </p>
      )}
      {plan && (
        <dialog
          ref={dialog}
          aria-labelledby="storage-relocation-title"
          className="w-[min(560px,calc(100vw-32px))] space-y-5 rounded-xl border border-border bg-surface p-6 text-foreground backdrop:bg-black/40"
          onCancel={event => {
            event.preventDefault();
            void discard();
          }}
        >
          <h3 id="storage-relocation-title" className="text-base font-semibold">
            {t('storageRelocationConfirm')}
          </h3>
          <p className="text-sm leading-6 text-secondary">{t('storageRelocationConfirmHelp')}</p>
          <dl className="space-y-3 rounded-lg bg-surface-raised p-4 text-xs">
            <div>
              <dt className="text-secondary">{t('storageRelocationSource')}</dt>
              <dd className="mt-1 break-all font-mono">{plan.sourcePath}</dd>
            </div>
            <div>
              <dt className="text-secondary">{t('storageRelocationTarget')}</dt>
              <dd className="mt-1 break-all font-mono">{plan.targetPath}</dd>
            </div>
          </dl>
          {error && (
            <p role="alert" className="text-sm text-secondary">
              {errorText(error)}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void discard()}
              className="rounded-lg border border-border px-4 py-2 text-sm disabled:opacity-50"
            >
              {t('cancel')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void commit()}
              className="rounded-lg bg-primary px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              {t(busy ? 'storageRelocationShuttingDown' : 'storageRelocationStart')}
            </button>
          </div>
        </dialog>
      )}
    </>
  );
}
