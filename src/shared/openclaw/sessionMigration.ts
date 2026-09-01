export const OpenClawSessionMigrationIpc = {
  Plan: 'openclaw:sessionMigration:plan',
  Confirm: 'openclaw:sessionMigration:confirm',
  Progress: 'openclaw:sessionMigration:progress',
} as const;

export const OpenClawSessionMigrationPhase = {
  Planning: 'planning',
  AwaitingConfirmation: 'awaiting-confirmation',
  BackingUp: 'backing-up',
  Importing: 'importing',
  Inspecting: 'inspecting',
  Completed: 'completed',
  Cancelled: 'cancelled',
  Failed: 'failed',
} as const;

export type OpenClawSessionMigrationPhase =
  (typeof OpenClawSessionMigrationPhase)[keyof typeof OpenClawSessionMigrationPhase];

export type OpenClawSessionMigrationPlan = {
  required: boolean;
  planId?: string;
  sourceCount: number;
  agents: string[];
  dryRun?: {
    targetCount?: number;
    sessionCount?: number;
    transcriptCount?: number;
  };
  phase?: OpenClawSessionMigrationPhase;
  error?: string;
};

export type OpenClawSessionMigrationProgress = {
  phase: OpenClawSessionMigrationPhase;
  planId: string;
  completedSteps: number;
  totalSteps: number;
  backupPath?: string;
  receiptPath?: string;
  error?: string;
};

export type OpenClawSessionMigrationConfirmRequest = {
  planId: string;
  approved: boolean;
};

export type OpenClawSessionMigrationResult = {
  success: boolean;
  cancelled?: boolean;
  progress?: OpenClawSessionMigrationProgress;
  error?: string;
};
