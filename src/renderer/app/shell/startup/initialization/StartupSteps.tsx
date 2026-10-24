import { type AppInitializationState, AppInitializationStep } from '@shared/app/initialization';
import { StartupFailureSource } from '@shared/app/startupFailure';
import { EnginePhase, type OpenClawEngineStatus } from '@shared/openclaw/engineStatus';

import { i18nService } from '@/services/i18n';

const mainSteps = [
  AppInitializationStep.UserData,
  AppInitializationStep.Runtime,
  AppInitializationStep.Configuration,
] as const;

export const StepStatus = {
  Complete: 'complete',
  Failed: 'failed',
  Running: 'running',
  Waiting: 'waiting',
} as const;
const statusKeys = {
  [StepStatus.Complete]: 'startupStepComplete',
  [StepStatus.Failed]: 'startupStepFailed',
  [StepStatus.Running]: 'startupStepRunning',
  [StepStatus.Waiting]: 'startupStepWaiting',
};
type Props = {
  state?: AppInitializationState;
  failed?: boolean;
  engineStatus?: OpenClawEngineStatus;
  engineError?: boolean;
  rendererStarted?: boolean;
  rendererReady?: boolean;
};

/** Main preparation, engine readiness and interface readiness have separate owners. */
export function startupStepStates({
  state,
  failed = false,
  engineStatus,
  engineError = false,
  rendererStarted = false,
  rendererReady = false,
}: Props) {
  const rendererFailed =
    failed &&
    (rendererStarted || (state?.failure && state.failure.source !== StartupFailureSource.Main));
  const steps = mainSteps.map((step, index) => ({
    step: step as string,
    status:
      index < (state?.completedSteps ?? 0)
        ? StepStatus.Complete
        : state?.step === step && !rendererFailed
          ? failed
            ? StepStatus.Failed
            : StepStatus.Running
          : StepStatus.Waiting,
  }));
  steps.push(
    {
      step: AppInitializationStep.Engine,
      status:
        engineError || engineStatus?.phase === EnginePhase.Error
          ? StepStatus.Failed
          : engineStatus?.phase === EnginePhase.Running
            ? StepStatus.Complete
            : engineStatus?.phase === EnginePhase.Starting
              ? StepStatus.Running
              : StepStatus.Waiting,
    },
    {
      step: 'interface',
      status: rendererFailed
        ? StepStatus.Failed
        : rendererReady
          ? StepStatus.Complete
          : rendererStarted
            ? StepStatus.Running
            : StepStatus.Waiting,
    },
  );
  return steps;
}

export default function StartupSteps(props: Props) {
  return (
    <ol className="startup-steps" aria-label={i18nService.t('startupSteps')}>
      {startupStepStates(props).map(({ step, status }) => {
        const completed = status === StepStatus.Complete;
        const current = status === StepStatus.Running || status === StepStatus.Failed;
        return (
          <li
            key={step}
            className="startup-step"
            aria-current={current ? 'step' : undefined}
            data-completed={completed}
            data-status={status}
          >
            <span className="startup-step-marker" aria-hidden="true">
              {completed ? '✓' : status === StepStatus.Failed ? '×' : '·'}
            </span>
            <span className="startup-step-name">{i18nService.t(`startupStep_${step}`)}</span>
            <span className="startup-step-status">{i18nService.t(statusKeys[status])}</span>
          </li>
        );
      })}
    </ol>
  );
}
