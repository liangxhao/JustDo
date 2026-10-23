import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  isWorkspaceFileClipboardWriteRequest,
  isWorkspaceFileMutationRequest,
  isWorkspaceFileMutationTarget,
  isWorkspaceFileName,
  isWorkspaceFilePasteRequest,
  isWorkspaceFilePasteTarget,
  normalizeWorkspaceRelativePath,
  type WorkspaceFileClipboardResult,
  type WorkspaceFileClipboardSnapshot,
  type WorkspaceFileClipboardWriteRequest,
  WorkspaceFileMutationKind,
  type WorkspaceFileMutationOutcome,
  type WorkspaceFileMutationPreparation,
  type WorkspaceFileMutationRequest,
  type WorkspaceFileMutationTarget,
  type WorkspaceFilePasteOutcome,
  type WorkspaceFilePastePreparation,
  type WorkspaceFilePasteRequest,
  type WorkspaceFilePasteTarget,
  WorkspaceFileTransferError,
  WorkspaceFileTransferMode,
  workspaceParentDirectory,
} from '../../../shared/preview/workspaceFiles';
import {
  WindowsFileClipboard,
  type WindowsFileIdentity,
  type WindowsFileMutationIdentity,
} from '../../core/filesystem/windowsFileClipboard';

interface InspectedPath {
  filePath: string;
  stats: fs.Stats;
  identity: WindowsFileIdentity;
}
interface PasteDestination {
  requestedRoot: string;
  root: InspectedPath;
  target: InspectedPath;
  revision: string;
}
type ClipboardBackend = Pick<WindowsFileClipboard, 'read' | 'write' | 'paste' | 'rename' | 'trash'>;
interface MutationSelection extends WorkspaceFileMutationPreparation {
  source?: InspectedPath;
  sourceIdentity?: WindowsFileMutationIdentity;
  filePath: string;
  relativePath: string;
  unchanged: boolean;
}
const sameIdentity = (left: WindowsFileIdentity, right: WindowsFileIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino;
const readIdentity = (filePath: string): WindowsFileIdentity => {
  const stats = fs.lstatSync(filePath, { bigint: true });
  return { dev: stats.dev.toString(), ino: stats.ino.toString() };
};
const isWithin = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
};
const inspectPath = (root: string, relativePath: string): InspectedPath => {
  let filePath = root;
  for (const part of normalizeWorkspaceRelativePath(relativePath).split('/').filter(Boolean)) {
    filePath = path.join(filePath, part);
    const stats = fs.lstatSync(filePath);
    if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile()))
      throw new Error('Workspace path must be a regular file or directory');
    if (!isWithin(root, fs.realpathSync(filePath))) throw new Error('Path is outside workspace');
  }
  return { filePath, stats: fs.lstatSync(filePath), identity: readIdentity(filePath) };
};
const failure = (error?: unknown): WorkspaceFileClipboardResult<never> => {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return {
    success: false,
    code:
      Object.values(WorkspaceFileTransferError).find(value => value === code) ??
      WorkspaceFileTransferError.Failed,
    error: error instanceof Error ? error.message : 'File clipboard operation failed',
  };
};

