import { CheckIcon, ClipboardDocumentIcon, FolderOpenIcon } from '@heroicons/react/24/outline';
import { useEffect, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

export default function StoragePathField({
  value, copyLabel, onOpen, openLabel, opening = false,
}: {
  value?: string;
  copyLabel: string;
  onOpen?: () => void;
  openLabel?: string;
  opening?: boolean;
}) {
  const t = (key: string) => i18nService.t(key);
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState(false);
  const revision = useRef(0);
  const inFlight = useRef(false);
  const timer = useRef<number>();
  useEffect(() => {
    revision.current += 1;
    inFlight.current = false;
    setCopied(false);
    setCopying(false);
    setError(false);
    return () => { revision.current += 1; window.clearTimeout(timer.current); };
  }, [value]);

  const copy = async () => {
    if (!value || inFlight.current) return;
    const current = ++revision.current;
    inFlight.current = true;
    setCopying(true);
    setCopied(false);
    setError(false);
    window.clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(value);
      if (current !== revision.current) return;
      setCopied(true);
      timer.current = window.setTimeout(() => setCopied(false), 1800);
    } catch {
      if (current === revision.current) setError(true);
    } finally {
      if (current === revision.current) {
        inFlight.current = false;
        setCopying(false);
      }
    }
  };
  const pathClass = 'block min-w-0 truncate font-mono text-xs leading-6 text-foreground';
  return (
    <div className={`relative min-w-0 rounded-lg border border-border bg-surface-raised px-3.5 py-2.5 text-secondary focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/10 ${onOpen ? 'pr-20' : 'pr-11'}`}>
      <code className={`${pathClass} select-all`} title={value}>{value ?? t('storageDirectoryLoading')}</code>
      <div className="absolute right-1.5 top-1.5 flex gap-1">
        {onOpen && (
          <button type="button" onClick={onOpen} disabled={!value || opening}
            aria-label={openLabel ?? t('storageDirectoryOpen')} title={openLabel ?? t('storageDirectoryOpen')}
            className="rounded-lg p-1.5 hover:bg-surface/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-40">
            <FolderOpenIcon className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
        <button type="button" aria-label={copyLabel} disabled={!value || copying}
          title={copied ? t('storageDirectoryCopied') : error ? t('storageDirectoryCopyFailed') : copyLabel}
          onClick={() => void copy()}
          className="rounded-lg p-1.5 hover:bg-surface/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-40">
          {copied ? <CheckIcon className="h-4 w-4 text-emerald-500" aria-hidden="true" />
            : <ClipboardDocumentIcon className="h-4 w-4" aria-hidden="true" />}
        </button>
      </div>
      <span role="status" className="sr-only">{copied ? t('storageDirectoryCopied') : ''}</span>
      {error && <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-300">{t('storageDirectoryCopyFailed')}</p>}
    </div>
  );
}
