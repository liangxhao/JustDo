import { ArrowPathIcon, ClipboardDocumentIcon } from '@heroicons/react/24/outline';
import type { MulticaIntegrationResult, MulticaIntegrationStatus } from '@shared/multica';
import React, { useCallback, useEffect, useState } from 'react';

import { i18nService } from '@/services/i18n';

const StatusRow: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className="grid gap-1 border-t border-border px-4 py-2.5 first:border-t-0 sm:grid-cols-[180px_minmax(0,1fr)] sm:items-center">
    <span className="text-xs font-medium text-secondary">{label}</span>
    <span className="min-w-0 break-all text-xs text-foreground">{value}</span>
  </div>
);

const ManualSetupRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="grid gap-1 border-t border-border px-3 py-2 first:border-t-0 sm:grid-cols-[140px_minmax(0,1fr)] sm:items-center">
    <span className="text-[11px] font-medium text-secondary">{label}</span>
    <span className="flex min-w-0 items-center gap-2">
      <code className="min-w-0 flex-1 break-all text-xs text-foreground">{value}</code>
      <button
        type="button"
        onClick={() => void navigator.clipboard.writeText(value)}
        className="shrink-0 rounded-md p-1 text-secondary hover:bg-surface-inset hover:text-foreground"
        title={i18nService.t('multicaCopyValue')}
      >
        <ClipboardDocumentIcon className="h-4 w-4" />
      </button>
    </span>
  </div>
);

const MulticaIntegrationCard: React.FC = () => {
  const [status, setStatus] = useState<MulticaIntegrationStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const result = await window.electron.multica.refresh();
      setStatus(result.status);
      setError(result.success ? null : result.error || result.status.error || null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<MulticaIntegrationResult>) => {
    setBusy(true);
    try {
      const result = await action();
      setStatus(result.status);
      setError(result.success ? null : result.error || result.status.error || null);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setBusy(false);
    }
  };

  const daemonLabel = status
    ? i18nService.t(`multicaDaemon_${status.daemonState}`)
    : i18nService.t('loading');
  const bridgeLabel = status
    ? i18nService.t(`multicaBridge_${status.bridgeState}`)
    : i18nService.t('loading');
  const statusError = status?.error;

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex items-start justify-between gap-4 bg-surface-raised px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">
            {i18nService.t('multicaIntegrationTitle')}
          </h3>
          <p className="mt-0.5 text-[11px] leading-4 text-secondary">
            {i18nService.t('multicaIntegrationDescription')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(window.electron.multica.refresh)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium text-secondary hover:bg-surface-inset hover:text-foreground disabled:opacity-40"
          >
            <ArrowPathIcon className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} />
            {i18nService.t('multicaRecheck')}
          </button>
          <button
            type="button"
            disabled={busy || !status?.supported}
            onClick={() =>
              void run(
                status?.enabled ? window.electron.multica.disable : window.electron.multica.enable,
              )
            }
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${status?.enabled ? 'bg-primary' : 'bg-border'}`}
            aria-label={i18nService.t('multicaEnable')}
            aria-pressed={status?.enabled === true}
          >
            <span
              className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${status?.enabled ? 'translate-x-5' : 'translate-x-0'}`}
            />
          </button>
        </div>
      </div>

      <div>
        <StatusRow
          label={i18nService.t('multicaLauncherPath')}
          value={
            <span className="flex items-center gap-2">
              <span className="min-w-0 flex-1 break-all font-mono">
                {status?.launcherPath || '—'}
              </span>
              {status?.launcherPath && (
                <button
                  type="button"
                  onClick={() => void navigator.clipboard.writeText(status.launcherPath)}
                  className="shrink-0 rounded-md p-1 text-secondary hover:bg-surface-inset hover:text-foreground"
                  title={i18nService.t('multicaCopyPath')}
                >
                  <ClipboardDocumentIcon className="h-4 w-4" />
                </button>
              )}
            </span>
          }
        />
        <StatusRow
          label={i18nService.t('multicaBridgeStatus')}
          value={`${bridgeLabel} · v${status?.bridgeProtocolVersion ?? '—'} · ${i18nService
            .t('multicaBundledRuntimeVersion')
            .replace('{version}', status?.openclawVersion ?? '—')}`}
        />
        <StatusRow
          label={i18nService.t('multicaGatewayStatus')}
          value={`${status?.gatewayPhase ?? '—'}${status?.gatewayPort ? ` · 127.0.0.1:${status.gatewayPort}` : ''}`}
        />
        <StatusRow
          label={i18nService.t('multicaDaemonStatus')}
          value={`${daemonLabel}${status?.multicaVersion ? ` · ${status.multicaVersion}` : ''}${status?.profileName ? ` · ${status.profileName}` : ''}`}
        />
        <StatusRow
          label={i18nService.t('multicaRegistrationStatus')}
          value={
            status?.launcherReady
              ? i18nService.t('multicaRegisteredAsProduct')
              : i18nService.t('multicaNotRegistered')
          }
        />
        {status?.activeTaskCount ? (
          <StatusRow
            label={i18nService.t('multicaActiveTasks')}
            value={String(status.activeTaskCount)}
          />
        ) : null}
      </div>

      {status?.enabled && status.launcherReady && (
        <div className="border-t border-border bg-surface-raised px-4 py-3">
          <h4 className="text-xs font-semibold text-foreground">
            {i18nService.t('multicaManualSetupTitle')}
          </h4>
          <p className="mt-1 text-[11px] leading-4 text-secondary">
            {i18nService.t('multicaManualSetupDescription')}
          </p>
          <div className="mt-3 overflow-hidden rounded-lg border border-border bg-surface">
            <ManualSetupRow
              label={i18nService.t('multicaManualProtocolFamily')}
              value={status.manualSetup.protocolFamily}
            />
            <ManualSetupRow
              label={i18nService.t('multicaManualDisplayName')}
              value={status.manualSetup.displayName}
            />
            <ManualSetupRow
              label={i18nService.t('multicaManualCommandName')}
              value={status.manualSetup.commandName}
            />
            <ManualSetupRow
              label={i18nService.t('multicaManualDescription')}
              value={status.manualSetup.description}
            />
          </div>
        </div>
      )}

      {(error || statusError || !status?.supported) && (
        <p className="border-t border-border px-4 py-2.5 text-xs leading-5 text-amber-700 dark:text-amber-300">
          {!status?.supported
            ? statusError || i18nService.t('multicaPackagedOnly')
            : error || statusError}
        </p>
      )}
    </section>
  );
};

export default MulticaIntegrationCard;
