import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ClipboardDocumentIcon,
  ExclamationTriangleIcon,
  FolderOpenIcon,
  GlobeAltIcon,
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
import {
  BrowserLinkTarget,
  type BrowserLinkTarget as BrowserLinkTargetValue,
  normalizeBrowserLinkTarget,
} from '@shared/browser/browserLinkOpening';
import { ProxyMode, type ProxySettings } from '@shared/network/proxy';
import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import {
  browserConnectionVerificationReducer,
  initialBrowserConnectionVerificationState,
} from '@/features/settings/browser/browserConnectionVerification';
import BrowserDownloadsPage from '@/features/settings/browser/BrowserDownloadsPage';
import BrowserHistoryPage from '@/features/settings/browser/BrowserHistoryPage';
import { CustomProxyFields } from '@/features/settings/preferences/CustomProxyFields';
import { configService } from '@/services/config';
import { i18nService } from '@/services/i18n';

const actionButtonClassName =
  'inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-border/70 bg-surface px-3 text-[11px] font-semibold text-secondary shadow-sm transition-all duration-200 hover:-translate-y-px hover:border-primary/35 hover:bg-primary/[0.06] hover:text-primary hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25 active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0 disabled:hover:border-border/70 disabled:hover:bg-surface disabled:hover:text-secondary disabled:hover:shadow-sm';

const BrowserSelect: React.FC<React.SelectHTMLAttributes<HTMLSelectElement>> = ({
  className = '',
  ...props
}) => (
  <div className={`relative w-fit min-w-0 max-w-[min(20rem,50vw)] shrink-0 ${className}`}>
    <select
      {...props}
      className="h-9 max-w-full cursor-pointer appearance-none rounded-lg border border-border bg-surface py-1.5 pl-3 pr-9 text-sm font-medium text-foreground shadow-sm outline-none transition hover:border-primary/40 hover:bg-surface-raised focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:cursor-not-allowed disabled:opacity-60"
    />
    <ChevronDownIcon
      aria-hidden="true"
      className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-secondary"
    />
  </div>
);

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
  <div className="flex items-start gap-3 py-3">
    <span
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-raised text-xs text-secondary"
      aria-hidden="true"
    >
      {complete ? <CheckCircleIcon className="h-4 w-4 text-primary" /> : number}
    </span>
    <div className="min-w-0 flex-1">
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

interface BrowserSettingsTabProps {
  initialPage?: 'history' | 'downloads';
  browserProxy: ProxySettings;
  onBrowserProxyChange: (settings: ProxySettings) => void;
  isSaving: boolean;
}

