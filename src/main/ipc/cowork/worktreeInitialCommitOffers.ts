import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { IpcMainInvokeEvent } from 'electron';

import type {
  WorktreeInitialCommitInput,
  WorktreeInitialCommitOffer,
  WorktreeInitialCommitResult,
} from '../../../shared/cowork/worktreeInitialCommit';
import {
  createProjectInitialCommit,
  inspectProjectInitialCommit,
  ProjectInitialCommitError,
} from '../../core/filesystem/projectInitialCommit';
import { t } from '../../core/i18n';
import { captureInitialDispatchLease } from './nativeSessionDispatch';

type PendingOffer = {
  id: string;
  cwd: string;
  sender: IpcMainInvokeEvent['sender'];
  lease: ReturnType<typeof captureInitialDispatchLease>;
  project: Awaited<ReturnType<typeof inspectProjectInitialCommit>>;
  busy: boolean;
};

/** The main document may confirm only the latest offer from its own rejected start. */
export class WorktreeInitialCommitOffers {
  private pending?: PendingOffer;
  private generation = 0;

  constructor(private readonly getWorkingDirectory: () => string) {}

  beginStart(): number {
    this.discard();
    return ++this.generation;
  }

  async open(
    event: IpcMainInvokeEvent,
    cwd: string,
    generation: number,
    isStartCurrent: () => boolean,
  ): Promise<WorktreeInitialCommitOffer | undefined> {
    const canOffer = () =>
      generation === this.generation && isStartCurrent() && this.isSelectedDirectory(cwd);
    if (!canOffer()) return;
    const project = await inspectProjectInitialCommit(cwd);
    if (!canOffer()) return;
    this.discard();
    const id = randomUUID();
    const lease = captureInitialDispatchLease(event, () => {
      if (this.pending?.id === id) this.discard();
    });
    this.pending = { id, cwd, sender: event.sender, lease, project, busy: false };
    return { id, projectRoot: project.projectRoot, files: project.files };
  }

  async confirm(event: IpcMainInvokeEvent, input: unknown): Promise<WorktreeInitialCommitResult> {
    const pending = this.pending;
    const confirmation = input as Partial<WorktreeInitialCommitInput> | null;
    const isCurrent = () =>
      this.pending === pending &&
      !!pending &&
      this.isOwner(pending, event) &&
      this.isSelectedDirectory(pending.cwd);
    if (!pending || pending.busy || !isCurrent() || confirmation?.id !== pending.id) {
      return { success: false, error: t('worktreeInitialCommitChanged') };
    }
    const paths = confirmation.paths;
    if (
      !Array.isArray(paths) ||
      paths.length > pending.project.files.length ||
      paths.some(file => typeof file !== 'string')
    ) {
      return { success: false, error: t('worktreeInitialCommitInvalidSelection') };
    }

    pending.busy = true;
    try {
      await createProjectInitialCommit(pending.project, paths, () => {
        if (!isCurrent()) throw new ProjectInitialCommitError('worktreeInitialCommitChanged');
      });
      if (this.pending === pending) this.discard();
      return { success: true };
    } catch (error) {
      const code =
        error instanceof ProjectInitialCommitError ? error.code : 'worktreeInitialCommitFailed';
      if (
        this.pending === pending &&
        (code === 'worktreeInitialCommitUnconfirmed' ||
          code === 'worktreeInitialCommitIndexRestoreFailed' ||
          code === 'worktreeInitialCommitAlreadyExists' ||
          code === 'worktreeInitialCommitChanged')
      )
        this.discard();
      return {
        success: false,
        error: t(code),
      };
    } finally {
      pending.busy = false;
    }
  }

  dismiss(event: IpcMainInvokeEvent, id: unknown): void {
    const pending = this.pending;
    if (pending && pending.id === id && this.isOwner(pending, event)) this.discard();
  }

  private isOwner(pending: PendingOffer, event: IpcMainInvokeEvent): boolean {
    return (
      pending.sender === event.sender &&
      pending.lease.isCurrent() &&
      event.senderFrame === event.sender.mainFrame
    );
  }

  private isSelectedDirectory(cwd: string): boolean {
    const selected = this.getWorkingDirectory().trim();
    return !!selected && path.resolve(selected) === cwd;
  }

  private discard(): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.lease.dispose();
  }
}
