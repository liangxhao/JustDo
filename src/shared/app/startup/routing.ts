/** Data generation and completed application/native preparation determine the startup route. */
export const StartupRoute = {
  Fresh: 'fresh',
  Migration: 'migration',
  Upgrade: 'upgrade',
  Normal: 'normal',
} as const;
export type StartupRoute = (typeof StartupRoute)[keyof typeof StartupRoute];

export const StartupStage = {
  Backup: 'backup',
  UpgradePrepare: 'upgradePrepare',
  UpgradeVerify: 'upgradeVerify',
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
