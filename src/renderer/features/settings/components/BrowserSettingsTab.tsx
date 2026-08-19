import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  ClipboardDocumentIcon,
  ComputerDesktopIcon,
  ExclamationTriangleIcon,
  FolderOpenIcon,
  PuzzlePieceIcon,
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

const actionButtonClassName =
  'inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-md border border-border/70 bg-surface px-2.5 text-[11px] font-medium text-secondary transition-all duration-150 hover:border-primary/30 hover:bg-primary/5 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border/70 disabled:hover:bg-surface disabled:hover:text-secondary';

type StepProps = {
  number: number;
  complete: boolean;
  title: string;
  description: string;
  action?: React.ReactNode;
};

const SetupStep: React.FC<StepProps> = ({ number, complete, title, description, action }) => (
  <div className="flex gap-3.5 px-5 py-4">
    <div className="pt-0.5" aria-hidden="true">
      {complete ? (
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-white shadow-sm shadow-primary/20">
          <CheckCircleIcon className="h-4 w-4" />
        </span>
      ) : (
        <span className="flex h-7 w-7 items-center justify-center rounded-full border border-border bg-surface-raised/60 text-xs font-semibold text-muted">
          {number}
        </span>
      )}
    </div>
    <div className="flex min-w-0 flex-1 items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <h4 className="text-[13px] font-semibold leading-6 text-foreground">{title}</h4>
        <p className="mt-0.5 text-[13px] leading-5 text-secondary">{description}</p>
      </div>
      {action ? <div className="min-w-0 max-w-[52%] shrink-0">{action}</div> : null}
    </div>
  </div>
);

