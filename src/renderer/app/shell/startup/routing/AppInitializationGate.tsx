import './InitializationGate.css';
import '../initialization/StartupDiagnostics.css';

import {
  AppInitializationPhase,
  type AppInitializationState,
  AppInitializationTaskStatus,
} from '@shared/app/initialization';
import { StartupRoute } from '@shared/app/startup/routing';
import {
  captureStartupFailure,
  type StartupFailure,
  StartupFailureSource,
} from '@shared/app/startupFailure';
import React, {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { i18nService } from '@/services/i18n';

import WindowHeader from '../../window/WindowHeader';
import FirstLaunchGuide from '../initialization/FirstLaunchGuide';
import StartupDiagnostics, { StartupEngineNotice } from '../initialization/StartupDiagnostics';
import StartupErrorBoundary from '../initialization/StartupErrorBoundary';
import StartupFailureDetails from '../initialization/StartupFailureDetails';
import StartupFrame from '../initialization/StartupFrame';
import StartupLoading from '../initialization/StartupLoading';
import StartupScreen from '../initialization/StartupScreen';
import { useStartupEngine } from '../initialization/useStartupEngine';
import { useStartupReveal } from '../initialization/useStartupReveal';
import {
  InitializationContext,
  type InitializationController,
  RendererStartupActivity,
  StartupStartedAtContext,
} from './startupPresentation';

export default function AppInitializationGate({ children }: { children: React.ReactNode }) {
  const [firstLaunch] = useState(() => window.electron.initialization.firstLaunch);
  const [route] = useState(() => window.electron.initialization.route);
  const [state, setState] = useState<AppInitializationState | null>(null);
  const [readError, setReadError] = useState<StartupFailure | null>(null);
  const [rendererError, setRendererError] = useState<StartupFailure | null>(
    () => window.startupDiagnostics?.failure ?? null,
  );
  const [rendererReady, setRendererReady] = useState(false);
  const [rendererActivity, setRendererActivity] = useState<RendererStartupActivity>(
    RendererStartupActivity.Interface,
  );
  const [activityStartedAt, setActivityStartedAt] = useState(Date.now);
  const [, refreshLanguage] = useState(0);
  const completed = useRef(false);
  const failed = useRef(Boolean(rendererError));
  const rendererStarted = useRef(false);
  const currentActivity = useRef<RendererStartupActivity>(RendererStartupActivity.Interface);
  const [finished, setFinished] = useState(false);
  const [historyAccepted, setHistoryAccepted] = useState(false);
  const engine = useStartupEngine(!finished);
  const reportActivity = useCallback((activity: RendererStartupActivity) => {
    if (completed.current || failed.current) return;
    if (currentActivity.current === activity) return;
    currentActivity.current = activity;
    setRendererActivity(activity);
    setActivityStartedAt(Date.now());
  }, []);
  const complete = useCallback(() => {
    if (failed.current) return;
    completed.current = true;
    setRendererReady(true);
  }, []);
  const fail = useCallback((error: unknown) => {
    if (failed.current) return;
    failed.current = true;
    console.error('[AppInitialization] Renderer initialization failed:', error);
    setRendererError(
      captureStartupFailure(StartupFailureSource.Renderer, error, {
        activity: currentActivity.current,
      }),
    );
  }, []);
  const controller = useMemo<InitializationController>(
    () => ({ reportActivity, complete, fail }),
    [complete, fail, reportActivity],
  );
  useLayoutEffect(() => {
    const earlyFailure = window.startupDiagnostics?.failure;
    if (earlyFailure && !failed.current) {
      failed.current = true;
      setRendererError(earlyFailure);
    }
  }, []);
  useEffect(() => {
    document.documentElement.classList.add(`platform-${window.electron.platform}`);
    let active = true;
    let eventReceived = false;
    let shellReady = false;
    const accept = (next: AppInitializationState) => {
      if (!active) return;
      if (next.firstLaunch !== firstLaunch || (route && next.route !== route)) {
        setReadError(
          captureStartupFailure(
            StartupFailureSource.Renderer,
            i18nService.t('initializationModeMismatch'),
          ),
        );
        return;
      }
      shellReady = next.phase === AppInitializationPhase.Ready;
      if (shellReady && !rendererStarted.current) {
        rendererStarted.current = true;
        setActivityStartedAt(Date.now());
      }
      setReadError(null);
      setState(next);
    };
    const unsubscribe = window.electron.initialization.onChanged(next => {
      eventReceived = true;
      accept(next);
    });
    void window.electron.initialization
      .getState()
      .then(next => {
        if (!eventReceived) accept(next);
      })
      .catch(error => {
        console.error('[AppInitialization] Failed to read initialization state:', error);
        if (active && !eventReceived)
          setReadError(
            captureStartupFailure(StartupFailureSource.Renderer, error, {
              activity: 'initializationState',
            }),
          );
      });
    void window.electron.appInfo
      .getSystemLocale()
      .then(locale => {
        if (active && !shellReady)
          i18nService.setLanguage(locale.startsWith('zh') ? 'zh' : 'en', { persist: false });
      })
      .catch(error => console.warn('[AppInitialization] Failed to read system locale:', error));
    const unsubscribeLanguage = i18nService.subscribe(() => refreshLanguage(value => value + 1));
    return () => {
      active = false;
      unsubscribe();
      unsubscribeLanguage();
    };
  }, [firstLaunch, route]);
  const mainReady = state?.phase === AppInitializationPhase.Ready;
  const mainTasksPending = (route ?? state?.route) === StartupRoute.Normal &&
    Object.values(state?.tasks ?? {}).some(status =>
      status === AppInitializationTaskStatus.Waiting || status === AppInitializationTaskStatus.Running);
  const loading = !rendererReady || !mainReady || mainTasksPending || state?.enginePreparationPending === true ||
    Boolean(rendererError) || Boolean(readError);
  const historyReady =
    !loading &&
    (route ?? state?.route) === StartupRoute.Migration &&
    Boolean(state?.historySummary);
  const awaitingHistoryAcceptance = historyReady && !historyAccepted;
  // Only presentation waits for an open report. Engine failure never gates app readiness.
  const { covered, revealing } = useStartupReveal(
    firstLaunch,
    loading || engine.diagnosticsOpen || awaitingHistoryAcceptance,
  );
  useEffect(() => {
    if (!covered) setFinished(true);
  }, [covered]);
  const capturing = useRef(true);
  capturing.current = covered;
  useLayoutEffect(() => {
    const onError = (event: ErrorEvent) => {
      if (capturing.current && !(event.target instanceof Element))
        fail(event.error ?? event.message);
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      if (capturing.current) fail(event.reason);
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, [fail]);
  const rendererFailure = rendererError || readError;
  const presentation =
    state && rendererFailure && state.phase !== AppInitializationPhase.Failed
      ? {
          ...state,
          phase: AppInitializationPhase.Failed,
          error: rendererFailure.error.message,
          failure: rendererFailure,
          updatedAt: rendererFailure.occurredAt,
        }
      : state;
  const retryRenderer =
    rendererFailure && state?.phase !== AppInitializationPhase.Failed
      ? () => window.location.reload()
      : undefined;
  const activity = mainReady && !readError ? rendererActivity : undefined;
  const context = useMemo(() => ({ active: loading, controller }), [controller, loading]);
  const diagnostics = (
    <>
      {state?.failure && <StartupFailureDetails failure={state.failure} />}
      {rendererError && <StartupFailureDetails failure={rendererError} />}
      {readError && <StartupFailureDetails failure={readError} />}
      <StartupEngineNotice engine={engine} />
    </>
  );
  return (
    <InitializationContext.Provider value={context}>
      <StartupStartedAtContext.Provider value={state?.startedAt ?? null}>
        {mainReady && !readError && (
          <div
            data-application-surface="true"
            aria-hidden={covered}
            ref={element => {
              element?.toggleAttribute('inert', covered);
            }}
            style={{ visibility: covered && !revealing ? 'hidden' : undefined, height: '100%' }}
          >
            <StartupErrorBoundary onError={fail}>
              <Suspense fallback={null}>{children}</Suspense>
            </StartupErrorBoundary>
          </div>
        )}
        {covered && (
          <div className="initialization-overlay startup-transition" data-revealing={revealing}>
            {
              <div className="startup-curtains" aria-hidden="true">
                <div className="startup-curtain startup-curtain--left" />
                <div className="startup-curtain startup-curtain--right" />
              </div>
            }
            <div
              className="startup-presentation"
              aria-hidden={engine.diagnosticsOpen || undefined}
              ref={element => {
                element?.toggleAttribute('inert', engine.diagnosticsOpen);
              }}
              style={{ height: '100%' }}
            >
              {firstLaunch ? (
                <FirstLaunchGuide
                  state={presentation}
                  rendererActivity={activity}
                  rendererActivityStartedAt={activityStartedAt}
                  error={
                    state?.phase === AppInitializationPhase.Failed
                      ? undefined
                      : rendererFailure?.error.message
                  }
                  onRetry={retryRenderer}
                  diagnostics={diagnostics}
                  historyReady={historyReady}
                  onContinue={() => setHistoryAccepted(true)}
                />
              ) : presentation ? (
                <StartupScreen
                  state={presentation}
                  rendererActivity={activity}
                  rendererActivityStartedAt={activityStartedAt}
                  rendererReady={rendererReady}
                  engineStatus={engine.status}
                  engineError={Boolean(engine.commandError)}
                  onRetry={retryRenderer}
                  diagnostics={diagnostics}
                />
              ) : rendererFailure ? (
                <div className="startup-screen" data-startup-view="launch" data-failed="true">
                  <WindowHeader />
                  <StartupFrame failed>
                    <p role="alert" className="startup-error">
                      {rendererFailure.error.message}
                    </p>
                    <button
                      className="startup-action"
                      type="button"
                      onClick={() => window.location.reload()}
                    >
                      {i18nService.t('startupReload')}
                    </button>
                    {diagnostics}
                  </StartupFrame>
                </div>
              ) : (
                <div className="startup-screen" data-startup-view="launch">
                  <WindowHeader />
                  <StartupLoading diagnostics={diagnostics} />
                </div>
              )}
            </div>
            <StartupDiagnostics engine={engine} />
          </div>
        )}
      </StartupStartedAtContext.Provider>
    </InitializationContext.Provider>
  );
}
