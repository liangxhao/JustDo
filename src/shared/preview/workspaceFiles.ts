export const WorkspaceFilesIpc = {
  ReadClipboard: 'shell:readWorkspaceFileClipboard',
  WriteClipboard: 'shell:writeWorkspaceFileClipboard',
  PreparePaste: 'shell:prepareWorkspaceFilePaste',
  Paste: 'shell:pasteWorkspaceFiles',
  PrepareMutation: 'shell:prepareWorkspaceFileMutation',
  Mutate: 'shell:mutateWorkspaceFile',
} as const;

export const WorkspaceFileTransferMode = {
  Copy: 'copy',
  Move: 'move',
} as const;

export type WorkspaceFileTransferMode =
  (typeof WorkspaceFileTransferMode)[keyof typeof WorkspaceFileTransferMode];

export interface WorkspaceFileClipboardWriteRequest {
  sessionId: string;
  sourcePath: string;
  mode: WorkspaceFileTransferMode;
}

export interface WorkspaceFileClipboardSnapshot {
  paths: string[];
  mode: WorkspaceFileTransferMode;
  revision: string;
}

export interface WorkspaceFilePasteTarget {
  sessionId: string;
  targetDirectory: string;
}

export interface WorkspaceFilePastePreparation {
  clipboard: WorkspaceFileClipboardSnapshot;
  affectedPaths: string[];
  destinationRevision: string;
}

export interface WorkspaceFilePasteRequest extends WorkspaceFilePasteTarget {
  clipboardRevision: string;
  destinationRevision: string;
}

export interface WorkspaceFilePasteOutcome {
  cancelled: boolean;
  clipboard: WorkspaceFileClipboardSnapshot;
}

export const WorkspaceFileMutationKind = {
  Rename: 'rename',
  Trash: 'trash',
  CreateDirectory: 'create-directory',
} as const;

export type WorkspaceFileMutationTarget = { sessionId: string; relativePath: string } & (
  | { kind: typeof WorkspaceFileMutationKind.Rename; newName: string }
  | { kind: typeof WorkspaceFileMutationKind.Trash }
  | { kind: typeof WorkspaceFileMutationKind.CreateDirectory; newName: string }
);

export interface WorkspaceFileMutationPreparation {
  affectedPaths: string[];
  revision: string;
  locationRevision: string;
}

export type WorkspaceFileMutationRequest = WorkspaceFileMutationTarget & { revision: string };

export interface WorkspaceFileMutationOutcome {
  relativePath: string;
}

export const WorkspaceFileTransferError = {
  InvalidTarget: 'invalid-target',
  Unavailable: 'unavailable',
  ClipboardChanged: 'clipboard-changed',
  InvalidName: 'invalid-name',
  AlreadyExists: 'already-exists',
  Failed: 'failed',
} as const;

export type WorkspaceFileClipboardResult<T> =
  | { success: true; value: T }
  | {
      success: false;
      code: (typeof WorkspaceFileTransferError)[keyof typeof WorkspaceFileTransferError];
      error?: string;
    };

export const normalizeWorkspaceRelativePath = (value: string): string => value.replace(/\\/g, '/');

export const workspaceParentDirectory = (value: string): string => {
  const normalized = normalizeWorkspaceRelativePath(value);
  return normalized.slice(0, Math.max(0, normalized.lastIndexOf('/')));
};

export const isWorkspaceRelativePath = (
  candidate: unknown,
  allowRoot: boolean,
): candidate is string => {
  if (typeof candidate !== 'string' || candidate.length > 32_768) return false;
  if (candidate === '') return allowRoot;
  return !normalizeWorkspaceRelativePath(candidate)
    .split('/')
    .some(part => !isWorkspaceFileName(part));
};

export const isWorkspaceFilePasteTarget = (value: unknown): value is WorkspaceFilePasteTarget => {
  if (!value || typeof value !== 'object') return false;
  const target = value as WorkspaceFilePasteTarget;
  return (
    typeof target.sessionId === 'string' &&
    target.sessionId.trim().length > 0 &&
    target.sessionId.length <= 512 &&
    isWorkspaceRelativePath(target.targetDirectory, true)
  );
};

export const isWorkspaceFileClipboardWriteRequest = (
  value: unknown,
): value is WorkspaceFileClipboardWriteRequest => {
  if (!value || typeof value !== 'object') return false;
  const request = value as WorkspaceFileClipboardWriteRequest;
  return (
    isWorkspaceFilePasteTarget({ ...request, targetDirectory: '' }) &&
    isWorkspaceRelativePath(request.sourcePath, false) &&
    Object.values(WorkspaceFileTransferMode).includes(request.mode)
  );
};

export const isWorkspaceFilePasteRequest = (value: unknown): value is WorkspaceFilePasteRequest => {
  if (!isWorkspaceFilePasteTarget(value)) return false;
  const request = value as WorkspaceFilePasteRequest;
  return (
    typeof request.clipboardRevision === 'string' &&
    request.clipboardRevision.length > 0 &&
    request.clipboardRevision.length <= 128 &&
    typeof request.destinationRevision === 'string' &&
    request.destinationRevision.length > 0 &&
    request.destinationRevision.length <= 128
  );
};

/** A single Windows filename, never a path or a device/alternate stream name. */
export const isWorkspaceFileName = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.length <= 255 &&
  !/[<>:"/\\|?*\u0000-\u001f]/.test(value) &&
  !/[. ]$/.test(value) &&
  !/^(con|conin\$|conout\$|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\.|$)/i.test(value);

export const isWorkspaceFileMutationTarget = (
  value: unknown,
): value is WorkspaceFileMutationTarget => {
  if (!value || typeof value !== 'object') return false;
  const request = value as WorkspaceFileMutationTarget;
  return (
    isWorkspaceFilePasteTarget({ sessionId: request.sessionId, targetDirectory: '' }) &&
    Object.values(WorkspaceFileMutationKind).includes(request.kind) &&
    isWorkspaceRelativePath(
      request.relativePath,
      request.kind === WorkspaceFileMutationKind.CreateDirectory,
    ) &&
    (request.kind === WorkspaceFileMutationKind.Trash || isWorkspaceFileName(request.newName))
  );
};

export const isWorkspaceFileMutationRequest = (
  value: unknown,
): value is WorkspaceFileMutationRequest =>
  isWorkspaceFileMutationTarget(value) &&
  'revision' in value &&
  typeof value.revision === 'string' &&
  value.revision.length > 0 &&
  value.revision.length <= 128;
