export const SkillWorkshopIpc = {
  List: 'skills:workshop:list',
  Changes: 'skills:workshop:changes',
  Read: 'skills:workshop:read',
  Archive: 'skills:workshop:archive',
  Restore: 'skills:workshop:restore',
} as const;

export const SkillWorkshopAction = {
  Create: 'create',
  Patch: 'patch',
  WriteFile: 'write_file',
  RemoveFile: 'remove_file',
  Archive: 'archive',
  Restore: 'restore',
} as const;
export type SkillWorkshopAction = (typeof SkillWorkshopAction)[keyof typeof SkillWorkshopAction];
export const SkillWorkshopActor = {
  Agent: 'agent',
  Review: 'review',
  Curator: 'curator',
  User: 'user',
} as const;
export type SkillWorkshopActor = (typeof SkillWorkshopActor)[keyof typeof SkillWorkshopActor];

export interface SkillWorkshopChange {
  id: string;
  agentId: string;
  skillName: string;
  action: SkillWorkshopAction;
  actor: SkillWorkshopActor;
  summary: string;
  /** Snapshot BEFORE this change, for undo; never the requested restore target. */
  versionId?: string;
  sessionKey?: string;
  runId?: string;
  createdAtMs: number;
}
export interface SkillWorkshopSkill {
  name: string;
  description: string;
  updatedAtMs: number;
  sizeBytes: number;
  files: string[];
  useCount?: number;
  lastUsedAtMs?: number;
}
export interface SkillWorkshopHistory {
  name: string;
  /** A live skill may also have saved versions. */
  live: boolean;
  versions: { id: string; action: SkillWorkshopAction; createdAtMs: number }[];
}
export interface SkillWorkshopInventory {
  agentId: string;
  mode: 'off' | 'auto';
  root: string;
  skills: SkillWorkshopSkill[];
  archived: SkillWorkshopHistory[];
}
export interface SkillWorkshopReadInput {
  agentId: string;
  name: string;
  filePath?: string;
  versionId?: string;
}
export interface SkillWorkshopFile {
  name: string;
  filePath: string;
  content: string;
  files: string[];
}
export interface SkillWorkshopArchiveInput {
  agentId: string;
  name: string;
  reason?: string;
}
export interface SkillWorkshopRestoreInput {
  agentId: string;
  name: string;
  /** The product always restores an explicitly selected saved version. */
  versionId: string;
}
export interface SkillWorkshopChangesInput {
  agentId: string;
  limit?: number;
  beforeMs?: number;
}
export type SkillWorkshopResult<T> =
  { success: true; value: T } | { success: false; error: string };

export interface SkillWorkshopApi {
  list: (agentId: string) => Promise<SkillWorkshopResult<SkillWorkshopInventory>>;
  changes: (
    input: SkillWorkshopChangesInput,
  ) => Promise<SkillWorkshopResult<SkillWorkshopChange[]>>;
  read: (input: SkillWorkshopReadInput) => Promise<SkillWorkshopResult<SkillWorkshopFile>>;
  archive: (input: SkillWorkshopArchiveInput) => Promise<SkillWorkshopResult<SkillWorkshopChange>>;
  restore: (input: SkillWorkshopRestoreInput) => Promise<SkillWorkshopResult<SkillWorkshopChange>>;
}
