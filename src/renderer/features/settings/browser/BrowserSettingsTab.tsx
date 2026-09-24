import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  ClipboardDocumentIcon,
  ClockIcon,
  ComputerDesktopIcon,
  ExclamationTriangleIcon,
  FolderOpenIcon,
  MagnifyingGlassIcon,
  PuzzlePieceIcon,
  ShieldCheckIcon,
  UserCircleIcon,
  WindowIcon,
} from '@heroicons/react/24/outline';
import {
  type BrowserConnectionStatus,
  type BrowserConnectionTestResult,
  BrowserMode,
  type BrowserMode as BrowserModeValue,
  BrowserSearchEngine,
  type BrowserSearchEngine as BrowserSearchEngineValue,
  normalizeBrowserMode,
  normalizeBrowserSearchEngine,
} from '@shared/browser/browser';
import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import {
  browserConnectionVerificationReducer,
  initialBrowserConnectionVerificationState,
} from '@/features/settings/browser/browserConnectionVerification';
import BrowserDownloadsPage from '@/features/settings/browser/BrowserDownloadsPage';
import BrowserHistoryPage from '@/features/settings/browser/BrowserHistoryPage';
import { configService } from '@/services/config';
import { i18nService } from '@/services/i18n';

const actionButtonClassName =
  'inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-border/70 bg-surface px-3 text-[11px] font-semibold text-secondary shadow-sm transition-all duration-200 hover:-translate-y-px hover:border-primary/35 hover:bg-primary/[0.06] hover:text-primary hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25 active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0 disabled:hover:border-border/70 disabled:hover:bg-surface disabled:hover:text-secondary disabled:hover:shadow-sm';

// The extension reconnects with exponential backoff capped at 30 seconds. Keep
// both automatic and manual probes alive through that longest normal reconnect.
const EXTENSION_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 16_000] as const;
const waitForExtensionRetry = (delayMs: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, delayMs));

const isTransientExtensionTestFailure = (result: BrowserConnectionTestResult): boolean =>
  !result.success &&
  (result.errorCode === 'gateway-unavailable' || result.errorCode === 'extension-not-connected');

export const extensionConnectionErrorMessage = (result: BrowserConnectionTestResult): string => {
  const key =
    result.errorCode === 'gateway-unavailable'
      ? 'browserExtensionRelayUnavailable'
      : result.errorCode === 'extension-not-connected'
        ? 'browserExtensionNotConnected'
        : result.errorCode === 'permission-timeout'
          ? 'browserPermissionTimeout'
          : 'browserConnectionFailed';
  return i18nService.t(key);
};

type StepProps = {
  number: number;
  complete: boolean;
  title: string;
  description: React.ReactNode;
  action?: React.ReactNode;
  feedback?: React.ReactNode;
};

type BrowserModeApplyState = {
  phase: 'applying' | 'restarting' | 'complete';
};

const SetupStep: React.FC<StepProps> = ({
  number,
  complete,
  title,
  description,
  action,
  feedback,
}) => (
  <div className="group/step relative flex items-start gap-3.5 overflow-hidden rounded-xl border border-border/65 bg-surface/90 px-4 py-3.5 shadow-sm transition-all duration-200 hover:border-primary/20 hover:shadow-md">
    <div
      className="pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-primary/0 transition-colors group-hover/step:bg-primary/50"
      aria-hidden="true"
    />
    <div className="relative z-10 pt-0.5" aria-hidden="true">
      {complete ? (
        <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary text-white shadow-sm shadow-primary/20 ring-4 ring-primary/10">
          <CheckCircleIcon className="h-4 w-4" />
        </span>
      ) : (
        <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-border/80 bg-surface-raised text-xs font-bold text-secondary shadow-inner">
          {number}
        </span>
      )}
    </div>
    <div className="relative z-10 min-w-0 flex-1">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <h4 className="text-[13px] font-bold leading-5 text-foreground">{title}</h4>
          <p className="mt-0.5 whitespace-pre-line text-left text-[12px] leading-[18px] text-secondary">
            {description}
          </p>
        </div>
        {action ? (
          <div className="min-w-0 shrink-0 sm:max-w-[58%] sm:self-center">{action}</div>
        ) : null}
      </div>
      {feedback ? <div className="mt-2">{feedback}</div> : null}
    </div>
  </div>
);