/** File contents, collision UI and copy/move execution belong to the OS Shell. */
export class WorkspaceFileOperations {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly resolveRoot: (sessionId: string) => string | null | undefined,
    private readonly clipboard: ClipboardBackend = new WindowsFileClipboard(),
  ) {}

  async read(): Promise<WorkspaceFileClipboardResult<WorkspaceFileClipboardSnapshot>> {
    try {
      return { success: true, value: await this.clipboard.read() };
    } catch (error) {
      return failure(error);
    }
  }

  async write(
    request: WorkspaceFileClipboardWriteRequest,
    isCurrent: () => boolean,
  ): Promise<WorkspaceFileClipboardResult<WorkspaceFileClipboardSnapshot>> {
    try {
      if (!isWorkspaceFileClipboardWriteRequest(request) || !isCurrent()) return failure();
      const destination = this.destination({ sessionId: request.sessionId, targetDirectory: '' });
      const source = inspectPath(destination.root.filePath, request.sourcePath);
      this.assertDestination(request.sessionId, destination, isCurrent);
      return { success: true, value: await this.clipboard.write([source.filePath], request.mode) };
    } catch (error) {
      return failure(error);
    }
  }

  async prepare(
    request: WorkspaceFilePasteTarget,
    isCurrent: () => boolean,
  ): Promise<WorkspaceFileClipboardResult<WorkspaceFilePastePreparation>> {
    try {
      if (!isWorkspaceFilePasteTarget(request) || !isCurrent()) return failure();
      const destination = this.destination(request);
      const clipboard = await this.clipboard.read();
      this.assertDestination(request.sessionId, destination, isCurrent);
      const affectedPaths = this.affectedPaths(clipboard, destination.target.filePath);
      return {
        success: true,
        value: { clipboard, affectedPaths, destinationRevision: destination.revision },
      };
    } catch (error) {
      return failure(error);
    }
  }

  async paste(
    request: WorkspaceFilePasteRequest,
    ownerHandle: string,
    isCurrent: () => boolean,
  ): Promise<WorkspaceFileClipboardResult<WorkspaceFilePasteOutcome>> {
    try {
      if (!isWorkspaceFilePasteRequest(request) || !isCurrent()) return failure();
      // Freeze the selected destination before the asynchronous clipboard read or queue.
      const destination = this.destination(request);
      if (destination.revision !== request.destinationRevision)
        return failure(new Error('Workspace changed'));
      const clipboard = await this.clipboard.read();
      this.assertDestination(request.sessionId, destination, isCurrent);
      if (clipboard.revision !== request.clipboardRevision)
        return { success: false, code: WorkspaceFileTransferError.ClipboardChanged };
      if (!clipboard.paths.length) return failure();
      this.affectedPaths(clipboard, destination.target.filePath);
      const selected = { ...clipboard, paths: [...clipboard.paths] };
      const operation = this.pending.then(async () => {
        this.assertDestination(request.sessionId, destination, isCurrent);
        // The adapter checks the clipboard revision again before native execution.
        return this.clipboard.paste(
          selected,
          destination.target.filePath,
          ownerHandle,
          destination.target.identity,
        );
      });
      this.pending = operation.catch((): void => {});
      return { success: true, value: await operation };
    } catch (error) {
      return failure(error);
    }
  }

  async prepareMutation(
    request: WorkspaceFileMutationTarget,
    isCurrent: () => boolean,
  ): Promise<WorkspaceFileClipboardResult<WorkspaceFileMutationPreparation>> {
    try {
      if (!isWorkspaceFileMutationTarget(request) || !isCurrent()) return failure();
      const selection = this.mutationSelection(request);
      return {
        success: true,
        value: {
          affectedPaths: selection.affectedPaths,
          revision: selection.revision,
          locationRevision: selection.locationRevision,
        },
      };
    } catch (error) {
      return failure(error);
    }
  }

  async mutate(
    request: WorkspaceFileMutationRequest,
    isCurrent: () => boolean,
  ): Promise<WorkspaceFileClipboardResult<WorkspaceFileMutationOutcome>> {
    try {
      if (!isWorkspaceFileMutationRequest(request) || !isCurrent()) return failure();
      const selection = this.mutationSelection(request);
      if (selection.revision !== request.revision) throw new Error('Workspace item changed');
      const operation = this.pending.then(async () => {
        if (!isCurrent()) throw new Error('Workspace window changed');
        // Confirmation and the shared operation queue may both outlive a selected
        // item. Resolve the workspace and identities again immediately before use.
        const current = this.mutationSelection(request);
        if (current.revision !== selection.revision) throw new Error('Workspace item changed');
        if (request.kind === WorkspaceFileMutationKind.CreateDirectory) {
          fs.mkdirSync(current.filePath);
        } else if (request.kind === WorkspaceFileMutationKind.Trash) {
          // The system adapter vetoes permanent deletion. Failure never falls
          // back to unlink/rm, including volumes without a recycle bin.
          await this.clipboard.trash(current.source!.filePath, current.sourceIdentity!);
        } else if (!current.unchanged) {
          await this.clipboard.rename(
            current.source!.filePath,
            request.newName,
            current.sourceIdentity!,
          );
        }
        return { relativePath: current.relativePath };
      });
      this.pending = operation.catch((): void => {});
      return { success: true, value: await operation };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') {
        return { success: false, code: WorkspaceFileTransferError.AlreadyExists };
      }
      return failure(error);
    }
  }

  private mutationSelection(request: WorkspaceFileMutationTarget): MutationSelection {
    const creating = request.kind === WorkspaceFileMutationKind.CreateDirectory;
    const relativePath = normalizeWorkspaceRelativePath(request.relativePath);
    const parent = creating ? relativePath : workspaceParentDirectory(relativePath);
    const destination = this.destination({ sessionId: request.sessionId, targetDirectory: parent });
    const source = creating ? undefined : inspectPath(destination.root.filePath, relativePath);
    const sourceIdentity = source && {
      ...source.identity,
      parentDev: destination.target.identity.dev,
      parentIno: destination.target.identity.ino,
    };
    const name = request.kind === WorkspaceFileMutationKind.Trash ? undefined : request.newName;
    const filePath = name ? path.join(destination.target.filePath, name) : source!.filePath;
    const unchanged = Boolean(source && path.basename(source.filePath) === name);
    if (name && (!source || path.relative(source.filePath, filePath) !== '')) {
      try {
        fs.lstatSync(filePath);
        throw Object.assign(new Error('An item with this name already exists'), {
          code: WorkspaceFileTransferError.AlreadyExists,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const revision = crypto
      .createHash('sha256')
      .update(
        JSON.stringify([destination.revision, request.kind, relativePath, name, sourceIdentity]),
      )
      .digest('hex');
    return {
      source,
      sourceIdentity,
      filePath,
      relativePath: name ? [parent, name].filter(Boolean).join('/') : relativePath,
      unchanged,
      affectedPaths: source && !unchanged ? [source.filePath] : [],
      revision,
      locationRevision: destination.revision,
    };
  }

  private destination(request: WorkspaceFilePasteTarget): PasteDestination {
    const requestedRoot = this.resolveRoot(request.sessionId);
    if (!requestedRoot) throw new Error('Workspace is unavailable');
    const rootPath = fs.realpathSync(requestedRoot);
    const root = {
      filePath: rootPath,
      stats: fs.statSync(rootPath),
      identity: readIdentity(rootPath),
    };
    const target = inspectPath(rootPath, request.targetDirectory);
    if (!root.stats.isDirectory() || !target.stats.isDirectory())
      throw new Error('Paste target must be a directory');
    const revision = crypto
      .createHash('sha256')
      .update(
        JSON.stringify([requestedRoot, rootPath, root.identity, target.filePath, target.identity]),
      )
      .digest('hex');
    return { requestedRoot, root, target, revision };
  }

  private assertDestination(
    sessionId: string,
    expected: PasteDestination,
    isCurrent: () => boolean,
  ): void {
    if (
      !isCurrent() ||
      this.resolveRoot(sessionId) !== expected.requestedRoot ||
      fs.realpathSync(expected.requestedRoot) !== expected.root.filePath ||
      !sameIdentity(expected.root.identity, readIdentity(expected.root.filePath))
    )
      throw new Error('Workspace changed');
    const current = inspectPath(
      expected.root.filePath,
      path.relative(expected.root.filePath, expected.target.filePath),
    );
    if (!sameIdentity(expected.target.identity, current.identity))
      throw new Error('Paste destination changed');
  }

  private affectedPaths(clipboard: WorkspaceFileClipboardSnapshot, target: string): string[] {
    if (clipboard.paths.length > 10_000) throw new Error('File clipboard is too large');
    const affected = new Set<string>();
    for (const source of clipboard.paths) {
      if (
        typeof source !== 'string' ||
        !path.isAbsolute(source) ||
        source.includes('\0') ||
        source.length > 32_768
      )
        throw new Error('Invalid file clipboard path');
      const sameParent = path.relative(path.dirname(source), target) === '';
      const targetName = path.basename(source);
      if (!isWorkspaceFileName(targetName)) throw new Error('Invalid file clipboard name');
      if (!sameParent) {
        try {
          // The Shell can merge into an existing destination. Refuse a linked
          // leaf here; native progress callbacks also guard nested destinations.
          inspectPath(target, targetName);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      if (clipboard.mode === WorkspaceFileTransferMode.Move && !sameParent) affected.add(source);
      // Keep potential target guards even for a stale file-drop reference: the
      // source may reappear before the native Shell starts the operation.
      if (!sameParent) affected.add(path.join(target, targetName));
      let canonical: string;
      let stats: fs.Stats;
      try {
        canonical = fs.realpathSync(source);
        stats = fs.statSync(canonical);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (!stats.isFile() && !stats.isDirectory()) throw new Error('Invalid file clipboard item');
      if (stats.isDirectory() && isWithin(canonical, target))
        throw Object.assign(new Error('Cannot paste a folder into itself'), {
          code: WorkspaceFileTransferError.InvalidTarget,
        });
      if (clipboard.mode === WorkspaceFileTransferMode.Move && !sameParent) {
        affected.add(canonical);
      }
    }
    return [...affected];
  }
}
