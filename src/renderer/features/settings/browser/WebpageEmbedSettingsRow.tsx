import type { WebpageEmbedSettings } from '@shared/browser/webpageEmbedSettings';
import { useCallback, useEffect, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

type Status = 'loading' | 'ready' | 'saving' | 'error';

/** This native preference is saved immediately, independently of the proxy draft. */
export default function WebpageEmbedSettingsRow({ disabled = false }: { disabled?: boolean }) {
  const [settings, setSettings] = useState<WebpageEmbedSettings | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const operation = useRef(0);
  const busy = status === 'loading' || status === 'saving';

  const load = useCallback(async () => {
    const request = ++operation.current;
    setStatus('loading');
    setError(null);
    try {
      const result = await window.electron.webpageEmbed.getSettings();
      if (operation.current !== request) return;
      if (!result.success) {
        setError(i18nService.t(`browserWebpageEmbedError_${result.code}`));
        setStatus('error');
        return;
      }
      setSettings(result.value);
      setStatus('ready');
    } catch {
      if (operation.current !== request) return;
      setError(i18nService.t('browserWebpageEmbedError_unavailable'));
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    void load();
    return () => { operation.current += 1; };
  }, [load]);

  const toggle = async () => {
    if (!settings || status !== 'ready' || disabled) return;
    const request = ++operation.current;
    setStatus('saving');
    setError(null);
    try {
      const result = await window.electron.webpageEmbed.saveSettings({
        allowExternalEmbedUrls: !settings.allowExternalEmbedUrls,
        revision: settings.revision,
      });
      if (operation.current !== request) return;
      if (!result.success) {
        setError(i18nService.t(`browserWebpageEmbedError_${result.code}`));
        setStatus('error');
        return;
      }
      setSettings(result.value);
      setStatus('ready');
    } catch {
      if (operation.current !== request) return;
      // A failed acknowledgement is uncertain. Require a fresh read before another edit.
      setError(i18nService.t('browserWebpageEmbedError_unknown'));
      setStatus('error');
    }
  };

  const reloadButton = (
    <button
      type="button"
      disabled={disabled || busy}
      onClick={() => void load()}
      className="shrink-0 rounded text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
    >
      {i18nService.t('browserWebpageEmbedReload')}
    </button>
  );

  return (
    <div className="flex min-h-12 items-center justify-between gap-3 py-3">
      <div className="min-w-0 flex-1">
        <span id="browser-webpage-embed-label" className="text-sm text-foreground">
          {i18nService.t('browserWebpageEmbedTitle')}
        </span>
        <p id="browser-webpage-embed-description" className="mt-0.5 text-xs text-secondary">
          {i18nService.t('browserWebpageEmbedDescription')}
        </p>
        <div role="status" aria-live="polite" className="text-xs">
          {busy && (
            <p className="mt-1 text-secondary">
              {i18nService.t(status === 'saving' ? 'browserWebpageEmbedSaving' : 'browserWebpageEmbedLoading')}
            </p>
          )}
          {status === 'ready' && settings?.applied === false && (
            <p className="mt-1 flex items-center gap-2 text-secondary">
              <span>{i18nService.t('browserWebpageEmbedPending')}</span>
              {reloadButton}
            </p>
          )}
          {error && (
            <p className="mt-1 flex items-center gap-2 text-red-600 dark:text-red-400">
              <span>{error}</span>
              {reloadButton}
            </p>
          )}
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-labelledby="browser-webpage-embed-label"
        aria-describedby="browser-webpage-embed-description"
        aria-checked={settings?.allowExternalEmbedUrls === true}
        aria-busy={busy}
        disabled={disabled || status !== 'ready'}
        onClick={() => void toggle()}
        className={`flex h-6 w-10 shrink-0 items-center rounded-full p-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50 ${
          settings?.allowExternalEmbedUrls ? 'bg-primary' : 'bg-border'
        }`}
      >
        <span
          className={`h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
            settings?.allowExternalEmbedUrls ? 'translate-x-4' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  );
}
