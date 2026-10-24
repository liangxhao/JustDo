import fs from 'fs';
import path from 'path';

import {
  AppInitializationActivity,
  AppInitializationPhase,
  type AppInitializationState,
  AppInitializationStep,
  type StartupDowngradeConfirmation,
} from '../../../shared/app/initialization';
import { HistoryRecoveryKind } from '../../../shared/app/startup/history';
import {
  type StartupHistorySummary,
  StartupRoute,
  StartupStage,
} from '../../../shared/app/startup/routing';
import { captureStartupFailure, StartupFailureSource } from '../../../shared/app/startupFailure';
import { classifyHistoryFailure } from '../history/historyFailure';

const INITIALIZED_MARKER = '.justdo-initialized';
const MIGRATION_RESUME_PROGRESS: Partial<
  Record<
    StartupStage,
    {
      step: AppInitializationStep;
      activity: AppInitializationActivity;
      completed: number;
    }
  >
> = {
  [StartupStage.Initialize]: {
    step: AppInitializationStep.UserData,
    activity: AppInitializationActivity.UserDirectory,
    completed: 1,
  },
  [StartupStage.StageHistory]: {
    step: AppInitializationStep.History,
    activity: AppInitializationActivity.HistoryImport,
    completed: 4,
  },
  [StartupStage.ImportHistory]: {
    step: AppInitializationStep.History,
    activity: AppInitializationActivity.HistoryImport,
    completed: 4,
  },
  [StartupStage.RestoreMetadata]: {
    step: AppInitializationStep.History,
    activity: AppInitializationActivity.HistoryMetadata,
    completed: 4,
  },
  [StartupStage.Check]: {
    step: AppInitializationStep.Engine,
    activity: AppInitializationActivity.EngineStart,
    completed: 5,
  },
};

const UPGRADE_RESUME_PROGRESS: Partial<Record<StartupStage, {
  step: AppInitializationStep; activity: AppInitializationActivity; completed: number;
}>> = {
  [StartupStage.UpgradePrepare]: {
    step: AppInitializationStep.DatabaseUpgrade, activity: AppInitializationActivity.NativeInspect,
    completed: 0,
  },
  [StartupStage.UpgradeVerify]: {
    step: AppInitializationStep.DatabaseUpgrade, activity: AppInitializationActivity.NativeVerify,
    completed: 0,
  },
  [StartupStage.Check]: {
    // Every resumed process rechecks native facts before admitting the product Store.
    step: AppInitializationStep.DatabaseUpgrade, activity: AppInitializationActivity.NativeInspect,
    completed: 0,
  },
};

/** Tracks actual startup milestones; no estimated percentages or installer probes. */
export class AppInitialization {
  private state: AppInitializationState;

  constructor(
    userDataPath: string,
    route: StartupRoute,
    private readonly onChanged: (state: AppInitializationState) => void,
    private readonly getFailureContext: () => Record<string, string> = () => ({}),
    resumeStage?: StartupStage,
    entryStartedAt?: number,
  ) {
    const startedAt = entryStartedAt ?? Date.now();
    const resume = resumeStage ? (route === StartupRoute.Migration
      ? MIGRATION_RESUME_PROGRESS[resumeStage]
      : route === StartupRoute.Upgrade ? UPGRADE_RESUME_PROGRESS[resumeStage] : undefined) : undefined;
    this.state = {
      phase: AppInitializationPhase.Preparing,
      step:
        resume?.step ??
        (route === StartupRoute.Migration
          ? AppInitializationStep.Backup
          : route === StartupRoute.Upgrade ? AppInitializationStep.DatabaseUpgrade
            : AppInitializationStep.UserData),
      firstLaunch: route !== StartupRoute.Normal,
      route,
      completedSteps: resume?.completed ?? 0,
      totalSteps: route === StartupRoute.Migration ? 6 : route === StartupRoute.Upgrade ? 5 : 4,
      userDataPath,
      activity:
        resume?.activity ??
        (route === StartupRoute.Migration
          ? AppInitializationActivity.HistoryBackup
          : route === StartupRoute.Upgrade ? AppInitializationActivity.NativeInspect
            : AppInitializationActivity.UserDirectory),
      startedAt,
      activityStartedAt: startedAt,
      updatedAt: startedAt,
    };
  }

  getState(): AppInitializationState {
    return { ...this.state };
  }

  setDowngradeConfirmation(downgradeConfirmation: StartupDowngradeConfirmation | undefined): void {
    if (this.state.phase !== AppInitializationPhase.Preparing) return;
    const now = Date.now();
    this.state = { ...this.state, downgradeConfirmation, updatedAt: now,
      ...(this.state.downgradeConfirmation && !downgradeConfirmation ? { activityStartedAt: now } : {}) };
    this.onChanged(this.getState());
  }