const EXTENSIONS_BUTTON_PLACEHOLDER = '{extensionsButton}';

const ExtensionInstallDescription: React.FC = () => {
  const description = i18nService.t('browserExtensionStepInstallDescription');
  const placeholderIndex = description.indexOf(EXTENSIONS_BUTTON_PLACEHOLDER);
  if (placeholderIndex < 0) return description;

  const before = description.slice(0, placeholderIndex);
  const after = description.slice(placeholderIndex + EXTENSIONS_BUTTON_PLACEHOLDER.length);
  const label = i18nService.t('browserExtensionToolbarExtensions');
  return (
    <>
      {before}
      <span
        role="img"
        aria-label={label}
        title={label}
        className="mx-0.5 inline-flex h-5 w-5 items-center justify-center rounded-md border border-border bg-surface align-text-bottom text-secondary"
      >
        <PuzzlePieceIcon aria-hidden="true" className="h-3.5 w-3.5" />
      </span>
      {after}
    </>
  );
};

const ExtensionPairingDescription: React.FC = () => {
  const description = i18nService.t('browserExtensionStepPairDescription');
  const placeholderIndex = description.indexOf(EXTENSIONS_BUTTON_PLACEHOLDER);
  if (placeholderIndex < 0) return description;

  const before = description.slice(0, placeholderIndex);
  const after = description.slice(placeholderIndex + EXTENSIONS_BUTTON_PLACEHOLDER.length);
  return (
    <>
      {before}
      <span className="inline-flex items-center gap-0.5 whitespace-nowrap align-middle">
        <PuzzlePieceIcon aria-hidden="true" className="h-3.5 w-3.5" />
        {i18nService.t('browserExtensionToolbarExtensions')}
      </span>
      {after}
    </>
  );
};

