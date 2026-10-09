import {
  ClockIcon,
  GlobeAltIcon,
  KeyIcon,
  ShieldCheckIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import type { BrowserImportResult } from '@shared/browser/browser';
import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/ui/Modal';

export type BrowserImportSelection = {
  sourceId: string;
  passwords: boolean;
  cookies: boolean;
  history: boolean;
};

const ImportSwitch = ({
  checked,
  label,
  description,
  icon,
  onChange,
}: {
  checked: boolean;
  label: string;
  description?: string;
  icon: React.ReactNode;
  onChange: (checked: boolean) => void;
}) => (
  <div className="flex items-center gap-3 px-4 py-3">
    <span className="text-secondary">{icon}</span>
    <span className="min-w-0 flex-1">
      <span className="block text-sm font-medium text-foreground">{label}</span>
      {description && (
        <span className="mt-0.5 block text-xs leading-4 text-secondary">{description}</span>
      )}
    </span>
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`flex h-6 w-11 items-center rounded-full p-0.5 shadow-inner transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
        checked ? 'bg-primary' : 'bg-border'
      }`}
      onClick={() => onChange(!checked)}
    >
      <span
        className={`h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
          checked ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  </div>
);

const ChromeMark = () => (
  <span
    className="relative h-4 w-4 shrink-0 overflow-hidden rounded-full bg-[conic-gradient(#ea4335_0_33%,#fbbc05_0_66%,#34a853_0)]"
    aria-hidden="true"
  >
    <span className="absolute inset-[4px] rounded-full border border-white/80 bg-[#4285f4]" />
  </span>
);

export default function BrowserDataImportModal({
  onClose,
  onImport,
}: {
  onClose: () => void;
  onImport: (selection: BrowserImportSelection) => Promise<BrowserImportResult>;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [passwords, setPasswords] = useState(true);
  const [cookies, setCookies] = useState(false);
  const [history, setHistory] = useState(true);
  const [approved, setApproved] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sources, setSources] = useState<Array<{ id: string; name: string }>>([]);
  const [sourceId, setSourceId] = useState('');
  const [loadingSources, setLoadingSources] = useState(true);
  const hasSelection = passwords || cookies || history;

  useEffect(() => {
    let cancelled = false;
    void window.electron.browser
      .listImportSources()
      .then(result => {
        if (cancelled) return;
        const next = result.success ? (result.sources ?? []) : [];
        setSources(next);
        setSourceId(next[0]?.id ?? '');
        if (!result.success) setError(i18nService.t('browserImportSourceFailed'));
      })
      .catch(() => {
        if (!cancelled) setError(i18nService.t('browserImportSourceFailed'));
      })
      .finally(() => {
        if (!cancelled) setLoadingSources(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) {
        event.preventDefault();
        onClose();
      }
      if (event.key !== 'Tab') return;
      const controls = [
        ...(dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), select:not(:disabled), input:not(:disabled)',
        ) ?? []),
      ];
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!first || !last) return;
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
  }, [onClose, submitting]);

  const submit = async () => {
    if (!approved || !hasSelection || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await onImport({
        sourceId,
        passwords,
        cookies,
        history,
      });
      if (result.success) onClose();
      else {
        const errorKey =
          result.errorCode === 'chrome-running'
            ? 'browserImportChromeRunning'
            : result.errorCode === 'decrypt-failed'
              ? 'browserImportDecryptFailed'
              : result.errorCode === 'source-unavailable'
                ? 'browserImportSourceFailed'
                : 'browserImportFailed';
        const imported = result.imported;
        const importedCount = imported
          ? imported.passwords + imported.cookies + imported.history
          : 0;
        setError(
          `${importedCount > 0 ? `${i18nService.t('browserImportPartial')} ` : ''}${i18nService.t(errorKey)}`,
        );
      }
    } catch {
      setError(i18nService.t('browserImportFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <Modal
      onClose={onClose}
      closeOnBackdrop={!submitting}
      overlayClassName="fixed inset-0 z-[120] flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px]"
      className="max-h-[calc(100vh-2rem)] w-full max-w-[520px] overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="flex max-h-[calc(100vh-2rem)] flex-col outline-none"
      >
        <div className="flex items-start gap-4 px-5 pb-3 pt-5">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-xl font-semibold tracking-tight text-foreground">
              {i18nService.t('browserImportTitle')}
            </h2>
            <p className="mt-1 text-sm text-secondary">{i18nService.t('browserImportSubtitle')}</p>
          </div>
          <button
            type="button"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-secondary hover:bg-surface-raised hover:text-foreground"
            aria-label={i18nService.t('close')}
            disabled={submitting}
            onClick={onClose}
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 pb-5">
          <label className="flex items-center gap-3 text-sm text-secondary">
            <span className="shrink-0">{i18nService.t('browserImportFrom')}</span>
            <span className="relative min-w-0 flex-1">
              <select
                className="h-9 w-full appearance-none rounded-lg border border-border bg-surface-raised pl-8 pr-9 text-sm text-foreground outline-none focus:border-primary"
                aria-label={i18nService.t('browserImportSource')}
                value={sourceId}
                disabled={loadingSources || !sources.length}
                onChange={event => setSourceId(event.target.value)}
              >
                {loadingSources && (
                  <option value="">{i18nService.t('browserImportLoading')}</option>
                )}
                {!loadingSources && !sources.length && (
                  <option value="">{i18nService.t('browserImportNoSources')}</option>
                )}
                {sources.map(source => (
                  <option key={source.id} value={source.id}>
                    {source.name}
                  </option>
                ))}
              </select>
              <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2">
                <ChromeMark />
              </span>
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-secondary">
                ⌄
              </span>
            </span>
          </label>

          <p className="text-sm text-secondary">{i18nService.t('browserImportCloseChrome')}</p>

          <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface-raised/35">
            <ImportSwitch
              checked={passwords}
              label={i18nService.t('browserImportPasswords')}
              description={i18nService.t('browserImportPasswordsDescription')}
              icon={<KeyIcon className="h-5 w-5" />}
              onChange={setPasswords}
            />
            <ImportSwitch
              checked={cookies}
              label={i18nService.t('browserImportCookies')}
              description={i18nService.t('browserImportCookiesDescription')}
              icon={<GlobeAltIcon className="h-5 w-5" />}
              onChange={setCookies}
            />
            <ImportSwitch
              checked={history}
              label={i18nService.t('browserImportHistory')}
              icon={<ClockIcon className="h-5 w-5" />}
              onChange={setHistory}
            />
          </div>

          <div className="rounded-xl border border-border bg-surface-raised/25 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <ShieldCheckIcon className="h-5 w-5 text-secondary" />
              {i18nService.t('browserImportAdminTitle')}
            </div>
            <p className="mt-1.5 text-xs leading-5 text-secondary">
              {i18nService.t('browserImportAdminDescription')}
            </p>
            <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-sm leading-5 text-foreground">
              <input
                type="checkbox"
                checked={approved}
                className="mt-0.5 h-4 w-4 rounded border-border accent-primary"
                onChange={event => setApproved(event.target.checked)}
              />
              <span>{i18nService.t('browserImportAdminConsent')}</span>
            </label>
          </div>

          {error && (
            <p
              role="alert"
              className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400"
            >
              {error}
            </p>
          )}
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-border bg-surface-raised/20 px-5 py-4">
          <button
            type="button"
            className="rounded-lg px-4 py-2 text-sm text-foreground hover:bg-surface-raised"
            disabled={submitting}
            onClick={onClose}
          >
            {i18nService.t('cancel')}
          </button>
          <button
            type="button"
            className="min-w-16 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:brightness-105 disabled:cursor-not-allowed disabled:bg-border disabled:text-secondary"
            disabled={!approved || !hasSelection || !sourceId || submitting}
            onClick={() => void submit()}
          >
            {submitting
              ? i18nService.t('browserImportImporting')
              : i18nService.t('browserImportSubmit')}
          </button>
        </div>
      </div>
    </Modal>,
    document.body,
  );
}
