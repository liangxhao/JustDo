import { CheckIcon, ClockIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import {
  AppInitializationActivity,
  AppInitializationPhase,
  type AppInitializationState,
  AppInitializationStep,
} from '@shared/app/initialization';
import { StartupRoute } from '@shared/app/startup/routing';
import { PRODUCT_NAME } from '@shared/productMetadata';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';

import WindowHeader from '@/app/shell/window/WindowHeader';
import { i18nService } from '@/services/i18n';

import appLogoUrl from '../../../../../../resources/icons/logo.png';
import HistoryRecoveryAdvice from '../history/HistoryRecoveryAdvice';
import HistoryUpgradeResult from '../history/HistoryUpgradeResult';
import type { RendererStartupActivity } from '../routing/startupPresentation';
import DowngradeConfirmation from './DowngradeConfirmation';
import StartupCompatibilityAdvice, {
  hasStartupCompatibilityAdvice,
} from './StartupCompatibilityAdvice';
import { prepareStartupEntry } from './startupMotion';

const setupSteps = [
  AppInitializationStep.UserData,
  AppInitializationStep.Runtime,
  AppInitializationStep.Configuration,
  AppInitializationStep.Engine,
] as const;
const stepKeys = {
  [AppInitializationStep.DatabaseUpgrade]: 'initializationDatabaseUpgrade',
  [AppInitializationStep.Backup]: 'initializationBackup',
  [AppInitializationStep.History]: 'initializationHistory',
  [AppInitializationStep.UserData]: 'initializationUserData',
  [AppInitializationStep.Runtime]: 'initializationRuntime',
  [AppInitializationStep.Configuration]: 'initializationConfiguration',
  [AppInitializationStep.Engine]: 'initializationEngine',
};
const LONG_ACTIVITY_SECONDS = 30;
const EXTENDED_ACTIVITY_SECONDS = 90;

function duration(seconds: number): string {
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}

export default function FirstLaunchGuide({
  state: snapshot,
  rendererActivity,
  rendererActivityStartedAt,
  error,
  onRetry,
  diagnostics,
  historyReady = false,
  onContinue,
}: {
  state: AppInitializationState | null;
  rendererActivity?: RendererStartupActivity;
  rendererActivityStartedAt?: number;
  error?: string;
  onRetry?: () => void | Promise<void>;
  diagnostics?: ReactNode;
  historyReady?: boolean;
  onContinue?: () => void;
}) {
  const frame = useRef<HTMLElement>(null);
  const [openedAt] = useState(Date.now);
  const fixedRoute = snapshot?.route ?? window.electron?.initialization?.route;
  const fixedMigration = fixedRoute === StartupRoute.Migration;
  const upgrade = fixedRoute === StartupRoute.Upgrade;
  const state: AppInitializationState = snapshot ?? {
    firstLaunch: true,
    phase: AppInitializationPhase.Preparing,
    step: fixedMigration
      ? AppInitializationStep.Backup
      : upgrade
        ? AppInitializationStep.DatabaseUpgrade
        : AppInitializationStep.UserData,
    activity: fixedMigration
      ? AppInitializationActivity.HistoryBackup
      : upgrade
        ? AppInitializationActivity.NativeInspect
        : AppInitializationActivity.UserDirectory,
    completedSteps: 0,
    totalSteps: fixedMigration ? 6 : upgrade ? 5 : 4,
    userDataPath: '',
    startedAt: openedAt,
    activityStartedAt: openedAt,
    updatedAt: openedAt,
  };
  const failed = state.phase === AppInitializationPhase.Failed || Boolean(error);
  const confirmation = failed ? undefined : state.downgradeConfirmation;
  const compatibilityCode = error ? undefined : state.failure?.error.code;
  const migration =
    (state.route ?? window.electron?.initialization?.route) === StartupRoute.Migration;
  const showHistoryResult = historyReady && Boolean(state.historySummary) && Boolean(onContinue);
  const steps = migration
    ? [
        AppInitializationStep.Backup,
        ...setupSteps.slice(0, 3),
        AppInitializationStep.History,
        AppInitializationStep.Engine,
      ]
    : upgrade
      ? [AppInitializationStep.DatabaseUpgrade, ...setupSteps]
      : setupSteps;
  useLayoutEffect(() => {
    if (frame.current) return prepareStartupEntry(frame.current, failed);
  }, [failed]);
  const preparing =
    !failed &&
    !confirmation &&
    (state.phase === AppInitializationPhase.Preparing || Boolean(rendererActivity));
  const loadingInterface = preparing && Boolean(rendererActivity);
  const [now, setNow] = useState(Date.now);
  const [logPath, setLogPath] = useState('');
  useEffect(() => {
    if (!preparing) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [preparing]);
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
  const waitingLong = preparing && activityElapsed >= LONG_ACTIVITY_SECONDS;
  const activityKey = rendererActivity
    ? `${upgrade ? 'startup' : 'initialization'}Renderer_${rendererActivity}`
    : snapshot
      ? upgrade && state.activity === AppInitializationActivity.UserDirectory
        ? 'initializationRetainedData'
        : `${upgrade && !state.activity.startsWith('native') ? 'startup' : 'initialization'}Activity_${state.activity}`
      : 'initializationConnecting';

  return (
    <div
      data-startup-view={migration ? 'migration' : upgrade ? 'upgrade' : 'first-launch'}
      data-failed={failed}
      className={`flex h-screen flex-col bg-background text-foreground${showHistoryResult ? ' migration-completion-screen' : ''}`}
    >
      <WindowHeader />
      <main
        ref={frame}
        className="relative flex min-h-0 flex-1 flex-col overflow-auto px-6 py-5 md:px-8 lg:px-10 lg:py-8"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-gradient-to-b from-primary-muted/50 to-transparent"
        />
        <div data-startup-content="true" className="relative m-auto w-full max-w-4xl py-2">
          <header data-startup-header="true" className="mb-5 flex items-center gap-4 lg:mb-7">
            <div
              data-startup-emblem="true"
              className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-border-subtle bg-surface shadow-glow-accent lg:h-16 lg:w-16"
            >
              <img
                data-startup-logo="true"
                src={appLogoUrl}
                alt=""
                width={46}
                height={46}
                draggable={false}
                className="h-[46px] w-[46px] object-contain"
              />
            </div>
            <div data-startup-heading="true">
              <p className="mb-1 text-xs font-medium tracking-wide text-secondary">
                {PRODUCT_NAME} /{' '}
                {i18nService.t(
                  migration
                    ? 'initializationUpgradeWelcome'
                    : upgrade
                      ? 'initializationNormalUpgradeWelcome'
                      : 'initializationWelcome',
                )}
              </p>
              <h1 className="text-2xl font-semibold tracking-tight">
                {i18nService.t(
                  confirmation
                    ? 'startupDowngradeWelcome'
                    : failed
                      ? 'initializationFailed'
                      : showHistoryResult
                        ? 'initializationResultHeading'
                        : rendererActivity
                          ? upgrade
                            ? 'initializationNormalUpgradeFinishing'
                            : 'firstLaunchFinishing'
                          : migration
                            ? 'initializationUpgradeTitle'
                            : upgrade
                              ? 'initializationNormalUpgradeTitle'
                              : 'firstLaunchTitle',
                )}
              </h1>
            </div>
          </header>
          <div
            data-startup-panel="true"
            className="overflow-hidden rounded-3xl border border-border bg-surface shadow-glow-accent"
          >
            <div data-startup-columns="true" className="grid md:grid-cols-[220px_minmax(0,1fr)] lg:grid-cols-[260px_minmax(0,1fr)]">
              <nav
                data-startup-navigation="true"
                aria-label={i18nService.t('initializationSteps')}
                className="border-b border-border-subtle bg-surface-raised/40 p-5 md:border-b-0 md:border-r lg:p-7"
              >
                <p className="mb-5 text-xs font-medium text-secondary">
                  {i18nService.t('initializationSetupSteps')}
                </p>
                <ol className="space-y-5">
                  {steps.map((step, index) => {
                    const completed = index < state.completedSteps;
                    const current = state.step === step;
                    return (
                      <li
                        key={step}
                        aria-current={current ? 'step' : undefined}
                        className="flex items-start gap-3"
                      >
                        <span
                          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-medium ${completed ? 'border-primary/20 bg-primary-muted text-primary' : current ? 'border-primary bg-primary text-white' : 'border-border text-muted'}`}
                        >
                          {completed ? (
                            <CheckIcon aria-hidden="true" className="h-4 w-4" />
                          ) : failed && current ? (
                            <ExclamationTriangleIcon aria-hidden="true" className="h-4 w-4" />
                          ) : (
                            String(index + 1).padStart(2, '0')
                          )}
                        </span>
                        <div className="min-w-0 pt-0.5">
                          <p
                            className={`text-sm font-medium ${current || completed ? 'text-foreground' : 'text-secondary'}`}
                          >
                            {i18nService.t(
                              upgrade && step === AppInitializationStep.UserData
                                ? 'initializationRetainedData'
                                : stepKeys[step as keyof typeof stepKeys],
                            )}
                          </p>
                          <p className="mt-1 text-xs text-muted">
                            {i18nService.t(
                              completed
                                ? 'initializationStepDone'
                                : current
                                  ? confirmation
                                    ? 'startupDowngradeWaiting'
                                    : failed
                                      ? 'initializationStepFailed'
                                      : 'initializationStepActive'
                                  : 'initializationStepPending',
                            )}
                          </p>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </nav>
              <section data-startup-body="true" className="min-w-0 p-5 lg:p-8">
                {historyReady && state.historySummary && onContinue ? (
                  <HistoryUpgradeResult
                    summary={state.historySummary}
                    backupPath={state.historyBackupPath}
                    onContinue={onContinue}
                  />
                ) : confirmation ? (
                  <DowngradeConfirmation key={confirmation.requestId} confirmation={confirmation} />
                ) : (
                  <>
                    <div className="mb-5 flex flex-wrap items-center justify-between gap-3 text-xs lg:mb-6">
                      <span
                        className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 ${failed ? 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300' : 'bg-primary-muted text-primary'}`}
                      >
                        {preparing && (
                          <span
                            aria-hidden="true"
                            className="h-3 w-3 animate-spin rounded-full border-2 border-primary/20 border-t-primary"
                          />
                        )}
                        {i18nService.t(
                          failed
                            ? 'initializationStepFailed'
                            : preparing
                              ? 'initializationStepActive'
                              : 'initializationComplete',
                        )}
                      </span>
                      <span className="inline-flex items-center gap-1.5 text-secondary">
                        <ClockIcon aria-hidden="true" className="h-3.5 w-3.5" />
                        {i18nService.t('initializationElapsed')}{' '}
                        <span className="tabular-nums">{duration(elapsed)}</span>
                      </span>
                    </div>
                    <div
                      key={activityKey}
                      className="startup-stage-content"
                      role="status"
                      aria-live="polite"
                      aria-atomic="true"
                    >
                      <p className="mb-2 text-xs text-secondary">
                        {i18nService.t(
                          failed ? 'initializationStoppedAt' : 'initializationCurrentActivity',
                        )}
                      </p>
                      <h2 className="text-xl font-semibold leading-8">
                        {i18nService.t(activityKey)}
                      </h2>
                      <p className="mt-3 min-h-[3rem] text-sm leading-6 text-secondary lg:min-h-[4.5rem]">
                        {i18nService.t(`${activityKey}Description`)}
                      </p>
                    </div>
                    <div className="mt-5 lg:mt-6">
                      <div className="mb-2.5 flex justify-between gap-3 text-xs text-secondary">
                        <span>
                          {loadingInterface ? (
                            i18nService.t('initializationInterfaceLoading')
                          ) : (
                            <>
                              {i18nService.t('initializationSteps')}{' '}
                              <span className="font-medium tabular-nums text-foreground">
                                {state.completedSteps}/{state.totalSteps}
                              </span>
                            </>
                          )}
                        </span>
                        <span>
                          {i18nService.t('initializationActivityElapsed')}{' '}
                          <span className="tabular-nums">{duration(activityElapsed)}</span>
                        </span>
                      </div>
                      <div
                        role="progressbar"
                        aria-label={i18nService.t('initializationSteps')}
                        aria-valuenow={
                          snapshot && !loadingInterface ? state.completedSteps : undefined
                        }
                        aria-valuemin={0}
                        aria-valuemax={state.totalSteps}
                        className={`h-1.5 overflow-hidden rounded-full bg-surface-raised${loadingInterface ? ' first-launch-progress--indeterminate' : ''}`}
                      >
                        <div
                          className="h-full rounded-full bg-primary transition-[width] duration-500"
                          style={{
                            width: loadingInterface
                              ? undefined
                              : `${state.totalSteps > 0 ? (state.completedSteps / state.totalSteps) * 100 : 0}%`,
                          }}
                        />
                      </div>
                    </div>
                    <div
                      className={`mt-5 rounded-xl border p-4 text-xs leading-5 lg:mt-6 ${waitingLong ? 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200' : 'border-border-subtle bg-surface-raised/40 text-secondary'}`}
                    >
                      <p>
                        {i18nService.t(
                          failed
                            ? 'initializationFailedDescription'
                            : waitingLong
                              ? activityElapsed >= EXTENDED_ACTIVITY_SECONDS
                                ? 'initializationExtendedWait'
                                : 'initializationLongWait'
                              : migration
                                ? 'initializationUpgradeDescription'
                                : upgrade
                                  ? 'initializationNormalUpgradeDescription'
                                  : 'firstLaunchDescription',
                        )}
                      </p>
                    </div>
                    {failed && (
                      <div className="mt-5 space-y-4">
                        {state.historyRecovery && (
                          <HistoryRecoveryAdvice kind={state.historyRecovery} database={upgrade} />
                        )}
                        <StartupCompatibilityAdvice code={compatibilityCode} />
                        <p
                          role={
                            hasStartupCompatibilityAdvice(compatibilityCode) ? undefined : 'alert'
                          }
                          className="break-words text-sm text-red-600 dark:text-red-300"
                        >
                          {error ?? state.error}
                        </p>
                        <button
                          type="button"
                          onClick={() =>
                            void Promise.resolve(
                              onRetry ? onRetry() : window.electron.initialization.relaunch(),
                            ).catch(error =>
                              console.error('[AppInitialization] Failed to restart:', error),
                            )
                          }
                          className="rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white hover:bg-primary-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                        >
                          {i18nService.t(onRetry ? 'initializationReload' : 'initializationRetry')}
                        </button>
                      </div>
                    )}
                    {diagnostics}
                    {state.historySummary && (
                      <p className="mt-4 text-xs leading-5 text-secondary">
                        {i18nService.t('initializationHistoryRecovered')}{' '}
                        {state.historySummary.conversations}
                        {state.historySummary.unavailableConversations > 0 &&
                          ` · ${i18nService.t('initializationHistoryUnavailable')} ${state.historySummary.unavailableConversations}`}
                      </p>
                    )}
                  </>
                )}
              </section>
            </div>
            <details
              data-startup-diagnostics="true"
              open={failed}
              className="border-t border-border-subtle px-6 py-4 text-xs text-secondary md:px-7"
            >
              <summary className="w-fit cursor-pointer rounded focus-visible:outline focus-visible:outline-primary">
                {i18nService.t('initializationDetails')}
              </summary>
              <dl className="mt-3 space-y-2 leading-5">
                <div>
                  <dt>{i18nService.t('initializationDataPath')}</dt>
                  <dd className="select-text break-all">{state.userDataPath}</dd>
                </div>
                {logPath && (
                  <div>
                    <dt>{i18nService.t('initializationLogPath')}</dt>
                    <dd className="select-text break-all">{logPath}</dd>
                  </div>
                )}
              </dl>
            </details>
          </div>
        </div>
      </main>
    </div>
  );
}
