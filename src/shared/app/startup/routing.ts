/** Data generations, never installer/application version comparisons. */
export const StartupRoute = {
  Fresh: 'fresh',
  Migration: 'migration',
  Normal: 'normal',
} as const;
export type StartupRoute = (typeof StartupRoute)[keyof typeof StartupRoute];

export const StartupStage = {
  Backup: 'backup',
  Isolate: 'isolate',
  Initialize: 'initialize',
  StageHistory: 'stageHistory',
  ImportHistory: 'importHistory',
  RestoreMetadata: 'restoreMetadata',
  Check: 'check',
  Complete: 'complete',
} as const;
export type StartupStage = (typeof StartupStage)[keyof typeof StartupStage];

export type StartupHistorySummary = {
  conversations: number;
  cachedConversations: number;
  unavailableConversations: number;
  nativeSessions: number;
  missingTranscripts: number;
  unavailableWorkspaces?: number;
};

export const STARTUP_ROUTE_ARGUMENT = '--startup-route=';
export const STARTUP_CLOCK_ARGUMENT = '--startup-entry-at=';
