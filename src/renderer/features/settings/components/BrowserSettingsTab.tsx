import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  ComputerDesktopIcon,
  ExclamationTriangleIcon,
  UserCircleIcon,
} from '@heroicons/react/24/outline';
import {
  type BrowserConnectionStatus,
  BrowserMode,
  type BrowserMode as BrowserModeValue,
  normalizeBrowserMode,
} from '@shared/browser';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { configService } from '@/services/config';
import { i18nService } from '@/services/i18n';

type StepProps = {
  complete: boolean;
  title: string;
  description: string;
  action?: React.ReactNode;
};

const SetupStep: React.FC<StepProps> = ({ complete, title, description, action }) => (
  <div className="flex gap-4 rounded-xl border border-border bg-surface-raised p-4">
    <div className="pt-0.5">
      {complete ? (
        <CheckCircleIcon className="h-6 w-6 text-primary" />
      ) : (
        <div className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-border text-xs text-secondary">
          •
        </div>
      )}
    </div>
    <div className="min-w-0 flex-1">
      <h4 className="text-sm font-medium text-foreground">{title}</h4>
      <p className="mt-1 text-sm leading-6 text-secondary">{description}</p>
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  </div>
);

const BrowserSettingsTab: React.FC = () => {
  const [browserMode, setBrowserMode] = useState<BrowserModeValue>(() =>
    normalizeBrowserMode(configService.getConfig().browserMode),
  );
  const [status, setStatus] = useState<BrowserConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<'open' | 'restart' | 'test' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [setupUrlCopied, setSetupUrlCopied] = useState(false);
  const [connectionVerified, setConnectionVerified] = useState(false);
  const [savingMode, setSavingMode] = useState(false);
  const refreshRequestIdRef = useRef(0);
  const statusRef = useRef<BrowserConnectionStatus | null>(null);

  const refresh = useCallback(async () => {
    const requestId = ++refreshRequestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await window.electron.browser.getStatus();
      if (!result.success || !result.status) {
        throw new Error(i18nService.t('browserStatusFailed'));
      }
      if (requestId !== refreshRequestIdRef.current) return;
      const previousStatus = statusRef.current;
      statusRef.current = result.status;
      setStatus(result.status);
      if (
        !result.status.endpointReachable ||
        (typeof previousStatus?.activePort === 'number' &&
          previousStatus.activePort !== result.status.activePort)
      ) {
        setConnectionVerified(false);
      }
    } catch (refreshError) {
      if (requestId !== refreshRequestIdRef.current) return;
      statusRef.current = null;
      setStatus(null);
      setConnectionVerified(false);
      setError(
        refreshError instanceof Error ? refreshError.message : i18nService.t('browserStatusFailed'),
      );
    } finally {
      if (requestId === refreshRequestIdRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (browserMode === BrowserMode.User) {
      void refresh();
    } else {
      refreshRequestIdRef.current += 1;
      statusRef.current = null;
      setLoading(false);
      setStatus(null);
      setConnectionVerified(false);
    }
    return () => {
      refreshRequestIdRef.current += 1;
    };
  }, [browserMode, refresh]);

  const selectBrowserMode = async (mode: BrowserModeValue) => {
    if (mode === browserMode || savingMode) return;
    setSavingMode(true);
    setError(null);
    try {
      const result = await window.electron.browser.setMode(mode);
      if (!result.success || !result.mode)
        throw new Error(i18nService.t('browserModeChangeFailed'));
      setBrowserMode(result.mode);
      await configService.reloadFromStore();
    } catch (modeError) {
      setError(
        modeError instanceof Error ? modeError.message : i18nService.t('browserModeChangeFailed'),
      );
    } finally {
      setSavingMode(false);
    }
  };

  const openRemoteDebugging = async () => {
    setBusyAction('open');
    setError(null);
    try {
      const result = await window.electron.browser.openRemoteDebugging();
      if (!result.success) throw new Error(i18nService.t('browserOpenSetupFailed'));
      setSetupUrlCopied(true);
    } catch {
      setError(i18nService.t('browserOpenSetupFailed'));
    } finally {
      setBusyAction(null);
    }
  };

  const restartGateway = async () => {
    setBusyAction('restart');
    setError(null);
    try {
      const result = await window.electron.openclaw.engine.restartGateway();
      if (!result.success) throw new Error(i18nService.t('browserGatewayRestartFailed'));
      await refresh();
    } catch {
      setError(i18nService.t('browserGatewayRestartFailed'));
    } finally {
      setBusyAction(null);
    }
  };

  const testConnection = async () => {
    setBusyAction('test');
    setError(null);
    setConnectionVerified(false);
    try {
      const result = await window.electron.browser.testConnection();
      if (result.success) {
        setConnectionVerified(true);
      } else if (result.errorCode === 'permission-timeout') {
        setError(i18nService.t('browserPermissionTimeout'));
      } else if (result.errorCode === 'gateway-unavailable') {
        setError(i18nService.t('browserGatewayUnavailable'));
      } else {
        setError(i18nService.t('browserConnectionFailed'));
      }
    } catch {
      setError(i18nService.t('browserConnectionFailed'));
    } finally {
      setBusyAction(null);
    }
  };

  const statusLabel = status?.endpointReachable
    ? i18nService.t('browserStatusReady')
    : status?.issue === 'chrome-restart-required'
      ? i18nService.t('browserStatusRestartRequired')
      : i18nService.t('browserStatusNotReady');

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-semibold text-foreground">
          {i18nService.t('browserModeTitle')}
        </h3>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-secondary">
          {i18nService.t('browserModeDescription')}
        </p>
      </div>

      <div
        role="radiogroup"
        aria-label={i18nService.t('browserModeTitle')}
        className="grid gap-3 md:grid-cols-2"
      >
        {[
          {
            mode: BrowserMode.Isolated,
            icon: ComputerDesktopIcon,
            title: i18nService.t('browserModeIsolatedTitle'),
            description: i18nService.t('browserModeIsolatedDescription'),
          },
          {
            mode: BrowserMode.User,
            icon: UserCircleIcon,
            title: i18nService.t('browserModeUserTitle'),
            description: i18nService.t('browserModeUserDescription'),
          },
        ].map(option => {
          const selected = browserMode === option.mode;
          const Icon = option.icon;
          return (
            <button
              key={option.mode}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={savingMode}
              onClick={() => void selectBrowserMode(option.mode)}
              className={`flex items-start gap-3 rounded-xl border p-4 text-left transition-colors disabled:opacity-60 ${
                selected
                  ? 'border-primary bg-primary/5'
                  : 'border-border bg-surface-raised hover:border-primary/50'
              }`}
            >
              <Icon
                className={`mt-0.5 h-6 w-6 shrink-0 ${selected ? 'text-primary' : 'text-secondary'}`}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                  {option.title}
                  {selected ? <CheckCircleIcon className="h-4 w-4 text-primary" /> : null}
                </span>
                <span className="mt-1 block text-sm leading-6 text-secondary">
                  {option.description}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {error ? (
        <div className="rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
          {error}
        </div>
      ) : null}

      {browserMode === BrowserMode.Isolated ? (
        <div className="rounded-xl border border-primary/30 bg-primary/5 p-4 text-sm leading-6 text-foreground">
          {i18nService.t('browserModeIsolatedActive')}
        </div>
      ) : (
        <>
          <div>
            <h3 className="text-base font-semibold text-foreground">
              {i18nService.t('browserUserChromeTitle')}
            </h3>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-secondary">
              {i18nService.t('browserUserChromeDescription')}
            </p>
          </div>

          <div
            role="status"
            aria-live="polite"
            className={`flex items-center gap-3 rounded-xl border p-4 ${
              status?.endpointReachable
                ? 'border-primary/30 bg-primary/5'
                : 'border-warning/30 bg-warning/5'
            }`}
          >
            {status?.endpointReachable ? (
              <CheckCircleIcon className="h-6 w-6 shrink-0 text-primary" />
            ) : (
              <ExclamationTriangleIcon className="h-6 w-6 shrink-0 text-warning" />
            )}
            <div>
              <div className="text-sm font-medium text-foreground">{statusLabel}</div>
              {status?.activePort ? (
                <div className="mt-0.5 text-xs text-secondary">
                  {i18nService.t('browserDetectedPort')}: {status.activePort}
                </div>
              ) : null}
            </div>
          </div>

          <div className="space-y-3">
            <SetupStep
              complete={status?.chromeFound === true}
              title={i18nService.t('browserStepChromeTitle')}
              description={i18nService.t('browserStepChromeDescription')}
            />
            <SetupStep
              complete={status?.remoteDebuggingEnabled === true}
              title={i18nService.t('browserStepDebuggingTitle')}
              description={i18nService.t('browserStepDebuggingDescription')}
              action={
                <button
                  type="button"
                  onClick={() => void openRemoteDebugging()}
                  disabled={busyAction === 'open' || status?.chromeFound !== true}
                  className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                >
                  <ArrowTopRightOnSquareIcon className="h-4 w-4" />
                  {i18nService.t('browserCopyDebuggingAddress')}
                </button>
              }
            />
            {setupUrlCopied ? (
              <div className="ml-10 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm leading-6 text-foreground">
                {i18nService.t('browserDebuggingAddressCopied')}
                <code className="ml-1 select-all rounded bg-surface-raised px-1.5 py-0.5 text-xs">
                  chrome://inspect/#remote-debugging
                </code>
              </div>
            ) : null}
            <SetupStep
              complete={status?.endpointReachable === true}
              title={i18nService.t('browserStepRestartChromeTitle')}
              description={
                status?.issue === 'chrome-restart-required'
                  ? i18nService.t('browserStepRestartChromeStaleDescription')
                  : i18nService.t('browserStepRestartChromeDescription')
              }
              action={
                <button
                  type="button"
                  onClick={() => void refresh()}
                  disabled={loading || busyAction !== null}
                  className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-surface-raised disabled:opacity-50"
                >
                  <ArrowPathIcon className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                  {i18nService.t('browserRefreshStatus')}
                </button>
              }
            />
            <SetupStep
              complete={connectionVerified}
              title={i18nService.t('browserStepAuthorizeTitle')}
              description={i18nService.t('browserStepAuthorizeDescription')}
              action={
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void restartGateway()}
                    disabled={loading || busyAction !== null || status?.endpointReachable !== true}
                    className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-surface-raised disabled:opacity-50"
                  >
                    <ArrowPathIcon
                      className={`h-4 w-4 ${busyAction === 'restart' ? 'animate-spin' : ''}`}
                    />
                    {i18nService.t('browserRestartGateway')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void testConnection()}
                    disabled={loading || busyAction !== null || status?.endpointReachable !== true}
                    className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                  >
                    <ArrowPathIcon
                      className={`h-4 w-4 ${busyAction === 'test' ? 'animate-spin' : ''}`}
                    />
                    {i18nService.t('browserTestConnection')}
                  </button>
                  {connectionVerified ? (
                    <span className="inline-flex items-center gap-1.5 px-2 text-sm text-primary">
                      <CheckCircleIcon className="h-4 w-4" />
                      {i18nService.t('browserConnectionVerified')}
                    </span>
                  ) : null}
                </div>
              }
            />
          </div>
        </>
      )}
    </div>
  );
};

export default BrowserSettingsTab;
