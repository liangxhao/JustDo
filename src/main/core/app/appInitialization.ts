import fs from 'fs';
import path from 'path';

import {
  AppInitializationPhase,
  type AppInitializationState,
  AppInitializationStep,
} from '../../../shared/app/initialization';

const INITIALIZED_MARKER = '.justdo-initialized';

/** Tracks actual startup milestones; no estimated percentages or installer probes. */
export class AppInitialization {
  private state: AppInitializationState;

  constructor(
    userDataPath: string,
    packagedWindows: boolean,
    private readonly onChanged: (state: AppInitializationState) => void,
  ) {
    this.state = {
      phase: AppInitializationPhase.Preparing,
      step: AppInitializationStep.UserData,
      firstLaunch: packagedWindows && !fs.existsSync(path.join(userDataPath, INITIALIZED_MARKER)),
      completedSteps: 0,
      totalSteps: 4,
      userDataPath,
    };
  }

  getState(): AppInitializationState {
    return { ...this.state };
  }

  advance(step: AppInitializationState['step'], completedSteps: number): void {
    this.state = { ...this.state, step, completedSteps };
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
    if (this.state.firstLaunch) {
      // This marker only avoids repeating the first-launch presentation. Its
      // failure must not block an already usable database/application shell.
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
    };
    this.onChanged(this.getState());
    console.info('[AppInitialization] Application shell ready:', this.getState());
  }

  fail(error: unknown): void {
    console.error('[AppInitialization] Startup failed:', this.getState(), error);
    this.state = {
      ...this.state,
      phase: AppInitializationPhase.Failed,
      error: error instanceof Error ? error.message : String(error),
    };
    this.onChanged(this.getState());
  }
}
