import type { HistoryRecoveryKind } from './startup/history';
import {
  STARTUP_CLOCK_ARGUMENT,
  STARTUP_ROUTE_ARGUMENT,
  type StartupHistorySummary,
  type StartupRoute,
} from './startup/routing';
import type { StartupFailure } from './startupFailure';
import type { WindowAppearance } from './windowAppearance';

export const AppInitializationIpc = {
  GetState: 'app:initialization:getState',
  Changed: 'app:initialization:changed',
  Relaunch: 'app:initialization:relaunch',
  ConfirmDowngrade: 'app:initialization:confirmDowngrade',
} as const;

export const INITIALIZATION_WINDOW_ARGUMENT = '--initialization-window';
export const FIRST_LAUNCH_WINDOW_ARGUMENT = '--startup-first-launch';

export function initializationWindowArguments(
  firstLaunch: boolean,
  transient = false,
  presentation?: { route?: StartupRoute; entryStartedAt?: number },
): string[] {
  return [
    ...(transient ? [INITIALIZATION_WINDOW_ARGUMENT] : []),
    ...(firstLaunch ? [FIRST_LAUNCH_WINDOW_ARGUMENT] : []),
    ...(presentation?.route ? [`${STARTUP_ROUTE_ARGUMENT}${presentation.route}`] : []),
    ...(presentation?.entryStartedAt
      ? [`${STARTUP_CLOCK_ARGUMENT}${presentation.entryStartedAt}`]
      : []),
  ];
}

export type AppInitializationWindowContext = {
  readonly isTransientWindow: boolean;
  /** Frozen by Main for this app process, including after the marker is written. */
  readonly firstLaunch: boolean;
  readonly route?: StartupRoute;
  readonly entryStartedAt?: number;
  readonly appearance: WindowAppearance;
};

export const AppInitializationPhase = {
  Preparing: 'preparing',
  Ready: 'ready',
  Failed: 'failed',
} as const;

export const AppInitializationStep = {
  DatabaseUpgrade: 'databaseUpgrade',
  Backup: 'backup',
  History: 'history',
  UserData: 'userData',
  Runtime: 'runtime',
  Configuration: 'configuration',
  Engine: 'engine',
  Complete: 'complete',
} as const;
export type AppInitializationStep =
  (typeof AppInitializationStep)[keyof typeof AppInitializationStep];

export const AppInitializationActivity = {
  NativeInspect: 'nativeInspect',
  NativeBackup: 'nativeBackup',
  NativeUpgrade: 'nativeUpgrade',
  NativeVerify: 'nativeVerify',
  HistoryBackup: 'historyBackup',
  HistoryImport: 'historyImport',
  HistoryMetadata: 'historyMetadata',
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

export type StartupDowngradeConfirmation = {
  requestId: string;
  source: { appVersion: string; runtimeVersion: string };
  target: { appVersion: string; runtimeVersion: string };
};

export type AppInitializationState = {
  phase: (typeof AppInitializationPhase)[keyof typeof AppInitializationPhase];
  step: (typeof AppInitializationStep)[keyof typeof AppInitializationStep];
  firstLaunch: boolean;
  route?: StartupRoute;
  historySummary?: StartupHistorySummary;
  historyBackupPath?: string;
  historyRecovery?: HistoryRecoveryKind;
  completedSteps: number;
  totalSteps: number;
  userDataPath: string;
  activity: AppInitializationActivity;
  startedAt: number;
  activityStartedAt: number;
  updatedAt: number;
  error?: string;
  failure?: StartupFailure;
  downgradeConfirmation?: StartupDowngradeConfirmation;
};
