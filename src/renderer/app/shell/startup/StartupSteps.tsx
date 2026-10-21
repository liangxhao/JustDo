import { type AppInitializationState, AppInitializationStep } from '@shared/app/initialization';

import { i18nService } from '@/services/i18n';

const startupSteps = [
  AppInitializationStep.UserData,
  AppInitializationStep.Runtime,
  AppInitializationStep.Configuration,
  AppInitializationStep.Engine,
] as const;

export default function StartupSteps({
  state,
  failed = false,
}: {
  state?: AppInitializationState;
  failed?: boolean;
}) {
  return (
    <ol className="startup-steps" aria-label={i18nService.t('startupSteps')}>
      {startupSteps.map((step, index) => {
        const completed = index < (state?.completedSteps ?? 0);
        const current = !completed && state?.step === step;
        const status = completed
          ? 'startupStepComplete'
          : current
            ? failed
              ? 'startupStepFailed'
              : 'startupStepRunning'
            : 'startupStepWaiting';
        return (
          <li
            key={step}
            className="startup-step"
            aria-current={current ? 'step' : undefined}
            data-completed={completed}
          >
            <span className="startup-step-marker" aria-hidden="true">
              {completed ? '✓' : failed && current ? '!' : '·'}
            </span>
            <span className="startup-step-name">{i18nService.t(`startupStep_${step}`)}</span>
            <span className="startup-step-status">{i18nService.t(status)}</span>
          </li>
        );
      })}
    </ol>
  );
}