const BrowserSettingsTab: React.FC<BrowserSettingsTabProps> = ({
  initialPage,
  browserProxy,
  onBrowserProxyChange,
  isSaving,
}) => {
  const [page, setPage] = useState<'main' | 'history' | 'downloads'>(initialPage ?? 'main');
  const [browserMode, setBrowserMode] = useState<BrowserModeValue>(() =>
    normalizeBrowserMode(configService.getConfig().browserMode),
  );
  const lastChromeModeRef = useRef<BrowserModeValue>(
    browserMode === BrowserMode.Embedded ? BrowserMode.Isolated : browserMode,
  );
  const [searchEngine, setSearchEngine] = useState<BrowserSearchEngineValue>(() =>
    normalizeBrowserSearchEngine(configService.getConfig().browserSearchEngine),
  );
  const [linkTargets, setLinkTargets] = useState(() => ({
    browserWebLinkTarget: normalizeBrowserLinkTarget(
      configService.getConfig().browserWebLinkTarget,
      BrowserLinkTarget.Chrome,
    ),
    browserHtmlLinkTarget: normalizeBrowserLinkTarget(
      configService.getConfig().browserHtmlLinkTarget,
      BrowserLinkTarget.Embedded,
    ),
  }));
  const [savingLinkTarget, setSavingLinkTarget] = useState(false);
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
      if (result.mode !== BrowserMode.Embedded) {
        lastChromeModeRef.current = result.mode;
      }
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

  const selectLinkTarget = async (
    key: keyof typeof linkTargets,
    target: BrowserLinkTargetValue,
  ) => {
    const previous = linkTargets[key];
    if (previous === target || savingLinkTarget) return;
    setSavingLinkTarget(true);
    setError(null);
    setLinkTargets(current => ({ ...current, [key]: target }));
    try {
      await configService.updateConfig({ [key]: target });
    } catch {
      setLinkTargets(current => ({ ...current, [key]: previous }));
      setError(i18nService.t('browserLinkSettingsSaveFailed'));
    } finally {
      setSavingLinkTarget(false);
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

  const chromeMode = browserMode === BrowserMode.Embedded ? lastChromeModeRef.current : browserMode;

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
    <div className="w-full min-w-0 space-y-4 pb-8">
      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          {error}
        </div>
      ) : null}

      <section className="rounded-xl border border-border bg-surface px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <PuzzlePieceIcon className="h-4 w-4 text-secondary" aria-hidden="true" />
            {i18nService.t('browserExtensionSectionTitle')}
          </h3>
          <div className="flex flex-wrap gap-2">
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
        <details className="group/install mt-2 text-xs text-secondary">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded py-1 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25 [&::-webkit-details-marker]:hidden">
            <ChevronDownIcon
              className="h-3.5 w-3.5 -rotate-90 transition-transform group-open/install:rotate-0"
              aria-hidden="true"
            />
            {i18nService.t('browserExtensionStepInstallTitle')}
          </summary>
          <p className="mt-2 whitespace-pre-line pl-5 text-xs leading-5">
            <ExtensionInstallDescription />
          </p>
        </details>
        {extensionPageUrlCopied ? (
          <p className="mt-2 text-xs leading-5 text-secondary">
            {i18nService.t('browserExtensionPageCopied')}{' '}
            <code className="select-all rounded bg-surface-raised px-1.5 py-0.5">
              chrome://extensions
            </code>
          </p>
        ) : null}
      </section>

      <section className="overflow-hidden rounded-xl border border-border bg-surface">
        <div className="bg-surface-raised px-4 py-3">
          <div className="grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-primary">
              <ShieldCheckIcon className="h-4 w-4" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <label
                htmlFor="browser-mode"
                className="block truncate text-sm font-semibold leading-5 text-foreground"
              >
                {i18nService.t('browserModeTitle')}
              </label>
              <p
                role={modeApplyState ? 'status' : undefined}
                aria-live={modeApplyState ? 'polite' : undefined}
                className="mt-0.5 flex h-4 min-w-0 items-center gap-1.5 text-[11px] leading-4 text-secondary"
              >
                {modeApplyState ? (
                  modeApplyState.phase === 'complete' ? (
                    <CheckCircleIcon
                      className="h-3.5 w-3.5 shrink-0 text-primary"
                      aria-hidden="true"
                    />
                  ) : (
                    <span
                      className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-primary/25 border-t-primary"
                      aria-hidden="true"
                    />
                  )
                ) : null}
                <span className="min-w-0 truncate">
                  {modeApplyState?.phase === 'complete'
                    ? i18nService.t('browserModeChangeComplete')
                    : modeApplyState?.phase === 'restarting'
                      ? i18nService.t('browserModeGatewayRestarting')
                      : modeApplyState
                        ? i18nService.t('browserModeApplying')
                        : i18nService.t('browserModeDescription')}
                </span>
              </p>
            </div>
            <BrowserSelect
              id="browser-mode"
              value={browserMode}
              onChange={event => void selectBrowserMode(normalizeBrowserMode(event.target.value))}
              disabled={savingMode || busyAction !== null}
              aria-busy={savingMode}
            >
              <option value={BrowserMode.Embedded}>
                {i18nService.t('browserModeEmbeddedGroupTitle')}
              </option>
              <option value={chromeMode}>{i18nService.t('browserModeChromeGroupTitle')}</option>
            </BrowserSelect>
          </div>
        </div>
        {browserMode !== BrowserMode.Embedded ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 px-4 py-3">
            <span className="text-xs font-medium text-secondary">
              {i18nService.t('browserChromeConnectionTitle')}
            </span>
            <div
              role="radiogroup"
              aria-label={i18nService.t('browserChromeConnectionTitle')}
              aria-busy={savingMode}
              className="flex flex-wrap gap-1 rounded-lg bg-surface-raised p-1"
            >
              {[
                {
                  mode: BrowserMode.Isolated,
                  label: 'browserModeIsolatedOption',
                  title: 'browserModeIsolatedTitle',
                },
                {
                  mode: BrowserMode.User,
                  label: 'browserModeUserOption',
                  title: 'browserModeUserTitle',
                },
                {
                  mode: BrowserMode.Extension,
                  label: 'browserModeExtensionOption',
                  title: 'browserModeExtensionTitle',
                },
              ].map(option => (
                <button
                  key={option.mode}
                  type="button"
                  role="radio"
                  aria-label={i18nService.t(option.title)}
                  aria-checked={browserMode === option.mode}
                  disabled={savingMode || busyAction !== null}
                  onClick={() => void selectBrowserMode(option.mode)}
                  className={[
                    'rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25 disabled:cursor-not-allowed disabled:opacity-60',
                    browserMode === option.mode
                      ? 'bg-surface text-primary shadow-sm'
                      : 'text-secondary hover:bg-surface/60 hover:text-foreground',
                  ].join(' ')}
                >
                  {i18nService.t(option.label)}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {modeSwitchWarning ? (
          <div
            role="alert"
            className="mx-4 mb-4 flex items-start gap-2.5 rounded-2xl border border-warning/30 bg-warning/[0.07] px-4 py-3.5 text-sm leading-5 text-foreground shadow-sm"
          >
            <ExclamationTriangleIcon className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
            <span className="min-w-0 flex-1">{modeSwitchWarning}</span>
          </div>
        ) : null}

        <div className="space-y-3 border-t border-border/60 px-4 py-3">
          {browserMode === BrowserMode.Isolated ? (
            <div className="flex items-start gap-2 text-xs leading-5 text-secondary">
              <span className="pt-0.5 text-primary">
                <ShieldCheckIcon className="h-4 w-4" aria-hidden="true" />
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
              <div className="flex items-start gap-2 text-xs leading-5 text-secondary">
                <UserCircleIcon
                  className="mt-0.5 h-4 w-4 shrink-0 text-primary"
                  aria-hidden="true"
                />
                <p>{i18nService.t('browserUserChromeDescription')}</p>
              </div>
              <div
                role="status"
                aria-live="polite"
                className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${
                  status?.endpointReachable
                    ? 'border-primary/30 bg-primary/5'
                    : 'border-warning/30 bg-warning/5'
                }`}
              >
                {status?.endpointReachable ? (
                  <CheckCircleIcon className="h-4 w-4 shrink-0 text-primary" />
                ) : (
                  <ExclamationTriangleIcon className="h-4 w-4 shrink-0 text-warning" />
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

              <div className="divide-y divide-border/60">
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
            <div>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <h4 className="text-[13px] font-semibold text-foreground">
                    {i18nService.t('browserExtensionStepPairTitle')}
                  </h4>
                  <p className="mt-1 whitespace-pre-line text-xs leading-5 text-secondary">
                    {i18nService.t('browserExtensionStepPairDescription')}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                  {connectionVerification.extension ? (
                    <span className="inline-flex items-center gap-1.5 text-xs text-primary">
                      <CheckCircleIcon className="h-4 w-4" aria-hidden="true" />
                      {i18nService.t('browserConnectionVerified')}
                    </span>
                  ) : null}
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
                      className={'h-3.5 w-3.5 ' + (extensionTestKind ? 'animate-spin' : '')}
                    />
                    {i18nService.t('browserExtensionTestConnection')}
                  </button>
                </div>
              </div>
              {extensionConnectionTestError ? (
                <p
                  className="mt-2 flex items-start gap-1.5 text-xs leading-5 text-destructive"
                  role="alert"
                >
                  <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  {extensionConnectionTestError}
                </p>
              ) : null}
              <details className="group/manual mt-3 border-t border-border/60 pt-2">
                <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded py-1 text-xs text-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25 [&::-webkit-details-marker]:hidden">
                  <ChevronDownIcon
                    className="h-3.5 w-3.5 -rotate-90 transition-transform group-open/manual:rotate-0"
                    aria-hidden="true"
                  />
                  {i18nService.t('browserExtensionManualPairTitle')}
                </summary>
                <div className="mt-2 flex flex-col gap-3 pl-5 sm:flex-row sm:items-center sm:justify-between">
                  <p className="whitespace-pre-line text-xs leading-5 text-secondary">
                    {i18nService.t('browserExtensionManualPairDescription')}
                  </p>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
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
                      <span className="inline-flex items-center gap-1.5 text-xs text-primary">
                        <CheckCircleIcon className="h-4 w-4" aria-hidden="true" />
                        {i18nService.t('browserExtensionPairingCopied')}
                      </span>
                    ) : null}
                  </div>
                </div>
              </details>
            </div>
          ) : (
            <div className="flex items-start gap-2 text-xs leading-5 text-secondary">
              <span className="pt-0.5 text-primary">
                <WindowIcon className="h-4 w-4" aria-hidden="true" />
              </span>
              <p>{i18nService.t('browserModeEmbeddedActive')}</p>
            </div>
          )}
        </div>
      </section>

      <section className="overflow-hidden rounded-xl border border-border bg-surface">
        <h3 className="flex items-center gap-2 border-b border-border bg-surface-raised px-4 py-3 text-sm font-semibold text-foreground">
          <ArrowTopRightOnSquareIcon className="h-4 w-4 text-secondary" aria-hidden="true" />
          {i18nService.t('browserLinkTargetsTitle')}
        </h3>
        <div className="divide-y divide-border/50 px-4">
          {[
            {
              key: 'browserWebLinkTarget' as const,
              title: 'browserWebLinkTargetTitle',
              description: 'browserWebLinkTargetDescription',
            },
            {
              key: 'browserHtmlLinkTarget' as const,
              title: 'browserHtmlLinkTargetTitle',
              description: 'browserHtmlLinkTargetDescription',
            },
          ].map(setting => (
            <div
              key={setting.key}
              className="flex min-h-12 items-center justify-between gap-3 py-2"
            >
              <div className="min-w-0">
                <label htmlFor={setting.key} className="text-sm text-foreground">
                  {i18nService.t(setting.title)}
                </label>
                <span id={setting.key + '-description'} className="sr-only">
                  {i18nService.t(setting.description)}
                </span>
              </div>
              <BrowserSelect
                id={setting.key}
                aria-describedby={setting.key + '-description'}
                value={linkTargets[setting.key]}
                disabled={savingLinkTarget}
                onChange={event =>
                  void selectLinkTarget(
                    setting.key,
                    normalizeBrowserLinkTarget(event.target.value, linkTargets[setting.key]),
                  )
                }
              >
                <option value={BrowserLinkTarget.Embedded}>
                  {i18nService.t('browserModeEmbeddedGroupTitle')}
                </option>
                <option value={BrowserLinkTarget.Chrome}>
                  {i18nService.t('browserModeChromeGroupTitle')}
                </option>
              </BrowserSelect>
            </div>
          ))}
        </div>
      </section>

      <section className="overflow-hidden rounded-xl border border-border bg-surface">
        <h3 className="flex items-center gap-2 border-b border-border bg-surface-raised px-4 py-3 text-sm font-semibold text-foreground">
          <WindowIcon className="h-4 w-4 text-secondary" aria-hidden="true" />
          {i18nService.t('browserEmbeddedSettingsTitle')}
        </h3>
        <div className="divide-y divide-border/50 px-4">
          <div className="flex min-h-12 items-center justify-between gap-3 py-2">
            <label
              htmlFor="browser-search-engine"
              className="text-sm text-foreground"
              title={i18nService.t('browserSearchEngineDescription')}
            >
              {i18nService.t('browserSearchEngineTitle')}
            </label>
            <span id="browser-search-engine-description" className="sr-only">
              {i18nService.t('browserSearchEngineDescription')}
            </span>
            <BrowserSelect
              id="browser-search-engine"
              aria-describedby="browser-search-engine-description"
              value={searchEngine}
              onChange={event =>
                void selectSearchEngine(normalizeBrowserSearchEngine(event.target.value))
              }
            >
              <option value={BrowserSearchEngine.Baidu}>
                {i18nService.t('browserSearchEngineBaidu')}
              </option>
              <option value={BrowserSearchEngine.Google}>
                {i18nService.t('browserSearchEngineGoogle')}
              </option>
            </BrowserSelect>
          </div>
          <div className="flex min-h-12 items-center justify-between gap-3 py-2">
            <span id="browser-history-label" className="text-sm text-foreground">
              {i18nService.t('browserHistoryTitle')}
            </span>
            <button
              type="button"
              aria-describedby="browser-history-label"
              className={actionButtonClassName}
              onClick={() => setPage('history')}
            >
              {i18nService.t('browserManage')}
            </button>
          </div>
          <div className="flex min-h-12 items-center justify-between gap-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="text-sm text-foreground">
                {i18nService.t('browserDownloadLocationTitle')}
              </div>
              <p
                className="mt-0.5 truncate text-xs text-secondary"
                title={downloadDirectory || i18nService.t('browserDownloadSystemFolder')}
              >
                {downloadDirectory || i18nService.t('browserDownloadSystemFolder')}
              </p>
            </div>
            <button
              type="button"
              className={actionButtonClassName}
              onClick={() => void chooseDownloadDirectory()}
            >
              {i18nService.t('browserDownloadChangeLocation')}
            </button>
          </div>
          <div className="flex min-h-12 items-center justify-between gap-3 py-2">
            <span className="text-sm text-foreground">
              {i18nService.t('browserAskDownloadLocationTitle')}
            </span>
            <span id="browser-ask-download-description" className="sr-only">
              {i18nService.t('browserAskDownloadLocationDescription')}
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={askDownloadLocation}
              aria-label={i18nService.t('browserAskDownloadLocationTitle')}
              aria-describedby="browser-ask-download-description"
              onClick={() => void toggleAskDownloadLocation()}
              className={`flex h-6 w-10 shrink-0 items-center rounded-full p-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                askDownloadLocation ? 'bg-primary' : 'bg-border'
              }`}
            >
              <span
                className={`h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                  askDownloadLocation ? 'translate-x-4' : 'translate-x-0'
                }`}
              />
            </button>
          </div>
          <div className="flex min-h-12 items-center justify-between gap-3 py-2">
            <span id="browser-downloads-label" className="text-sm text-foreground">
              {i18nService.t('browserDownloadsTitle')}
            </span>
            <button
              type="button"
              aria-describedby="browser-downloads-label"
              className={actionButtonClassName}
              onClick={() => setPage('downloads')}
            >
              {i18nService.t('browserManage')}
            </button>
          </div>
        </div>
      </section>
      <section
        aria-labelledby="browser-proxy-title"
        className="overflow-hidden rounded-xl border border-border bg-surface"
      >
        <h3
          id="browser-proxy-title"
          className="flex items-center gap-2 border-b border-border bg-surface-raised px-4 py-3 text-sm font-semibold text-foreground"
        >
          <GlobeAltIcon className="h-4 w-4 text-secondary" aria-hidden="true" />
          {i18nService.t('browserProxySettings')}
        </h3>
        <div className="divide-y divide-border/50 px-4">
          <div className="flex min-h-12 items-center justify-between gap-3 py-3">
            <div className="min-w-0 flex-1">
              <label htmlFor="browser-proxy-mode" className="text-sm text-foreground">
                {i18nService.t('proxyMode')}
              </label>
              <p id="browser-proxy-mode-description" className="mt-0.5 text-xs text-secondary">
                {i18nService.t(
                  browserProxy.mode === ProxyMode.SYSTEM
                    ? 'useSystemProxyDescription'
                    : browserProxy.mode === ProxyMode.CUSTOM
                      ? 'customProxyDescription'
                      : 'noProxyDescription',
                )}
              </p>
            </div>
            <BrowserSelect
              id="browser-proxy-mode"
              aria-describedby="browser-proxy-mode-description"
              value={browserProxy.mode}
              disabled={isSaving}
              onChange={event =>
                onBrowserProxyChange({ ...browserProxy, mode: event.target.value as ProxyMode })
              }
            >
              <option value={ProxyMode.SYSTEM}>{i18nService.t('useSystemProxy')}</option>
              <option value={ProxyMode.DIRECT}>{i18nService.t('noProxy')}</option>
              <option value={ProxyMode.CUSTOM}>{i18nService.t('customProxy')}</option>
            </BrowserSelect>
          </div>
          {browserProxy.mode === ProxyMode.CUSTOM && (
            <div className="py-3">
              <CustomProxyFields
                id="browser-proxy"
                customProxy={browserProxy.custom}
                handleCustomProxyChange={(key, value) =>
                  onBrowserProxyChange({
                    ...browserProxy,
                    custom: { ...browserProxy.custom, [key]: value },
                  })
                }
                isSaving={isSaving}
              />
            </div>
          )}
          <div className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="min-w-0 flex-1 text-xs leading-5 text-secondary">
              {i18nService.t('browserProxyDescription')}
            </p>
            <button
              type="submit"
              aria-busy={isSaving}
              disabled={isSaving}
              className="inline-flex h-9 min-w-[88px] shrink-0 self-end items-center justify-center gap-1.5 rounded-xl bg-primary px-5 text-sm font-medium text-white shadow-sm transition-all hover:bg-primary-hover hover:shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSaving && <ArrowPathIcon className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {isSaving ? i18nService.t('saving') : i18nService.t('save')}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
};

export default BrowserSettingsTab;
