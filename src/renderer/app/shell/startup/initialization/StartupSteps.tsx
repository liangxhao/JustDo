import {
  type AppInitializationState,
  AppInitializationStep,
  AppInitializationTask,
  AppInitializationTaskStatus,
} from '@shared/app/initialization';
import { StartupFailureSource } from '@shared/app/startupFailure';
import { EnginePhase, type OpenClawEngineStatus } from '@shared/openclaw/engineStatus';

import { i18nService } from '@/services/i18n';

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

/** Every ordinary-startup task reports its own state; task order never implies readiness. */
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
    (state?.failure ? state.failure.source !== StartupFailureSource.Main : rendererStarted);
  const mainTask = (task: AppInitializationTask) => ({
    step: task,
    status: state?.tasks?.[task] ?? AppInitializationTaskStatus.Waiting,
  });
  return [
    mainTask(AppInitializationTask.UserData),
    mainTask(AppInitializationTask.Configuration),
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
    mainTask(AppInitializationTask.Integrations),
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
  ];
}

export default function StartupSteps(props: Props) {
  return (
    <ol className="startup-steps" aria-label={i18nService.t('startupSteps')}>
      {startupStepStates(props).map(({ step, status }) => {
        const completed = status === StepStatus.Complete;
        return (
          <li
            key={step}
            className="startup-step"
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
