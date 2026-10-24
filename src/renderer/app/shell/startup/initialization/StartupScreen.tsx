import { AppInitializationPhase, type AppInitializationState } from '@shared/app/initialization';
import type { OpenClawEngineStatus } from '@shared/openclaw/engineStatus';
import { type ReactNode, useEffect, useState } from 'react';

import { i18nService } from '@/services/i18n';

import WindowHeader from '../../window/WindowHeader';
import HistoryRecoveryAdvice from '../history/HistoryRecoveryAdvice';
import type { RendererStartupActivity } from '../routing/startupPresentation';
import DowngradeConfirmation from './DowngradeConfirmation';
import StartupCompatibilityAdvice, {
  hasStartupCompatibilityAdvice,
} from './StartupCompatibilityAdvice';
import StartupFrame, { startupDuration } from './StartupFrame';
import StartupSteps, { startupStepStates, StepStatus } from './StartupSteps';

/** Subsequent launches display runtime operations, never first-install preparation copy. */
export default function StartupScreen({
  state,
  rendererActivity,
  rendererActivityStartedAt,
  rendererReady = false,
  engineStatus,
  engineError,
  onRetry,
  diagnostics,
}: {
  state: AppInitializationState;
  rendererActivity?: RendererStartupActivity;
  rendererActivityStartedAt?: number;
  rendererReady?: boolean;
  engineStatus?: OpenClawEngineStatus;
  engineError?: boolean;
  onRetry?: () => void | Promise<void>;
  diagnostics?: ReactNode;
}) {
  const failed = state.phase === AppInitializationPhase.Failed;
  const confirmation = failed ? undefined : state.downgradeConfirmation;
  const compatibilityCode = state.failure?.error.code;
  const preparing =
    !failed &&
    !confirmation &&
    (state.phase === AppInitializationPhase.Preparing || Boolean(rendererActivity));
  const loadingInterface = preparing && Boolean(rendererActivity);
  const stepProps = {
    state,
    failed,
    engineStatus,
    engineError,
    rendererStarted: Boolean(rendererActivity),
    rendererReady,
  };
  const steps = startupStepStates(stepProps);
  const completedSteps = steps.filter(step => step.status === StepStatus.Complete).length;
  const [now, setNow] = useState(Date.now);
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState('');
  useEffect(() => {
    if (!preparing) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [preparing]);
  const clock = preparing ? Math.max(now, state.updatedAt) : state.updatedAt;
  const elapsed = Math.max(0, Math.floor((clock - state.startedAt) / 1000));
  const activityElapsed = Math.max(
    0,
    Math.floor(
      (clock -
        (rendererActivity
          ? (rendererActivityStartedAt ?? state.updatedAt)
          : state.activityStartedAt)) /
        1000,
    ),
  );
  const activityKey = rendererActivity
    ? `startupRenderer_${rendererActivity}`
    : `startupActivity_${state.activity}`;
  const restart = async () => {
    setRestarting(true);
    setRestartError('');
    try {
      await (onRetry ? onRetry() : window.electron.initialization.relaunch());
    } catch (error) {
      setRestartError(String(error));
      setRestarting(false);
    }
  };

  return (
    <div className="startup-screen" data-startup-view="launch" data-failed={failed}>
      <WindowHeader />
      <StartupFrame failed={failed}>
        {confirmation ? (
          <DowngradeConfirmation key={confirmation.requestId} confirmation={confirmation} />
        ) : (
          <>
            <section
              className="startup-activity"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              <h2 className="startup-operation">{i18nService.t(activityKey)}</h2>
              <p className="startup-operation-detail">
                {i18nService.t(`${activityKey}Description`)}
              </p>
            </section>
            <div className="startup-metrics">
              <span>
                {i18nService.t(
                  failed
                    ? 'startupFailed'
                    : loadingInterface
                      ? 'startupInterfaceLoading'
                      : 'startupLoadingLabel',
                )}
              </span>
              <span>
                {i18nService.t('startupElapsed')} <strong>{startupDuration(elapsed)}</strong> ·{' '}
                {i18nService.t('startupActivityElapsed')}{' '}
                <strong>{startupDuration(activityElapsed)}</strong>
              </span>
            </div>
            <div
              className={`startup-progress${loadingInterface ? ' startup-progress--indeterminate' : ''}`}
              role="progressbar"
              aria-label={i18nService.t('startupSteps')}
              aria-valuenow={loadingInterface ? undefined : completedSteps}
              aria-valuemin={0}
              aria-valuemax={steps.length}
            >
              <div
                className="startup-progress-fill"
                style={{
                  width: loadingInterface ? undefined : `${(completedSteps / steps.length) * 100}%`,
                }}
              />
            </div>
            <StartupSteps {...stepProps} />
            {failed && (
              <div className="startup-recovery">
                {state.historyRecovery && <HistoryRecoveryAdvice kind={state.historyRecovery} />}
                <StartupCompatibilityAdvice code={compatibilityCode} />
                <p
                  className="startup-error"
                  role={hasStartupCompatibilityAdvice(compatibilityCode) ? undefined : 'alert'}
                >
                  {state.error}
                </p>
                <button
                  className="startup-action"
                  type="button"
                  disabled={restarting}
                  onClick={() => void restart()}
                >
                  {i18nService.t(onRetry ? 'startupReload' : 'startupRestart')}
                </button>
                {restartError && (
                  <p className="startup-error" role="alert">
                    {restartError}
                  </p>
                )}
              </div>
            )}
            {diagnostics}
            <p className="startup-hint" data-waiting={preparing && activityElapsed >= 30}>
              {i18nService.t(
                failed
                  ? 'startupFailedDescription'
                  : activityElapsed >= 90
                    ? 'startupExtendedWait'
                    : activityElapsed >= 30
                      ? 'startupLongWait'
                      : 'startupContinue',
              )}
            </p>
          </>
        )}
      </StartupFrame>
    </div>
  );
}