  advance(step: AppInitializationState['step'], completedSteps: number): void {
    if (this.state.phase !== AppInitializationPhase.Preparing) return;
    const activities = {
      [AppInitializationStep.Backup]: AppInitializationActivity.HistoryBackup,
      [AppInitializationStep.DatabaseUpgrade]: AppInitializationActivity.NativeUpgrade,
      [AppInitializationStep.History]: AppInitializationActivity.HistoryImport,
      [AppInitializationStep.UserData]: AppInitializationActivity.UserDirectory,
      [AppInitializationStep.Runtime]: AppInitializationActivity.Python,
      [AppInitializationStep.Configuration]: AppInitializationActivity.StartupSettings,
      [AppInitializationStep.Engine]: AppInitializationActivity.EngineStart,
      [AppInitializationStep.Complete]: AppInitializationActivity.Finalize,
    };
    const now = Date.now();
    const completed =
      this.state.route === StartupRoute.Migration &&
      step !== AppInitializationStep.Backup &&
      step !== AppInitializationStep.History
        ? completedSteps + (step === AppInitializationStep.Engine ? 2 : 1)
        : this.state.route === StartupRoute.Upgrade && step !== AppInitializationStep.DatabaseUpgrade
          ? completedSteps + 1 : completedSteps;
    this.state = {
      ...this.state,
      step: completed >= this.state.completedSteps ? step : this.state.step,
      completedSteps: Math.max(this.state.completedSteps, completed),
      activity: activities[step],
      activityStartedAt: now,
      updatedAt: now,
    };
    this.onChanged(this.getState());
  }

  reportActivity(activity: AppInitializationActivity): void {
    if (this.state.phase !== AppInitializationPhase.Preparing || this.state.activity === activity)
      return;
    const now = Date.now();
    this.state = { ...this.state, activity, activityStartedAt: now, updatedAt: now };
    this.onChanged(this.getState());
  }

  setHistorySummary(historySummary: StartupHistorySummary, historyBackupPath?: string): void {
    this.state = { ...this.state, historySummary, historyBackupPath, updatedAt: Date.now() };
    this.onChanged(this.getState());
  }

  async prepareUserData(): Promise<void> {
    // Creating the real directory and opening the real database in initStore
    // establish suitability. Do not impose path, disk-reserve or probe-file rules.
    console.info('[AppInitialization] Preparing user data:', this.getState());
    await fs.promises.mkdir(this.state.userDataPath, { recursive: true });
  }

  async runOptionalTask(label: string, operation: () => Promise<unknown>): Promise<void> {
    const context = { step: this.state.step, userDataPath: this.state.userDataPath };
    try {
      await operation();
    } catch (error) {
      console.error(
        '[AppInitialization] Optional startup task failed; continuing:',
        label,
        context,
        error,
      );
    }
  }

  async complete(): Promise<void> {
    if (this.state.route === StartupRoute.Fresh || this.state.route === StartupRoute.Migration) {
      // Retain the old presentation receipt for existing tooling. Route admission
      // uses the data generation; failure cannot block an already usable shell.
      await this.runOptionalTask('remember initialization', () =>
        fs.promises.writeFile(
          path.join(this.state.userDataPath, INITIALIZED_MARKER),
          'ready\n',
          'utf8',
        ),
      );
    }
    this.state = {
      ...this.state,
      phase: AppInitializationPhase.Ready,
      step: AppInitializationStep.Complete,
      completedSteps: this.state.totalSteps,
      updatedAt: Date.now(),
    };
    this.onChanged(this.getState());
    console.info('[AppInitialization] Application shell ready:', this.getState());
  }

  fail(error: unknown): void {
    console.error('[AppInitialization] Startup failed:', this.getState(), error);
    const failure = captureStartupFailure(StartupFailureSource.Main, error, {
      ...this.getFailureContext(),
      step: this.state.step,
      activity: this.state.activity,
      userDataPath: this.state.userDataPath,
      startedAt: new Date(this.state.startedAt).toISOString(),
    });
    const recovery = classifyHistoryFailure(error);
    this.state = {
      ...this.state,
      phase: AppInitializationPhase.Failed,
      error: failure.error.message,
      failure,
      ...(this.state.route === StartupRoute.Migration || recovery !== HistoryRecoveryKind.Other
        ? { historyRecovery: recovery }
        : {}),
      updatedAt: failure.occurredAt,
    };
    this.onChanged(this.getState());
  }
}
