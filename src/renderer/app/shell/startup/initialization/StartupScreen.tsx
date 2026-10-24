import { AppInitializationPhase, type AppInitializationState } from '@shared/app/initialization';
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

/** Subsequent launches display runtime operations, never first-install preparation copy. */
export default function StartupScreen({
  state,
  rendererActivity,
  rendererActivityStartedAt,
  onRetry,
  diagnostics,
}: {
  state: AppInitializationState;
  rendererActivity?: RendererStartupActivity;
  rendererActivityStartedAt?: number;
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
            <div className="startup-metrics">
              <span>
                {loadingInterface
                  ? i18nService.t('startupInterfaceLoading')
                  : i18nService.t('startupLoadingLabel')}
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
              aria-valuenow={loadingInterface ? undefined : state.completedSteps}
              aria-valuemin={0}
              aria-valuemax={state.totalSteps}
            >
              <div
                className="startup-progress-fill"
                style={{
                  width: loadingInterface
                    ? undefined
                    : `${state.totalSteps > 0 ? (state.completedSteps / state.totalSteps) * 100 : 0}%`,
                }}
              />
            </div>
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
