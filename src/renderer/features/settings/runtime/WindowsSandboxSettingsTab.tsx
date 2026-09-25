import {
  ArrowPathIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import type { WindowsSandboxStatus } from '@shared/security/windowsSandbox';
import React, { useCallback, useEffect, useState } from 'react';

import { i18nService } from '@/services/i18n';

type ExecutionMode = 'local' | 'sandbox';

const statusLabel = (status: WindowsSandboxStatus | null): string => {
  if (!status) return i18nService.t('windowsSandboxChecking');
  return i18nService.t(`windowsSandboxStatus_${status.code}`);
};

const WindowsSandboxSettingsTab: React.FC = () => {
  const [status, setStatus] = useState<WindowsSandboxStatus | null>(null);
  const [executionMode, setExecutionMode] = useState<ExecutionMode>('local');
  const [sandboxNetworkEnabled, setSandboxNetworkEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    const [nextStatus, configResult] = await Promise.all([
      window.electron.cowork.getWindowsSandboxStatus(),
      window.electron.cowork.getConfig(),
    ]);
    setStatus(nextStatus);
    if (configResult.success && configResult.config) {
      setExecutionMode(configResult.config.executionMode === 'sandbox' ? 'sandbox' : 'local');
      setSandboxNetworkEnabled(configResult.config.sandboxNetworkEnabled);
    }
  }, []);

  useEffect(() => {
    void refresh().catch(loadError => {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    });
  }, [refresh]);

  const updateMode = async (nextMode: ExecutionMode) => {
    if (nextMode === 'sandbox' && !status?.ready) return;
    setSwitching(true);
    setBusy(true);
    setError(null);
    try {
      const result = await window.electron.cowork.setConfig({ executionMode: nextMode });
      if (!result.success) throw new Error(result.error || i18nService.t('saveFailed'));
      setExecutionMode(nextMode);
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : String(updateError));
    } finally {
      setSwitching(false);
      setBusy(false);
    }
  };

  const updateNetworkAccess = async (enabled: boolean) => {
    setSwitching(true);
    setBusy(true);
    setError(null);
    try {
      const result = await window.electron.cowork.setConfig({ sandboxNetworkEnabled: enabled });
      if (!result.success) throw new Error(result.error || i18nService.t('saveFailed'));
      setSandboxNetworkEnabled(enabled);
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : String(updateError));
    } finally {
      setSwitching(false);
      setBusy(false);
    }
  };

  const initialize = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.electron.cowork.initializeWindowsSandbox();
      setStatus(result.status);
      if (!result.success) throw new Error(result.error);
    } catch (initializationError) {
      setError(
        initializationError instanceof Error
          ? initializationError.message
          : String(initializationError),
      );
    } finally {
      setBusy(false);
    }
  };

  const statusIcon = !status ? (
    <ArrowPathIcon className="h-4 w-4 animate-spin text-secondary" />
  ) : status.ready ? (
    <CheckCircleIcon className="h-4 w-4 text-success" />
  ) : (
    <ExclamationTriangleIcon className="h-4 w-4 text-warning" />
  );

  return (
    <div className="space-y-5">
      <section>
        <h4 className="text-base font-semibold text-foreground">
          {i18nService.t('windowsSandboxExecutionMode')}
        </h4>
        <p className="mt-1 text-sm leading-6 text-secondary">
          {i18nService.t('windowsSandboxExecutionModeDescription')}
        </p>
        {switching && (
          <div role="status" className="mt-2 flex items-center gap-2 text-xs text-secondary">
            <ArrowPathIcon className="h-4 w-4 animate-spin" />
            {i18nService.t('windowsSandboxSwitching')}
          </div>
        )}

        <label
          className={`mt-4 flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition-colors ${
            executionMode === 'local'
              ? 'border-primary bg-primary-muted/40'
              : 'border-border hover:bg-surface-raised'
          }`}
        >
          <input
            type="radio"
            name="executionMode"
            checked={executionMode === 'local'}
            disabled={busy}
            onChange={() => void updateMode('local')}
            className="mt-0.5 h-4 w-4 text-primary"
          />
          <span>
            <span className="block text-sm font-medium text-foreground">
              {i18nService.t('windowsSandboxLocalMode')}
            </span>
            <span className="mt-1 block text-xs leading-5 text-secondary">
              {i18nService.t('windowsSandboxLocalModeDescription')}
            </span>
          </span>
        </label>
        <div
          className={`mt-3 rounded-xl border transition-colors ${
            executionMode === 'sandbox' ? 'border-primary bg-primary-muted/40' : 'border-border'
          }`}
        >
          <label
            className={`flex items-start gap-3 p-4 ${
              status?.ready ? 'cursor-pointer' : 'cursor-not-allowed'
            }`}
          >
            <input
              type="radio"
              name="executionMode"
              checked={executionMode === 'sandbox'}
              disabled={busy || !status?.ready}
              onChange={() => void updateMode('sandbox')}
              className="mt-0.5 h-4 w-4 text-primary"
            />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-foreground">
                {i18nService.t('windowsSandboxMode')}
              </span>
              <span className="mt-1 block text-xs leading-5 text-secondary">
                {i18nService.t('windowsSandboxModeDescription')}
              </span>
            </span>
          </label>

          <div className="mx-4 flex flex-wrap items-center justify-between gap-3 border-t border-border py-3">
            <div className="flex items-center gap-2 text-xs text-secondary">
              {statusIcon}
              <span>{statusLabel(status)}</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void refresh()}
                className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-secondary transition-colors hover:bg-surface disabled:opacity-50"
              >
                <ArrowPathIcon className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />
                {i18nService.t('refresh')}
              </button>
              {status?.supported && status.helperAvailable && status.hostPreparationRecommended && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void initialize()}
                  className="rounded-lg bg-primary px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
                >
                  {busy
                    ? i18nService.t('windowsSandboxInitializing')
                    : i18nService.t('windowsSandboxInitialize')}
                </button>
              )}
            </div>
          </div>

          {executionMode === 'sandbox' && (
            <div className="mx-4 border-t border-border py-4">
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={sandboxNetworkEnabled}
                  disabled={busy}
                  onChange={event => void updateNetworkAccess(event.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-border text-primary"
                />
                <span>
                  <span className="block text-sm font-medium text-foreground">
                    {i18nService.t('windowsSandboxAllowNetwork')}
                  </span>
                  <span className="mt-1 block text-xs leading-5 text-secondary">
                    {i18nService.t('windowsSandboxAllowNetworkDescription')}
                  </span>
                </span>
              </label>
              {sandboxNetworkEnabled && (
                <p className="mt-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs leading-5 text-warning">
                  {i18nService.t('windowsSandboxNetworkWarning')}
                </p>
              )}
            </div>
          )}
        </div>
      </section>

      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
};

export default WindowsSandboxSettingsTab;
