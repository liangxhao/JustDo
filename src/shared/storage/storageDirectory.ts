export const UPGRADE_BACKUP_DIRECTORY = 'backups';

export const StorageDirectoryIpc = {
  Info: 'storage:directory:info',
  Scan: 'storage:directory:scan',
  Open: 'storage:directory:open',
  OpenConfig: 'storage:directory:openConfig',
  ClearBrowserCache: 'storage:directory:clearBrowserCache',
  UpgradeBackupStatus: 'storage:directory:upgradeBackupStatus',
  DeleteUpgradeBackup: 'storage:directory:deleteUpgradeBackup',
  CleanupStatus: 'storage:directory:cleanupStatus',
} as const;

export const StorageDirectoryCategory = {
  Native: 'native',
  Backups: 'backups',
  Cache: 'cache',
  Plugins: 'plugins',
  SpeechModels: 'speech-models',
  Other: 'other',
} as const;

export type StorageDirectoryCategoryId =
  (typeof StorageDirectoryCategory)[keyof typeof StorageDirectoryCategory];

export const StorageDirectoryError = {
  Unavailable: 'unavailable',
  Forbidden: 'forbidden',
  Busy: 'busy',
  NotReady: 'not-ready',
  Cancelled: 'cancelled',
  AccessDenied: 'access-denied',
  Locked: 'locked',
} as const;
export type StorageDirectoryError = (typeof StorageDirectoryError)[keyof typeof StorageDirectoryError];

export const StorageCleanupKind = { Backup: 'backup', Cache: 'cache' } as const;
export type StorageCleanupKind = (typeof StorageCleanupKind)[keyof typeof StorageCleanupKind];
export const StorageCleanupPhase = {
  Preparing: 'preparing',
  Confirming: 'confirming',
  Checking: 'checking',
  Removing: 'removing',
  Clearing: 'clearing',
  Completed: 'completed',
  Cancelled: 'cancelled',
  Failed: 'failed',
} as const;
export type StorageCleanupPhase = (typeof StorageCleanupPhase)[keyof typeof StorageCleanupPhase];
type StorageCleanupCounts = {
  sessionsCompleted?: number;
  sessionsTotal?: number;
};
/** Per-call owner observations. Only the final Main result establishes a terminal phase. */
export type StorageCleanupProgressUpdate = StorageCleanupCounts & {
  phase: Exclude<StorageCleanupPhase, 'completed' | 'cancelled' | 'failed'>;
};
export type StorageCleanupProgress = StorageCleanupCounts & {
  operationId: string;
  kind: StorageCleanupKind;
  phase: StorageCleanupPhase;
  errorCode?: StorageDirectoryError;
};

export type StorageDirectoryResult<T> =
  | { success: true; value: T }
  | { success: false; code: StorageDirectoryError };

export type StorageDirectoryInfo = { path: string; bootstrapPath?: string };
export type UpgradeBackupStatus = { exists: boolean; canDelete: boolean };

/** File lengths from a bounded metadata scan, not allocated disk blocks or a snapshot. */
export type StorageDirectoryUsage = {
  scannedAt: number;
  complete: boolean;
  totalBytes: number;
  categories: Array<{ id: StorageDirectoryCategoryId; bytes: number }>;
  skippedEntries: number;
  fileCount: number;
};

export type StorageDirectoryApi = {
  info: () => Promise<StorageDirectoryResult<StorageDirectoryInfo>>;
  scan: () => Promise<StorageDirectoryResult<StorageDirectoryUsage>>;
  open: () => Promise<StorageDirectoryResult<null>>;
  openConfig: () => Promise<StorageDirectoryResult<null>>;
  clearBrowserCache: () => Promise<StorageDirectoryResult<null>>;
  upgradeBackupStatus: () => Promise<StorageDirectoryResult<UpgradeBackupStatus>>;
  deleteUpgradeBackup: () => Promise<StorageDirectoryResult<null>>;
  cleanupStatus: () => Promise<StorageDirectoryResult<StorageCleanupProgress | null>>;
};
