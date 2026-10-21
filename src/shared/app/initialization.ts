import type { StartupFailure } from './startupFailure';
import type { WindowAppearance } from './windowAppearance';

export const AppInitializationIpc = {
  GetState: 'app:initialization:getState',
  Changed: 'app:initialization:changed',
  Relaunch: 'app:initialization:relaunch',
} as const;

export const INITIALIZATION_WINDOW_ARGUMENT = '--initialization-window';
export const FIRST_LAUNCH_WINDOW_ARGUMENT = '--startup-first-launch';

export function initializationWindowArguments(firstLaunch: boolean, transient = false): string[] {
  return [
    ...(transient ? [INITIALIZATION_WINDOW_ARGUMENT] : []),
    ...(firstLaunch ? [FIRST_LAUNCH_WINDOW_ARGUMENT] : []),
  ];
}

export type AppInitializationWindowContext = {
  readonly isTransientWindow: boolean;
  /** Frozen by Main for this app process, including after the marker is written. */
  readonly firstLaunch: boolean;
  readonly appearance: WindowAppearance;
};

export const AppInitializationPhase = {
  Preparing: 'preparing',
  Ready: 'ready',
  Failed: 'failed',
} as const;

export const AppInitializationStep = {
  UserData: 'userData',
  Runtime: 'runtime',
  Configuration: 'configuration',
  Engine: 'engine',
  Complete: 'complete',
} as const;

export const AppInitializationActivity = {
  UserDirectory: 'userDirectory',
  Database: 'database',
  Python: 'python',
  StartupSettings: 'startupSettings',
  LocalServices: 'localServices',
  Network: 'network',
  ModelAccess: 'modelAccess',
  Integrations: 'integrations',
  Workspace: 'workspace',
  DefaultFiles: 'defaultFiles',
  EngineStart: 'engineStart',
  Finalize: 'finalize',
} as const;

export type AppInitializationActivity =
  (typeof AppInitializationActivity)[keyof typeof AppInitializationActivity];

export type AppInitializationState = {
  phase: (typeof AppInitializationPhase)[keyof typeof AppInitializationPhase];
  step: (typeof AppInitializationStep)[keyof typeof AppInitializationStep];
  firstLaunch: boolean;
  completedSteps: number;
  totalSteps: number;
  userDataPath: string;
  activity: AppInitializationActivity;
  startedAt: number;
  activityStartedAt: number;
  updatedAt: number;
  error?: string;
  failure?: StartupFailure;
};
