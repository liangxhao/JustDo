import {
  ArrowPathIcon,
  CheckIcon,
  ClipboardDocumentIcon,
} from '@heroicons/react/24/outline';
import type { AppServerIntegrationStatus } from '@shared/integrations/appServerIntegration';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

const AppServerWebSocketConnectionCard: React.FC = () => {
  const titleId = useId();
  const [status, setStatus] = useState<AppServerIntegrationStatus | null>(null);
  const [busy, setBusy] = useState(true);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const copyRevision = useRef(0);
  const copyTimer = useRef<number>();

  const resetCopy = useCallback(() => {
    copyRevision.current += 1;
    window.clearTimeout(copyTimer.current);
    setCopied(false);
  }, []);

  const load = useCallback(async () => {
    const current = ++generation.current;
    resetCopy();
    setBusy(true);
    try {
      const next = await window.electron.appServer.getStatus();
      if (generation.current !== current) return;
      setStatus(next);
      setError('');
    } catch {
      if (generation.current !== current) return;
      setStatus(null);
      setError(i18nService.t('appServerWebSocketStatusFailed'));
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }, [resetCopy]);

  useEffect(() => {
    void load();
    return () => {
      generation.current += 1;
      copyRevision.current += 1;
      window.clearTimeout(copyTimer.current);
    };
  }, [load]);

  const copy = async () => {
    if (!status?.running || !status.url || busy) return;
    const current = ++copyRevision.current;
    window.clearTimeout(copyTimer.current);
    setCopied(false);
    try {
      // Fetch credentials only for this copy operation, never into view state.
      const config = await window.electron.appServer.getConnectionConfig();
      if (copyRevision.current !== current) return;
      await navigator.clipboard.writeText(JSON.stringify(config, null, 2));
      if (copyRevision.current !== current) return;
      setError('');
      setCopied(true);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1800);
    } catch {
      if (copyRevision.current === current)
        setError(i18nService.t('appServerWebSocketCopyFailed'));
    }
  };

  const ready = status?.running === true;
  const statusKey = busy
    ? 'appServerWebSocketLoading'
    : ready
      ? 'appServerWebSocketReady'
      : 'appServerWebSocketNotReady';

  return (
    <section
      aria-labelledby={titleId}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/70 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h5 id={titleId} className="text-sm font-semibold text-foreground">{i18nService.t('appServerWebSocketTitle')}</h5>
        <div className="flex items-center gap-2">
          <span role="status" className={`inline-flex items-center gap-1.5 text-xs ${ready && !busy ? 'text-success' : 'text-secondary'}`}>
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
            {i18nService.t(statusKey)}
          </span>
          <button
            type="button"
            disabled={busy}
            aria-label={i18nService.t('appServerWebSocketRefresh')}
            onClick={() => void load()}
            className="rounded-md p-1.5 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
          >
            <ArrowPathIcon className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>
      <p className="text-xs leading-5 text-secondary">{i18nService.t('appServerWebSocketDescription')}</p>
      <div className="min-w-0 space-y-1.5 rounded-lg bg-surface-raised/60 px-3 py-2.5">
        <p className="text-[11px] font-medium text-secondary">{i18nService.t('appServerWebSocketAddress')}</p>
        <code className="block min-w-0 select-all whitespace-pre-wrap break-all font-mono text-xs leading-5 text-foreground">
          {status?.url || '—'}
        </code>
      </div>
      <button
        type="button"
        disabled={busy || !ready || !status?.url}
        onClick={() => void copy()}
        className="inline-flex w-fit items-center justify-center gap-1.5 rounded-lg bg-primary/10 px-3 py-2 text-xs font-medium text-primary transition-colors hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
      >
        {copied ? <CheckIcon className="h-3.5 w-3.5" /> : <ClipboardDocumentIcon className="h-3.5 w-3.5" />}
        {i18nService.t(copied ? 'appServerWebSocketCopied' : 'appServerWebSocketCopyConfig')}
      </button>
      <p className="text-[11px] leading-5 text-secondary">{i18nService.t('appServerWebSocketAuthHint')}</p>
      {error && <p role="alert" className="text-xs leading-5 text-danger">{error}</p>}
      <span className="sr-only" aria-live="polite">
        {copied ? i18nService.t('appServerWebSocketCopied') : ''}
      </span>
    </section>
  );
};

export default AppServerWebSocketConnectionCard;