const BrowserSettingsTab: React.FC<{ initialPage?: 'history' | 'downloads' }> = ({
  initialPage,
}) => {
  const [page, setPage] = useState<'main' | 'history' | 'downloads'>(initialPage ?? 'main');
  const [browserMode, setBrowserMode] = useState<BrowserModeValue>(() =>
    normalizeBrowserMode(configService.getConfig().browserMode),
  );
  const [searchEngine, setSearchEngine] = useState<BrowserSearchEngineValue>(() =>
    normalizeBrowserSearchEngine(configService.getConfig().browserSearchEngine),
  );
  const [downloadDirectory, setDownloadDirectory] = useState(
    () => configService.getConfig().browserDownloadDirectory ?? '',
  );
  const [askDownloadLocation, setAskDownloadLocation] = useState(
    () => configService.getConfig().browserAskDownloadLocation ?? true,
  );
  const [status, setStatus] = useState<BrowserConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<
    'open' | 'test' | 'extension-page' | 'extension-folder' | 'pair' | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [remoteDebuggingUrlCopied, setRemoteDebuggingUrlCopied] = useState(false);
  const [extensionPageUrlCopied, setExtensionPageUrlCopied] = useState(false);
  const [connectionVerification, dispatchConnectionVerification] = useReducer(
    browserConnectionVerificationReducer,
    initialBrowserConnectionVerificationState,
  );
  const [extensionPairingCopied, setExtensionPairingCopied] = useState(false);
  const [userConnectionTestError, setUserConnectionTestError] = useState<string | null>(null);
  const [extensionConnectionTestError, setExtensionConnectionTestError] = useState<string | null>(
    null,
  );
  const [extensionTestKind, setExtensionTestKind] = useState<'automatic' | 'manual' | null>(null);
  const [extensionProbeInFlight, setExtensionProbeInFlight] = useState(false);
  const [savingMode, setSavingMode] = useState(false);
  const [modeApplyState, setModeApplyState] = useState<BrowserModeApplyState | null>(null);
  const [modeSwitchWarning, setModeSwitchWarning] = useState<string | null>(null);
  const refreshRequestIdRef = useRef(0);
  const extensionTestRequestIdRef = useRef(0);
  const statusRef = useRef<BrowserConnectionStatus | null>(null);
  const savingModeRef = useRef(false);
  const modeApplyCompletionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const subscribe = window.electron.openclaw?.engine.onProgress;
    if (typeof subscribe !== 'function') return;
    return subscribe(engineStatus => {
      if (!savingModeRef.current) return;
      if (engineStatus.phase === 'starting' || engineStatus.phase === 'ready') {
        setModeApplyState({
          phase: 'restarting',
        });
      }
    });
  }, []);

  useEffect(
    () => () => {
      if (modeApplyCompletionTimerRef.current) {
        clearTimeout(modeApplyCompletionTimerRef.current);
      }
    },
    [],
  );

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
        dispatchConnectionVerification({ type: 'set-user', verified: false });
      }
    } catch (refreshError) {
      if (requestId !== refreshRequestIdRef.current) return;
      statusRef.current = null;
      setStatus(null);
      dispatchConnectionVerification({ type: 'set-user', verified: false });
      setUserConnectionTestError(null);
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
    setRemoteDebuggingUrlCopied(false);
    dispatchConnectionVerification({ type: 'set-user', verified: false });
    setUserConnectionTestError(null);
    if (browserMode !== BrowserMode.Extension) {
      dispatchConnectionVerification({ type: 'set-extension', verified: false });
      setExtensionConnectionTestError(null);
      setExtensionPairingCopied(false);
    }
    void refresh();
    return () => {
      refreshRequestIdRef.current += 1;
    };
  }, [browserMode, refresh]);

  const selectBrowserMode = async (mode: BrowserModeValue) => {
    if (mode === browserMode || savingMode || busyAction !== null) return;
    const previousMode = browserMode;
    if (modeApplyCompletionTimerRef.current) {
      clearTimeout(modeApplyCompletionTimerRef.current);
      modeApplyCompletionTimerRef.current = null;
    }
    setSavingMode(true);
    setError(null);
    setModeSwitchWarning(null);
    try {
      const availability = await window.electron.browser.canSetMode();
      if (!availability.success) {
        throw new Error(i18nService.t('browserModeChangeFailed'));
      }
      if (!availability.canSwitch) {
        setModeSwitchWarning(i18nService.t('browserModeActiveSessionWarning'));
        return;
      }

      savingModeRef.current = true;
      setModeApplyState({ phase: 'applying' });
      // Render the selected setup flow as soon as Main confirms there is no
      // active session, while durable config and Gateway apply in background.
      setBrowserMode(mode);
      const result = await window.electron.browser.setMode(mode);
      if (result.errorCode === 'active-session') {
        setBrowserMode(result.mode ?? previousMode);
        setModeApplyState(null);
        setModeSwitchWarning(i18nService.t('browserModeActiveSessionWarning'));
        return;
      }
      if (!result.success || !result.mode) {
        throw new Error(i18nService.t('browserModeChangeFailed'));
      }
      setBrowserMode(result.mode);
      await configService.reloadFromStore();
      setModeApplyState({ phase: 'complete' });
      modeApplyCompletionTimerRef.current = setTimeout(() => {
        modeApplyCompletionTimerRef.current = null;
        setModeApplyState(null);
      }, 2_500);
    } catch (modeError) {
      try {
        await configService.reloadFromStore();
        setBrowserMode(normalizeBrowserMode(configService.getConfig().browserMode));
      } catch {
        setBrowserMode(previousMode);
      }
      setModeApplyState(null);
      setError(
        modeError instanceof Error ? modeError.message : i18nService.t('browserModeChangeFailed'),
      );
    } finally {
      savingModeRef.current = false;
      setSavingMode(false);
    }
  };

  const selectSearchEngine = async (engine: BrowserSearchEngineValue) => {
    if (engine === searchEngine) return;
    const previous = searchEngine;
    setSearchEngine(engine);
    try {
      await configService.updateConfig({ browserSearchEngine: engine });
    } catch {
      setSearchEngine(previous);
      setError(i18nService.t('browserSearchEngineSaveFailed'));
    }
  };

  const chooseDownloadDirectory = async () => {
    setError(null);
    try {
      const result = await window.electron.dialog.selectDirectory();
      if (!result.success) {
        throw new Error(i18nService.t('browserDownloadSettingsSaveFailed'));
      }
      if (!result.path) return;
      const previous = downloadDirectory;
      setDownloadDirectory(result.path);
      try {
        await configService.updateConfig({ browserDownloadDirectory: result.path });
      } catch {
        setDownloadDirectory(previous);
        throw new Error(i18nService.t('browserDownloadSettingsSaveFailed'));
      }
    } catch (directoryError) {
      setError(
        directoryError instanceof Error
          ? directoryError.message
          : i18nService.t('browserDownloadSettingsSaveFailed'),
      );
    }
  };

  const toggleAskDownloadLocation = async () => {
    const previous = askDownloadLocation;
    const next = !previous;
    setAskDownloadLocation(next);
    setError(null);
    try {
      await configService.updateConfig({ browserAskDownloadLocation: next });
    } catch {
      setAskDownloadLocation(previous);
      setError(i18nService.t('browserDownloadSettingsSaveFailed'));
    }
  };

  const openRemoteDebugging = async () => {
    setBusyAction('open');
    setError(null);
    setUserConnectionTestError(null);
    try {
      const result = await window.electron.browser.openRemoteDebugging();
      if (!result.success) throw new Error(i18nService.t('browserOpenSetupFailed'));
      setRemoteDebuggingUrlCopied(true);
    } catch {
      setError(i18nService.t('browserOpenSetupFailed'));
    } finally {
      setBusyAction(null);
    }
  };

  const testConnection = async () => {
    setBusyAction('test');
    setError(null);
    setUserConnectionTestError(null);
    dispatchConnectionVerification({ type: 'set-user', verified: false });
    try {
      const result = await window.electron.browser.testConnection();
      if (result.success) {
        dispatchConnectionVerification({ type: 'set-user', verified: true });
      } else if (result.errorCode === 'permission-timeout') {
        setUserConnectionTestError(i18nService.t('browserPermissionTimeout'));
      } else if (result.errorCode === 'gateway-unavailable') {
        setUserConnectionTestError(i18nService.t('browserGatewayUnavailable'));
      } else if (result.errorCode === 'browser-not-running') {
        setUserConnectionTestError(i18nService.t('browserStatusNotReady'));
      } else {
        setUserConnectionTestError(i18nService.t('browserConnectionFailed'));
      }
    } catch {
      setUserConnectionTestError(i18nService.t('browserConnectionFailed'));
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
      setExtensionPageUrlCopied(true);
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

  const testExtensionConnection = useCallback(async (kind: 'automatic' | 'manual' = 'manual') => {
    const requestId = ++extensionTestRequestIdRef.current;
    setExtensionTestKind(kind);
    setError(null);
    setExtensionConnectionTestError(null);
    dispatchConnectionVerification({ type: 'set-extension', verified: false });
    try {
      // A manual test takes over from the automatic probe, but it must keep
      // waiting through Chrome's normal extension reconnect backoff instead
      // of turning that handoff into an immediate false failure.
      const retryDelays = EXTENSION_RETRY_DELAYS_MS;
      for (let attempt = 0; ; attempt += 1) {
        if (requestId !== extensionTestRequestIdRef.current) return;
        setExtensionProbeInFlight(true);
        let result: BrowserConnectionTestResult;
        try {
          result = await window.electron.browser.testExtensionConnection();
        } finally {
          if (requestId === extensionTestRequestIdRef.current) {
            setExtensionProbeInFlight(false);
          }
        }
        if (requestId !== extensionTestRequestIdRef.current) return;
        if (result.success) {
          dispatchConnectionVerification({ type: 'set-extension', verified: true });
          return;
        }
        const retryDelay = retryDelays[attempt];
        if (retryDelay === undefined || !isTransientExtensionTestFailure(result)) {
          setExtensionConnectionTestError(extensionConnectionErrorMessage(result));
          return;
        }
        await waitForExtensionRetry(retryDelay);
      }
    } catch {
      if (requestId !== extensionTestRequestIdRef.current) return;
      setExtensionConnectionTestError(i18nService.t('browserExtensionRelayUnavailable'));
    } finally {
      if (requestId === extensionTestRequestIdRef.current) {
        setExtensionTestKind(null);
      }
    }
  }, []);

  useEffect(() => {
    if (browserMode !== BrowserMode.Extension) {
      extensionTestRequestIdRef.current += 1;
      setExtensionTestKind(null);
      setExtensionProbeInFlight(false);
      return;
    }
    void testExtensionConnection('automatic');
    return () => {
      extensionTestRequestIdRef.current += 1;
    };
  }, [browserMode, testExtensionConnection]);

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

  if (page === 'history') return <BrowserHistoryPage onBack={() => setPage('main')} />;
  if (page === 'downloads') return <BrowserDownloadsPage onBack={() => setPage('main')} />;

  return (
    <div className="mx-auto w-full max-w-5xl space-y-5 pb-8">
      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          {error}
        </div>
      ) : null}

      <section className="overflow-hidden rounded-xl border border-border bg-surface">
        <div className="border-b border-border bg-surface-raised px-4 py-2.5">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-primary">
              <PuzzlePieceIcon className="h-4 w-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-foreground">
                {i18nService.t('browserExtensionSectionTitle')}
              </h3>
              <p className="mt-0.5 max-w-3xl text-[11px] leading-4 text-secondary">
                {i18nService.t('browserExtensionSectionDescription')}
              </p>
            </div>
          </div>
        </div>
        <div className="px-4">
          <div className="flex flex-col gap-3 py-3.5 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 flex-1 sm:min-w-max">
              <div className="text-[13px] font-semibold text-foreground">
                {i18nService.t('browserExtensionStepInstallTitle')}
              </div>
              <p className="mt-0.5 overflow-x-auto whitespace-pre text-xs leading-5 text-secondary">
                <ExtensionInstallDescription />
              </p>
            </div>
            <div className="flex min-w-0 shrink-0 flex-wrap justify-end gap-2">
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
            </div>
          </div>
          {extensionPageUrlCopied ? (
            <p className="border-t border-border/60 py-2.5 text-right text-sm leading-6 text-secondary">
              {i18nService.t('browserExtensionPageCopied')}{' '}
              <code className="select-all rounded bg-surface-raised px-1.5 py-0.5 text-xs">
                chrome://extensions
              </code>
            </p>
          ) : null}
        </div>
      </section>

      <section className="overflow-hidden rounded-xl border border-border bg-surface">
        <div className="border-b border-border bg-surface-raised px-4 py-2.5">
          <div className="flex min-h-8 items-start gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-primary">
              <ShieldCheckIcon className="h-4 w-4" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold text-foreground">
                {i18nService.t('browserModeTitle')}
              </h3>
              <p className="mt-0.5 max-w-3xl text-[11px] leading-4 text-secondary">
                {i18nService.t('browserModeDescription')}
              </p>
            </div>
            <div
              role={modeApplyState ? 'status' : undefined}
              aria-live={modeApplyState ? 'polite' : undefined}
              className={`min-w-0 shrink-0 items-center justify-end gap-1.5 rounded-full bg-surface-raised/70 px-2.5 py-1 text-right text-xs text-secondary ${
                modeApplyState ? 'flex' : 'hidden'
              }`}
            >
              {modeApplyState ? (
                <>
                  {modeApplyState.phase === 'complete' ? (
                    <CheckCircleIcon className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                  ) : (
                    <span
                      className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-primary/25 border-t-primary"
                      aria-hidden="true"
                    />
                  )}
                  <span className="min-w-0 truncate">
                    {modeApplyState.phase === 'complete'
                      ? i18nService.t('browserModeChangeComplete')
                      : modeApplyState.phase === 'restarting'
                        ? i18nService.t('browserModeGatewayRestarting')
                        : i18nService.t('browserModeApplying')}
                  </span>
                </>
              ) : null}
            </div>
          </div>
        </div>

        <div
          role="radiogroup"
          aria-label={i18nService.t('browserModeTitle')}
          aria-busy={savingMode}
          className="grid gap-4 bg-surface p-4 lg:grid-cols-[3fr_1fr]"
        >
          {[
            {
              label: i18nService.t('browserModeChromeGroupTitle'),
              icon: ComputerDesktopIcon,
              className: 'sm:grid-cols-3',
              options: [
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
              ],
            },
            {
              label: i18nService.t('browserModeEmbeddedGroupTitle'),
              icon: WindowIcon,
              className: 'grid-cols-1',
              options: [
                {
                  mode: BrowserMode.Embedded,
                  icon: WindowIcon,
                  title: i18nService.t('browserModeEmbeddedTitle'),
                  description: i18nService.t('browserModeEmbeddedDescription'),
                },
              ],
            },
          ].map(group => {
            const GroupIcon = group.icon;
            return (
              <div
                key={group.label}
                className="flex h-full flex-col rounded-2xl border border-border/60 bg-surface/80 p-3 shadow-sm ring-1 ring-inset ring-white/[0.03]"
              >
                <div className="mb-3 flex min-h-9 items-center justify-center gap-2 rounded-lg border border-border/50 bg-surface-raised/80 px-3 py-1.5 text-center text-[13px] font-bold text-foreground">
                  <span className="flex h-6 w-6 items-center justify-center rounded-md bg-surface text-primary shadow-sm">
                    <GroupIcon className="h-4 w-4" aria-hidden="true" />
                  </span>
                  {group.label}
                </div>
                <div className={`grid flex-1 gap-2 ${group.className}`}>
                  {group.options.map(option => {
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
                        className={`group relative flex h-full min-h-[96px] items-start gap-3 overflow-hidden rounded-xl border p-3.5 text-left transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25 disabled:opacity-60 ${
                          selected
                            ? 'border-primary/45 bg-gradient-to-br from-primary/[0.12] via-primary/[0.055] to-surface text-primary shadow-md shadow-primary/5 ring-1 ring-inset ring-primary/10'
                            : 'border-border/60 bg-surface text-secondary shadow-sm hover:-translate-y-0.5 hover:border-primary/25 hover:bg-primary/[0.025] hover:shadow-md'
                        }`}
                      >
                        {selected ? (
                          <CheckCircleIcon
                            className="absolute right-2.5 top-2.5 h-4 w-4 text-primary"
                            aria-hidden="true"
                          />
                        ) : null}
                        <span
                          className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition-colors ${
                            selected
                              ? 'bg-primary text-white shadow-sm shadow-primary/20'
                              : 'bg-surface-raised text-secondary'
                          }`}
                        >
                          <Icon className="h-4 w-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span
                            className={`block pr-3 text-[13px] font-bold leading-5 ${
                              selected ? 'text-primary' : 'text-foreground'
                            }`}
                          >
                            {option.title}
                          </span>
                          <span className="mt-0.5 block text-[11px] leading-4 text-secondary">
                            {option.description}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {modeSwitchWarning ? (
          <div
            role="alert"
            className="mx-4 mb-4 flex items-start gap-2.5 rounded-2xl border border-warning/30 bg-warning/[0.07] px-4 py-3.5 text-sm leading-5 text-foreground shadow-sm"
          >
            <ExclamationTriangleIcon className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
            <span className="min-w-0 flex-1">{modeSwitchWarning}</span>
          </div>
        ) : null}

        <div className="space-y-3 border-t border-border/50 bg-gradient-to-b from-surface to-surface-raised/25 p-4">
          {browserMode === BrowserMode.Isolated ? (
            <div className="flex items-start gap-3.5 rounded-2xl border border-primary/20 bg-gradient-to-r from-primary/[0.09] to-primary/[0.025] p-4 text-[13px] leading-5 text-foreground shadow-sm">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <ShieldCheckIcon className="h-5 w-5" aria-hidden="true" />
              </span>
              <div>
                <p className="font-semibold">{i18nService.t('browserModeIsolatedActive')}</p>
                <p className="mt-1 text-xs text-secondary">
                  {i18nService.t('browserModeIsolatedNetworkNotice')}
                </p>
              </div>
            </div>
          ) : browserMode === BrowserMode.User ? (
            <>
              <div className="flex items-start gap-3 rounded-2xl border border-primary/15 bg-primary/[0.045] px-4 py-3 text-xs leading-5 text-secondary">
                <UserCircleIcon
                  className="mt-0.5 h-4 w-4 shrink-0 text-primary"
                  aria-hidden="true"
                />
                <p>{i18nService.t('browserUserChromeDescription')}</p>
              </div>
              <div
                role="status"
                aria-live="polite"
                className={`flex items-center gap-3 rounded-2xl border px-4 py-3.5 shadow-sm ${
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

              <div className="grid gap-3">
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
                {remoteDebuggingUrlCopied ? (
                  <div className="rounded-xl border border-primary/20 bg-primary/[0.05] px-4 py-3 text-[13px] leading-5 text-foreground shadow-sm">
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
                  complete={connectionVerification.user}
                  title={i18nService.t('browserStepAuthorizeTitle')}
                  description={i18nService.t('browserStepAuthorizeDescription')}
                  action={
                    <div className="flex flex-wrap items-center justify-end gap-2">
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
                      {connectionVerification.user ? (
                        <span className="inline-flex items-center gap-1.5 px-2 text-sm text-primary">
                          <CheckCircleIcon className="h-4 w-4" />
                          {i18nService.t('browserConnectionVerified')}
                        </span>
                      ) : null}
                    </div>
                  }
                  feedback={
                    busyAction === 'test' ? (
                      <p className="text-xs leading-5 text-secondary" role="status">
                        {i18nService.t('browserAuthorizationWaiting')}
                      </p>
                    ) : userConnectionTestError ? (
                      <p className="text-xs leading-5 text-destructive" role="alert">
                        {userConnectionTestError}
                      </p>
                    ) : null
                  }
                />
              </div>
            </>
          ) : browserMode === BrowserMode.Extension ? (
            <>
              <div className="flex items-start gap-3 rounded-2xl border border-primary/15 bg-primary/[0.045] px-4 py-3 text-xs leading-5 text-secondary">
                <PuzzlePieceIcon
                  className="mt-0.5 h-4 w-4 shrink-0 text-primary"
                  aria-hidden="true"
                />
                <p>{i18nService.t('browserModeExtensionActive')}</p>
              </div>
              <div className="grid gap-3">
                <SetupStep
                  number={1}
                  complete={extensionPairingCopied}
                  title={i18nService.t('browserExtensionStepPairTitle')}
                  description={<ExtensionPairingDescription />}
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
                  number={2}
                  complete={connectionVerification.extension}
                  title={i18nService.t('browserExtensionStepVerifyTitle')}
                  description={i18nService.t('browserExtensionStepVerifyDescription')}
                  action={
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => void testExtensionConnection()}
                        disabled={
                          savingMode ||
                          busyAction !== null ||
                          extensionTestKind === 'manual' ||
                          extensionProbeInFlight
                        }
                        className={actionButtonClassName}
                      >
                        <ArrowPathIcon
                          className={`h-3.5 w-3.5 ${extensionTestKind ? 'animate-spin' : ''}`}
                        />
                        {i18nService.t('browserExtensionTestConnection')}
                      </button>
                      {connectionVerification.extension ? (
                        <span className="inline-flex items-center gap-1.5 px-2 text-sm text-primary">
                          <CheckCircleIcon className="h-4 w-4" />
                          {i18nService.t('browserConnectionVerified')}
                        </span>
                      ) : null}
                      {extensionConnectionTestError ? (
                        <span
                          className="inline-flex items-center gap-1.5 px-2 text-sm text-destructive"
                          role="alert"
                        >
                          <ExclamationTriangleIcon className="h-4 w-4" />
                          {extensionConnectionTestError}
                        </span>
                      ) : null}
                    </div>
                  }
                />
              </div>
            </>
          ) : (
            <div className="flex items-start gap-3.5 rounded-2xl border border-primary/20 bg-gradient-to-r from-primary/[0.09] to-primary/[0.025] p-4 text-[13px] leading-5 text-foreground shadow-sm">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <WindowIcon className="h-5 w-5" aria-hidden="true" />
              </span>
              <p className="pt-1.5 font-semibold">{i18nService.t('browserModeEmbeddedActive')}</p>
            </div>
          )}
        </div>
      </section>

      <section className="overflow-hidden rounded-xl border border-border bg-surface">
        <div className="border-b border-border bg-surface-raised px-4 py-2.5">
          <div className="flex items-start gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-primary">
              <WindowIcon className="h-4 w-4" aria-hidden="true" />
            </span>
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                {i18nService.t('browserEmbeddedSettingsTitle')}
              </h3>
              <p className="mt-0.5 text-[11px] leading-4 text-secondary">
                {i18nService.t('browserEmbeddedSettingsDescription')}
              </p>
            </div>
          </div>
        </div>

        <div className="grid items-start gap-4 bg-surface-raised/20 p-4 lg:grid-cols-2">
          <div className="overflow-hidden rounded-2xl border border-border/60 bg-surface shadow-sm">
            <div className="flex items-start gap-3 border-b border-border bg-surface-raised px-4 py-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <MagnifyingGlassIcon className="h-4 w-4" aria-hidden="true" />
              </span>
              <div>
                <h4 className="text-sm font-bold text-foreground">
                  {i18nService.t('browserGeneralSettingsTitle')}
                </h4>
                <p className="mt-0.5 text-xs leading-5 text-secondary">
                  {i18nService.t('browserGeneralSettingsDescription')}
                </p>
              </div>
            </div>
            <div className="divide-y divide-border/50">
              <div className="flex min-h-[76px] items-center justify-between gap-4 px-4 py-3.5">
                <div className="min-w-0">
                  <label
                    htmlFor="browser-search-engine"
                    className="text-sm font-semibold text-foreground"
                  >
                    {i18nService.t('browserSearchEngineTitle')}
                  </label>
                  <p className="mt-1 text-xs leading-4 text-secondary">
                    {i18nService.t('browserSearchEngineDescription')}
                  </p>
                </div>
                <select
                  id="browser-search-engine"
                  value={searchEngine}
                  onChange={event =>
                    void selectSearchEngine(normalizeBrowserSearchEngine(event.target.value))
                  }
                  className="h-9 min-w-32 rounded-lg border border-border bg-surface px-3 text-sm font-medium text-foreground shadow-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15"
                >
                  <option value={BrowserSearchEngine.Baidu}>
                    {i18nService.t('browserSearchEngineBaidu')}
                  </option>
                  <option value={BrowserSearchEngine.Google}>
                    {i18nService.t('browserSearchEngineGoogle')}
                  </option>
                </select>
              </div>
              <div className="flex min-h-[76px] items-center justify-between gap-4 px-4 py-3.5">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-surface-raised text-secondary">
                    <ClockIcon className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-foreground">
                      {i18nService.t('browserHistoryTitle')}
                    </div>
                    <p className="mt-1 text-xs leading-4 text-secondary">
                      {i18nService.t('browserHistoryDescription')}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  className={actionButtonClassName}
                  onClick={() => setPage('history')}
                >
                  {i18nService.t('browserManage')}
                </button>
              </div>
            </div>
          </div>

          <div className="overflow-hidden rounded-2xl border border-border/60 bg-surface shadow-sm">
            <div className="flex items-start gap-3 border-b border-border bg-surface-raised px-4 py-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <ArrowDownTrayIcon className="h-4 w-4" aria-hidden="true" />
              </span>
              <div>
                <h4 className="text-sm font-bold text-foreground">
                  {i18nService.t('browserDownloadSettingsTitle')}
                </h4>
                <p className="mt-0.5 text-xs leading-5 text-secondary">
                  {i18nService.t('browserDownloadSettingsDescription')}
                </p>
              </div>
            </div>
            <div className="divide-y divide-border/50">
              <div className="flex min-h-[76px] items-center justify-between gap-4 px-4 py-3.5">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-surface-raised text-secondary">
                    <FolderOpenIcon className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-foreground">
                      {i18nService.t('browserDownloadLocationTitle')}
                    </div>
                    <p
                      className="mt-1 max-w-64 truncate text-xs text-secondary"
                      title={downloadDirectory || i18nService.t('browserDownloadSystemFolder')}
                    >
                      {downloadDirectory || i18nService.t('browserDownloadSystemFolder')}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  className={actionButtonClassName}
                  onClick={() => void chooseDownloadDirectory()}
                >
                  {i18nService.t('browserDownloadChangeLocation')}
                </button>
              </div>
              <div className="flex min-h-[76px] items-center justify-between gap-4 px-4 py-3.5">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-foreground">
                    {i18nService.t('browserAskDownloadLocationTitle')}
                  </div>
                  <p className="mt-1 text-xs leading-4 text-secondary">
                    {i18nService.t('browserAskDownloadLocationDescription')}
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={askDownloadLocation}
                  aria-label={i18nService.t('browserAskDownloadLocationTitle')}
                  onClick={() => void toggleAskDownloadLocation()}
                  className={`flex h-7 w-12 shrink-0 items-center rounded-full p-0.5 shadow-inner transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                    askDownloadLocation ? 'bg-primary' : 'bg-border'
                  }`}
                >
                  <span
                    className={`h-6 w-6 rounded-full bg-white shadow-md transition-transform ${
                      askDownloadLocation ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>
              <div className="flex min-h-[76px] items-center justify-between gap-4 px-4 py-3.5">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-foreground">
                    {i18nService.t('browserDownloadsTitle')}
                  </div>
                  <p className="mt-1 text-xs leading-4 text-secondary">
                    {i18nService.t('browserDownloadsDescription')}
                  </p>
                </div>
                <button
                  type="button"
                  className={actionButtonClassName}
                  onClick={() => setPage('downloads')}
                >
                  {i18nService.t('browserManage')}
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};

export default BrowserSettingsTab;