const BrowserSettingsTab: React.FC = () => {
  const [browserMode, setBrowserMode] = useState<BrowserModeValue>(() =>
    normalizeBrowserMode(configService.getConfig().browserMode),
  );
  const [status, setStatus] = useState<BrowserConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<
    'open' | 'test' | 'extension-page' | 'extension-folder' | 'pair' | 'extension-test' | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [setupUrlCopied, setSetupUrlCopied] = useState(false);
  const [connectionVerified, setConnectionVerified] = useState(false);
  const [extensionFolderRevealed, setExtensionFolderRevealed] = useState(false);
  const [extensionPairingCopied, setExtensionPairingCopied] = useState(false);
  const [connectionTestError, setConnectionTestError] = useState<string | null>(null);
  const [savingMode, setSavingMode] = useState(false);
  const refreshRequestIdRef = useRef(0);
  const statusRef = useRef<BrowserConnectionStatus | null>(null);

  const refresh = useCallback(async () => {
    const requestId = ++refreshRequestIdRef.current;
    setLoading(true);
    setError(null);
    setConnectionTestError(null);
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
      setConnectionTestError(null);
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
    setSetupUrlCopied(false);
    setConnectionVerified(false);
    setConnectionTestError(null);
    setExtensionFolderRevealed(false);
    setExtensionPairingCopied(false);
    if (browserMode === BrowserMode.User || browserMode === BrowserMode.Extension) {
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
    if (mode === browserMode || savingMode || busyAction !== null) return;
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
    setConnectionTestError(null);
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

  const testConnection = async () => {
    setBusyAction('test');
    setError(null);
    setConnectionTestError(null);
    setConnectionVerified(false);
    try {
      const result = await window.electron.browser.testConnection();
      if (result.success) {
        setConnectionVerified(true);
      } else if (result.errorCode === 'permission-timeout') {
        setConnectionTestError(i18nService.t('browserPermissionTimeout'));
      } else if (result.errorCode === 'gateway-unavailable') {
        setConnectionTestError(i18nService.t('browserGatewayUnavailable'));
      } else {
        setConnectionTestError(i18nService.t('browserConnectionFailed'));
      }
    } catch {
      setConnectionTestError(i18nService.t('browserConnectionFailed'));
    } finally {
      setBusyAction(null);
    }
  };

  const openExtensionManagement = async () => {
    setBusyAction('extension-page');
    setError(null);
    try {
      const result = await window.electron.browser.openExtensionManagement();
      if (!result.success) throw new Error(i18nService.t('browserExtensionOpenPageFailed'));
      setSetupUrlCopied(true);
    } catch {
      setError(i18nService.t('browserExtensionOpenPageFailed'));
    } finally {
      setBusyAction(null);
    }
  };

  const revealExtension = async () => {
    setBusyAction('extension-folder');
    setError(null);
    try {
      const result = await window.electron.browser.revealExtension();
      if (!result.success) throw new Error(i18nService.t('browserExtensionRevealFailed'));
      setExtensionFolderRevealed(true);
    } catch {
      setError(i18nService.t('browserExtensionRevealFailed'));
    } finally {
      setBusyAction(null);
    }
  };

  const copyExtensionPairing = async () => {
    setBusyAction('pair');
    setError(null);
    try {
      const result = await window.electron.browser.copyExtensionPairing();
      if (!result.success) throw new Error(i18nService.t('browserExtensionPairingFailed'));
      setExtensionPairingCopied(true);
    } catch {
      setError(i18nService.t('browserExtensionPairingFailed'));
    } finally {
      setBusyAction(null);
    }
  };

  const testExtensionConnection = async () => {
    setBusyAction('extension-test');
    setError(null);
    setConnectionTestError(null);
    setConnectionVerified(false);
    try {
      const result = await window.electron.browser.testExtensionConnection();
      if (result.success) {
        setConnectionVerified(true);
      } else if (result.errorCode === 'gateway-unavailable') {
        setConnectionTestError(i18nService.t('browserGatewayUnavailable'));
      } else {
        setConnectionTestError(i18nService.t('browserExtensionConnectionFailed'));
      }
    } catch {
      setConnectionTestError(i18nService.t('browserExtensionConnectionFailed'));
    } finally {
      setBusyAction(null);
    }
  };

  const statusLabel = status?.endpointReachable
    ? i18nService.t('browserStatusReady')
    : status?.issue === 'port-occupied-by-other-process'
      ? i18nService.t('browserStatusPortOccupied')
      : status?.issue === 'chrome-restart-required'
        ? i18nService.t('browserStatusRestartRequired')
        : i18nService.t('browserStatusNotReady');

  const portOwnerLabel = status?.activePort
    ? status.activePortOwner
      ? i18nService
          .t('browserPortOwner')
          .replace(
            '{process}',
            status.activePortOwner.processName || i18nService.t('browserUnknownProcess'),
          )
          .replace('{pid}', String(status.activePortOwner.pid))
      : status.activePortOwnerResolved
        ? i18nService.t('browserPortUnoccupied')
        : i18nService.t('browserPortOwnerUnknown')
    : null;

  return (
    <div className="space-y-5">
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
        className="grid gap-2.5 md:grid-cols-3"
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
          {
            mode: BrowserMode.Extension,
            icon: PuzzlePieceIcon,
            title: i18nService.t('browserModeExtensionTitle'),
            description: i18nService.t('browserModeExtensionDescription'),
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
              disabled={savingMode || busyAction !== null}
              onClick={() => void selectBrowserMode(option.mode)}
              className={`group relative flex min-h-[112px] items-start gap-3 overflow-hidden rounded-2xl border p-4 text-left transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 disabled:opacity-60 ${
                selected
                  ? 'border-primary/60 bg-primary/[0.045] shadow-sm'
                  : 'border-border/70 bg-surface hover:-translate-y-px hover:border-primary/30 hover:shadow-sm'
              }`}
            >
              <span
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-colors ${
                  selected
                    ? 'bg-primary/10 text-primary'
                    : 'bg-surface-raised/70 text-secondary group-hover:text-foreground'
                }`}
              >
                <Icon className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 pr-4 text-[13px] font-semibold leading-6 text-foreground">
                  {option.title}
                </span>
                <span className="mt-0.5 block text-[13px] leading-5 text-secondary">
                  {option.description}
                </span>
              </span>
              {selected ? (
                <span className="absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-white">
                  <CheckCircleIcon className="h-3.5 w-3.5" />
                </span>
              ) : null}
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
        <div className="rounded-xl border border-primary/20 bg-primary/[0.035] px-4 py-3 text-[13px] leading-5 text-foreground">
          {i18nService.t('browserModeIsolatedActive')}
        </div>
      ) : browserMode === BrowserMode.User ? (
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
            className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${
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
                <div className="mt-0.5 space-y-0.5 text-xs text-secondary">
                  <div>
                    {i18nService.t('browserDetectedPort')}: {status.activePort}
                  </div>
                  {portOwnerLabel ? <div>{portOwnerLabel}</div> : null}
                </div>
              ) : null}
            </div>
          </div>

          <div className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/70 bg-surface shadow-sm">
            <SetupStep
              number={1}
              complete={status?.chromeFound === true}
              title={i18nService.t('browserStepChromeTitle')}
              description={i18nService.t('browserStepChromeDescription')}
            />
            <SetupStep
              number={2}
              complete={status?.remoteDebuggingEnabled === true}
              title={i18nService.t('browserStepDebuggingTitle')}
              description={i18nService.t('browserStepDebuggingDescription')}
              action={
                <button
                  type="button"
                  onClick={() => void openRemoteDebugging()}
                  disabled={savingMode || busyAction !== null || status?.chromeFound !== true}
                  className={actionButtonClassName}
                >
                  <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
                  {i18nService.t('browserCopyDebuggingAddress')}
                </button>
              }
            />
            {setupUrlCopied ? (
              <div className="mx-5 mb-3 ml-[66px] rounded-lg border border-primary/20 bg-primary/[0.035] px-3 py-2 text-[13px] leading-5 text-foreground">
                {i18nService.t('browserDebuggingAddressCopied')}
                <code className="ml-1 select-all rounded bg-surface-raised px-1.5 py-0.5 text-xs">
                  chrome://inspect/#remote-debugging
                </code>
              </div>
            ) : null}
            <SetupStep
              number={3}
              complete={status?.endpointReachable === true}
              title={i18nService.t('browserStepRestartChromeTitle')}
              description={
                status?.issue === 'port-occupied-by-other-process'
                  ? i18nService.t('browserStepRestartChromeOccupiedDescription')
                  : status?.issue === 'chrome-restart-required'
                    ? i18nService.t('browserStepRestartChromeStaleDescription')
                    : i18nService.t('browserStepRestartChromeDescription')
              }
              action={
                <button
                  type="button"
                  onClick={() => void refresh()}
                  disabled={savingMode || loading || busyAction !== null}
                  className={actionButtonClassName}
                >
                  <ArrowPathIcon className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                  {i18nService.t('browserRefreshStatus')}
                </button>
              }
            />
            <SetupStep
              number={4}
              complete={connectionVerified}
              title={i18nService.t('browserStepAuthorizeTitle')}
              description={i18nService.t('browserStepAuthorizeDescription')}
              action={
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void testConnection()}
                    disabled={
                      savingMode ||
                      loading ||
                      busyAction !== null ||
                      status?.endpointReachable !== true
                    }
                    className={actionButtonClassName}
                  >
                    <ArrowPathIcon
                      className={`h-3.5 w-3.5 ${busyAction === 'test' ? 'animate-spin' : ''}`}
                    />
                    {i18nService.t('browserTestConnection')}
                  </button>
                  {connectionVerified ? (
                    <span className="inline-flex items-center gap-1.5 px-2 text-sm text-primary">
                      <CheckCircleIcon className="h-4 w-4" />
                      {i18nService.t('browserConnectionVerified')}
                    </span>
                  ) : null}
                  {busyAction === 'test' ? (
                    <p className="basis-full text-sm leading-6 text-foreground" role="status">
                      {i18nService.t('browserAuthorizationWaiting')}
                    </p>
                  ) : null}
                  {connectionTestError ? (
                    <p
                      className="basis-full rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm leading-6 text-danger"
                      role="alert"
                    >
                      {connectionTestError}
                    </p>
                  ) : null}
                </div>
              }
            />
          </div>
        </>
      ) : (
        <>
          <div>
            <h3 className="text-base font-semibold text-foreground">
              {i18nService.t('browserExtensionTitle')}
            </h3>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-secondary">
              {i18nService.t('browserExtensionDescription')}
            </p>
          </div>

          <div className="flex gap-3 rounded-xl border border-primary/20 bg-primary/[0.035] px-4 py-3 text-[13px] leading-5 text-foreground">
            <PuzzlePieceIcon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <span>{i18nService.t('browserExtensionScopeNotice')}</span>
          </div>

          <div className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/70 bg-surface shadow-sm">
            <SetupStep
              number={1}
              complete={status?.chromeFound === true}
              title={i18nService.t('browserExtensionStepChromeTitle')}
              description={i18nService.t('browserExtensionStepChromeDescription')}
            />
            <SetupStep
              number={2}
              complete={extensionFolderRevealed}
              title={i18nService.t('browserExtensionStepInstallTitle')}
              description={i18nService.t('browserExtensionStepInstallDescription')}
              action={
                <div className="flex min-w-0 flex-wrap justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => void openExtensionManagement()}
                    disabled={savingMode || busyAction !== null || status?.chromeFound !== true}
                    className={actionButtonClassName}
                  >
                    <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
                    {i18nService.t('browserExtensionOpenPage')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void revealExtension()}
                    disabled={savingMode || busyAction !== null}
                    className={actionButtonClassName}
                  >
                    <FolderOpenIcon className="h-3.5 w-3.5" />
                    {i18nService.t('browserExtensionRevealFolder')}
                  </button>
                  {setupUrlCopied ? (
                    <p className="min-w-0 basis-full break-words text-right text-sm leading-6 text-secondary">
                      {i18nService.t('browserExtensionPageCopied')}{' '}
                      <code className="select-all rounded bg-surface-raised px-1.5 py-0.5 text-xs">
                        chrome://extensions
                      </code>
                    </p>
                  ) : null}
                </div>
              }
            />
            <SetupStep
              number={3}
              complete={extensionPairingCopied}
              title={i18nService.t('browserExtensionStepPairTitle')}
              description={i18nService.t('browserExtensionStepPairDescription')}
              action={
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void copyExtensionPairing()}
                    disabled={savingMode || busyAction !== null}
                    className={actionButtonClassName}
                  >
                    <ClipboardDocumentIcon className="h-3.5 w-3.5" />
                    {i18nService.t('browserExtensionCopyPairing')}
                  </button>
                  {extensionPairingCopied ? (
                    <span className="inline-flex items-center gap-1.5 text-sm text-primary">
                      <CheckCircleIcon className="h-4 w-4" />
                      {i18nService.t('browserExtensionPairingCopied')}
                    </span>
                  ) : null}
                </div>
              }
            />
            <SetupStep
              number={4}
              complete={connectionVerified}
              title={i18nService.t('browserExtensionStepVerifyTitle')}
              description={i18nService.t('browserExtensionStepVerifyDescription')}
              action={
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void testExtensionConnection()}
                    disabled={savingMode || busyAction !== null}
                    className={actionButtonClassName}
                  >
                    <ArrowPathIcon
                      className={`h-3.5 w-3.5 ${busyAction === 'extension-test' ? 'animate-spin' : ''}`}
                    />
                    {i18nService.t('browserExtensionTestConnection')}
                  </button>
                  {connectionVerified ? (
                    <span className="inline-flex items-center gap-1.5 px-2 text-sm text-primary">
                      <CheckCircleIcon className="h-4 w-4" />
                      {i18nService.t('browserConnectionVerified')}
                    </span>
                  ) : null}
                  {connectionTestError ? (
                    <p
                      className="basis-full rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm leading-6 text-danger"
                      role="alert"
                    >
                      {connectionTestError}
                    </p>
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
