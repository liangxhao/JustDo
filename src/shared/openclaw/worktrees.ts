export const WorktreeIpc = {
  List: 'openclaw:worktrees:list',
  Restore: 'openclaw:worktrees:restore',
  Remove: 'openclaw:worktrees:remove',
  Clean: 'openclaw:worktrees:clean',
  Settings: 'openclaw:worktrees:settings',
  SaveSettings: 'openclaw:worktrees:saveSettings',
} as const;

export interface ManagedWorktree {
  id: string;
  name: string;
  repoRoot: string;
  path: string;
  branch: string;
  ownerKind: 'manual' | 'workboard' | 'session';
  ownerId?: string;
  lastActiveAt: number;
  removedAt?: number;
  snapshotRef?: string;
  runEndCleanup?: { outcome: string; reason?: string };
}

export type WorktreeResult<T> = { success: true; value: T } | { success: false; error: string };
export type WorktreeRemoveResult = { removed: boolean; snapshotError?: string };
export type WorktreeCleanResult = { removed: string[]; orphansDeleted: number; snapshotsPruned: number };

export interface WorktreeSettings {
  root: string | null;
  effectiveRoot: string;
  acceleration: boolean;
  revision: string;
  applied: boolean;
}

export interface WorktreeSettingsUpdate {
  root: string | null;
  acceleration: boolean;
  revision: string;
}

export type WorktreeSettingsErrorCode =
  | 'invalid' | 'configuration' | 'conflict' | 'forbidden' | 'unavailable' | 'busy' | 'unknown';
export type WorktreeSettingsResult =
  | { success: true; value: WorktreeSettings }
  | { success: false; code: WorktreeSettingsErrorCode };
