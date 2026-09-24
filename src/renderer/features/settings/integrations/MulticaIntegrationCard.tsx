import { ArrowPathIcon, CheckIcon, ClipboardDocumentIcon } from '@heroicons/react/24/outline';
import type { MulticaIntegrationStatus } from '@shared/integrations/multica';
import React, { useCallback, useEffect, useState } from 'react';

import { i18nService } from '@/services/i18n';

const statusTone = (ready: boolean): string =>
  ready ? 'bg-success/10 text-success' : 'bg-surface-raised text-secondary';

const MulticaIntegrationCard: React.FC = () => {
  const [status, setStatus] = useState<MulticaIntegrationStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setError('');
      setStatus(await window.electron.multica.getStatus());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : i18nService.t('multicaStatusFailed'));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (): Promise<void> => {
    if (!status || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = status.enabled
        ? await window.electron.multica.disable()
        : await window.electron.multica.enable();
      setStatus(result.status);
      if (!result.success) setError(result.error || i18nService.t('multicaStatusFailed'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : i18nService.t('multicaStatusFailed'));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (key: string, value: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied(current => (current === key ? '' : current)), 1_500);
    } catch {
      setError(i18nService.t('multicaCopyFailed'));
    }
  };

  return (
    <section className="space-y-4 rounded-2xl border border-border bg-surface p-5 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h4 className="text-base font-semibold text-foreground">
            {i18nService.t('multicaIntegrationTitle')}
          </h4>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-secondary">
            {i18nService.t('multicaIntegrationDescription')}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-label={i18nService.t('multicaToggle')}
          aria-checked={status?.enabled === true}
          disabled={!status || busy || status.supported === false}
          onClick={() => void toggle()}
          className={`relative h-7 w-12 rounded-full transition-colors disabled:opacity-50 ${
            status?.enabled ? 'bg-primary' : 'bg-border'
          }`}
        >
          <span
            className={`absolute left-1 top-1 h-5 w-5 rounded-full bg-white shadow transition-transform ${
              status?.enabled ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
        </button>
      </div>

      {!status ? (
        <div className="text-sm text-secondary">{i18nService.t('multicaLoading')}</div>
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                label: i18nService.t('multicaBridgeStatus'),
                ready: status.bridgeState === 'running',
              },
              { label: i18nService.t('multicaLauncherStatus'), ready: status.launcherReady },
              {
                label: i18nService.t('multicaDetectedStatus'),
                ready: Boolean(status.multicaExecutable),
              },
              {
                label: i18nService
                  .t('multicaActiveTasks')
                  .replace('{count}', String(status.activeTaskCount)),
                ready: status.activeTaskCount > 0,
                showState: false,
              },
            ].map(({ label, ready, showState = true }) => (
              <div
                key={label}
                className={`rounded-xl px-3 py-2 text-xs font-medium ${statusTone(ready)}`}
              >
                {label}
                {showState && ` · ${i18nService.t(ready ? 'multicaReady' : 'multicaNotReady')}`}
              </div>
            ))}
          </div>

          {status.enabled && (
            <div className="space-y-3 rounded-xl border border-border bg-surface-raised/50 p-4">
              <div>
                <h5 className="text-sm font-semibold text-foreground">
                  {i18nService.t('multicaManualSetupTitle')}
                </h5>
                <p className="mt-1 text-xs leading-5 text-secondary">
                  {i18nService.t('multicaManualSetupDescription')}
                </p>
              </div>
              <ol className="grid gap-2 md:grid-cols-2">
                {[
                  ['multicaSetupStep1Title', 'multicaSetupStep1Description'],
                  ['multicaSetupStep2Title', 'multicaSetupStep2Description'],
                  ['multicaSetupStep3Title', 'multicaSetupStep3Description'],
                  ['multicaSetupStep4Title', 'multicaSetupStep4Description'],
                ].map(([titleKey, descriptionKey], index) => (
                  <li
                    key={titleKey}
                    className="flex gap-3 rounded-xl border border-border bg-background p-3"
                  >
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                      {index + 1}
                    </span>
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-foreground">
                        {i18nService.t(titleKey)}
                      </div>
                      <p className="mt-1 text-xs leading-5 text-secondary">
                        {i18nService.t(descriptionKey)}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
              {[
                [
                  'protocol',
                  i18nService.t('multicaProtocolFamily'),
                  status.manualSetup.protocolFamily,
                ],
                ['name', i18nService.t('multicaDisplayName'), status.manualSetup.displayName],
                ['command', i18nService.t('multicaCommand'), status.manualSetup.command],
                [
                  'description',
                  i18nService.t('multicaDescription'),
                  status.manualSetup.description,
                ],
              ].map(([key, label, value]) => (
                <div
                  key={key}
                  className="grid gap-1 sm:grid-cols-[140px_minmax(0,1fr)_36px] sm:items-center"
                >
                  <span className="text-xs font-medium text-secondary">{label}</span>
                  <code className="min-w-0 overflow-x-auto rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground">
                    {value || '—'}
                  </code>
                  <button
                    type="button"
                    disabled={!value}
                    onClick={() => void copy(key, value)}
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-secondary hover:bg-surface hover:text-primary disabled:opacity-40"
                    title={i18nService.t('multicaCopyValue')}
                  >
                    {copied === key ? (
                      <CheckIcon className="h-4 w-4" />
                    ) : (
                      <ClipboardDocumentIcon className="h-4 w-4" />
                    )}
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <div className="flex items-center justify-between gap-3">
        <div className="text-xs text-danger">{error}</div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void load()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-secondary hover:bg-surface-raised disabled:opacity-50"
        >
          <ArrowPathIcon className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} />
          {i18nService.t('multicaRefresh')}
        </button>
      </div>
    </section>
  );
};

export default MulticaIntegrationCard;
