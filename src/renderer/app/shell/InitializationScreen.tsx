import {
  AppInitializationPhase,
  type AppInitializationState,
  AppInitializationStep,
} from '@shared/app/initialization';
import { useEffect, useState } from 'react';

import WindowHeader from '@/app/shell/window/WindowHeader';
import { i18nService } from '@/services/i18n';

const stepKeys = {
  [AppInitializationStep.UserData]: 'initializationUserData',
  [AppInitializationStep.Runtime]: 'initializationRuntime',
  [AppInitializationStep.Configuration]: 'initializationConfiguration',
  [AppInitializationStep.Engine]: 'initializationEngine',
  [AppInitializationStep.Complete]: 'initializationComplete',
};

export default function InitializationScreen({ state }: { state: AppInitializationState }) {
  const failed = state.phase === AppInitializationPhase.Failed;
  const [logPath, setLogPath] = useState('');
  useEffect(() => {
    if (!failed) return;
    let active = true;
    void window.electron.log
      .getPath()
      .then(path => {
        if (active) setLogPath(path);
      })
      .catch(error => console.warn('[AppInitialization] Failed to resolve the log path:', error));
    return () => {
      active = false;
    };
  }, [failed]);
  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <WindowHeader />
      <main className="flex flex-1 items-center justify-center p-8">
        <div className="w-full max-w-lg space-y-5 rounded-2xl border border-border bg-surface p-8 shadow-subtle">
          <h1 className="text-xl font-semibold">
            {i18nService.t(failed ? 'initializationFailed' : 'firstLaunchTitle')}
          </h1>
          <p className="text-sm leading-6 text-secondary">
            {i18nService.t(failed ? 'initializationFailedDescription' : 'firstLaunchDescription')}
          </p>
          <div role="status" aria-live="polite" className="space-y-3">
            <p className="flex items-center gap-2 text-sm">
              {!failed && (
                <span
                  aria-hidden="true"
                  className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-border border-t-primary"
                />
              )}
              {i18nService.t(stepKeys[state.step])}
            </p>
            <div
              role="progressbar"
              aria-label={i18nService.t('initializationSteps')}
              aria-valuenow={state.completedSteps}
              aria-valuemin={0}
              aria-valuemax={state.totalSteps}
              className="h-2 w-full overflow-hidden rounded-full bg-surface-raised"
            >
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-300 motion-reduce:transition-none"
                style={{ width: `${(state.completedSteps / state.totalSteps) * 100}%` }}
              />
            </div>
            <p className="text-xs text-secondary">
              {i18nService.t('initializationSteps')} {state.completedSteps}/{state.totalSteps}
            </p>
          </div>
          <p className="break-all text-xs text-secondary">{state.userDataPath}</p>
          {failed && (
            <>
              <p role="alert" className="break-words text-sm text-red-600 dark:text-red-300">
                {state.error}
              </p>
              {logPath && (
                <p className="break-all text-xs text-secondary">
                  {i18nService.t('initializationLogPath')} {logPath}
                </p>
              )}
              <button
                type="button"
                onClick={() =>
                  void window.electron.initialization
                    .relaunch()
                    .catch(error => console.error('[AppInitialization] Failed to restart:', error))
                }
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
              >
                {i18nService.t('initializationRetry')}
              </button>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
