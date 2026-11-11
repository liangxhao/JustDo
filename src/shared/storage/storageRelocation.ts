export const StorageRelocationIpc = {
  Status: 'storage:relocation:status',
  Prepare: 'storage:relocation:prepare',
  Commit: 'storage:relocation:commit',
  Discard: 'storage:relocation:discard',
  MaintenanceStatus: 'storage:maintenance:status',
  MaintenanceChanged: 'storage:maintenance:changed',
  MaintenanceRetry: 'storage:maintenance:retry',
  MaintenanceCancel: 'storage:maintenance:cancel',
} as const;

export type StorageRelocationError =
  | 'unavailable'
  | 'busy'
  | 'unsupported'
  | 'target-not-empty'
  | 'cancelled';
export type StorageRelocationResult<T> =
  { success: true; value: T } | { success: false; code: StorageRelocationError };
export type StorageRelocationStatus = {
  available: boolean;
  pending: boolean;
};
export type StorageRelocationPlan = { planId: string; sourcePath: string; targetPath: string };
export type StorageRelocationBlockers = {
  kind: 'file' | 'retirement';
  checking?: boolean;
  processes: Array<{ pid: number; name: string; appOwned: boolean }>;
};
export const StorageMaintenancePhase = {
  RetiringProcesses: 'retiring-processes',
  PreparingData: 'preparing-data',
  CopyingData: 'copying-data',
  PreparingDestination: 'preparing-destination',
  SwitchingLocation: 'switching-location',
} as const;
export type StorageMaintenancePhase = typeof StorageMaintenancePhase[keyof typeof StorageMaintenancePhase];
export type StorageMaintenanceStatus = {
  dataPath?: string;
  sourcePath?: string;
  targetPath?: string;
  error?: 'unavailable' | 'failed' | 'cancelled' | 'target-not-empty';
  errorDetail?: string;
  errorPath?: string;
  blocking?: StorageRelocationBlockers;
  phase?: StorageMaintenancePhase;
  canRetry: boolean;
  canCancel: boolean;
  language: 'zh' | 'en';
};
export type StorageRelocationApi = {
  status: () => Promise<StorageRelocationResult<StorageRelocationStatus>>;
  prepare: () => Promise<StorageRelocationResult<StorageRelocationPlan>>;
  commit: (planId: string) => Promise<StorageRelocationResult<null>>;
  discard: (planId: string) => Promise<StorageRelocationResult<null>>;
};
