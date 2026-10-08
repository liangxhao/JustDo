import {
  ArrowDownTrayIcon,
  ClockIcon,
  DocumentTextIcon,
  GlobeAltIcon,
  PhotoIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import type {
  BrowserClearDataRange,
  BrowserClearDataRequest,
  BrowserClearDataResult,
  BrowserClearDataSelection,
  BrowserClearDataSummary,
} from '@shared/browser/browser';
import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/ui/Modal';
import { isDomHTMLElement, useOwnerDocument } from '@/shared/dom/ownerDocument';

const ranges: BrowserClearDataRange[] = ['hour', 'day', 'week', 'four-weeks', 'all'];

const initialSelection: BrowserClearDataSelection = {
  history: true,
  cookiesAndSiteData: true,
  cache: true,
  downloads: true,
  autofill: false,
};

const ClearDataRow = ({
  checked,
  description,
  icon,
  label,
  onChange,
}: {
  checked: boolean;
  description: string;
  icon: React.ReactNode;
  label: string;
  onChange?: (checked: boolean) => void;
}) => (
  <label className="flex min-h-[60px] cursor-pointer items-center gap-3 px-4 py-2.5 hover:bg-surface-raised/45">
    <span className="text-secondary">{icon}</span>
    <span className="min-w-0 flex-1">
      <span className="block text-sm font-medium text-foreground">{label}</span>
      <span className="mt-0.5 block truncate text-xs text-secondary">{description}</span>
    </span>
    <input
      type="checkbox"
      checked={checked}
      className="h-4 w-4 rounded border-border accent-primary"
      aria-label={label}
      onChange={event => onChange?.(event.target.checked)}
    />
  </label>
);

const format = (key: string, replacements: Record<string, string | number>): string =>
  Object.entries(replacements).reduce(
    (value, [name, replacement]) => value.replace(`{${name}}`, String(replacement)),
    i18nService.t(key),
  );

export default function BrowserClearDataModal({
  onClose,
  onCleared,
}: {
  onClose: () => void;
  onCleared: (result: BrowserClearDataResult) => void;
}) {
  const ownerDocument = useOwnerDocument();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState<BrowserClearDataRange>('hour');
  const [selection, setSelection] = useState(initialSelection);
  const [summary, setSummary] = useState<BrowserClearDataSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(false);
  const hasSelection = Object.values(selection).some(Boolean);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    setSummary(null);
    void window.electron.browser
      .getClearDataSummary(range)
      .then(result => {
        if (cancelled) return;
        if (result.success && result.summary) setSummary(result.summary);
        else setError(true);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [range]);

  useEffect(() => {
    const previousFocus = isDomHTMLElement(ownerDocument.activeElement)
      ? ownerDocument.activeElement
      : null;
    dialogRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) {
        event.preventDefault();
        onClose();
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
  }, [onClose, submitting, ownerDocument]);

  const setCategory = (category: keyof BrowserClearDataSelection, checked: boolean) => {
    setSelection(current => ({ ...current, [category]: checked }));
  };

  const clear = async () => {
    if (!hasSelection || submitting) return;
    setSubmitting(true);
    setError(false);
    const request: BrowserClearDataRequest = { range, selection };
    try {
      const result = await window.electron.browser.clearBrowsingData(request);
      if (!result.success) {
        if (result.cleared) {
          onCleared(result);
          onClose();
          return;
        }
        setError(true);
        return;
      }
      onCleared(result);
      onClose();
    } catch {
      setError(true);
    } finally {
      setSubmitting(false);
    }
  };

  const count = (value: number | undefined): string =>
    loading ? i18nService.t('browserClearDataCalculating') : String(value ?? 0);
  const historyDescription = summary?.latestHistoryOrigin
    ? format('browserClearDataHistoryFrom', {
        count: count(summary.history),
        site: summary.latestHistoryOrigin,
      })
    : format('browserClearDataHistoryCount', { count: count(summary?.history) });

  return createPortal(
    <Modal
      onClose={onClose}
      closeOnBackdrop={!submitting}
      overlayClassName="fixed inset-0 z-[120] flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px]"
      className="max-h-[calc(100vh-2rem)] w-full max-w-[680px] overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="flex max-h-[calc(100vh-2rem)] flex-col outline-none"
      >
        <div className="flex items-center gap-3 px-5 pb-2 pt-5">
          <h2 id={titleId} className="min-w-0 flex-1 text-xl font-semibold tracking-tight">
            {i18nService.t('browserClearDataTitle')}
          </h2>
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

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
          <div
            className="mb-3 flex flex-wrap gap-2"
            aria-label={i18nService.t('browserClearDataRange')}
          >
            {ranges.map(item => (
              <button
                key={item}
                type="button"
                aria-pressed={range === item}
                className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                  range === item
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-border bg-surface-raised/60 text-foreground hover:bg-surface-raised'
                }`}
                onClick={() => setRange(item)}
              >
                {i18nService.t(`browserClearDataRange_${item}`)}
              </button>
            ))}
          </div>

          <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface/35">
            <ClearDataRow
              checked={selection.history}
              label={i18nService.t('browserClearDataHistory')}
              description={historyDescription}
              icon={<ClockIcon className="h-5 w-5" />}
              onChange={checked => setCategory('history', checked)}
            />
            <ClearDataRow
              checked={selection.cookiesAndSiteData}
              label={i18nService.t('browserClearDataCookies')}
              description={format('browserClearDataCookieSites', {
                count: count(summary?.cookieSites),
              })}
              icon={<GlobeAltIcon className="h-5 w-5" />}
              onChange={checked => setCategory('cookiesAndSiteData', checked)}
            />
            <ClearDataRow
              checked={selection.cache}
              label={i18nService.t('browserClearDataCache')}
              description={i18nService.t('browserClearDataCacheDescription')}
              icon={<PhotoIcon className="h-5 w-5" />}
              onChange={checked => setCategory('cache', checked)}
            />
            <ClearDataRow
              checked={selection.downloads}
              label={i18nService.t('browserClearDataDownloads')}
              description={format('browserClearDataDownloadCount', {
                count: count(summary?.downloads),
              })}
              icon={<ArrowDownTrayIcon className="h-5 w-5" />}
              onChange={checked => setCategory('downloads', checked)}
            />
            <ClearDataRow
              checked={selection.autofill}
              label={i18nService.t('browserClearDataAutofill')}
              description={format('browserClearDataAutofillCount', {
                count: count(summary?.autofill),
              })}
              icon={<DocumentTextIcon className="h-5 w-5" />}
              onChange={checked => setCategory('autofill', checked)}
            />
          </div>

          {range !== 'all' && (selection.cookiesAndSiteData || selection.cache) && (
            <p className="mt-3 text-xs leading-5 text-secondary">
              {i18nService.t('browserClearDataStorageRangeNotice')}
            </p>
          )}
          {error && (
            <p
              role="alert"
              className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400"
            >
              {i18nService.t('browserClearDataFailed')}
            </p>
          )}
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-border bg-surface-raised/20 px-5 py-4">
          <button
            type="button"
            className="rounded-lg px-4 py-2 text-sm hover:bg-surface-raised"
            disabled={submitting}
            onClick={onClose}
          >
            {i18nService.t('cancel')}
          </button>
          <button
            type="button"
            className="min-w-24 rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!hasSelection || submitting}
            onClick={() => void clear()}
          >
            {submitting
              ? i18nService.t('browserClearDataClearing')
              : i18nService.t('browserClearDataSubmit')}
          </button>
        </div>
      </div>
    </Modal>,
    ownerDocument.body,
  );
}
