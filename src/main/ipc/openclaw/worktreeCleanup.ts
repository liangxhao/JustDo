import {
  type WorktreeCleanResult,
  type WorktreeCleanupReceipt,
  WorktreeCleanupState,
} from '../../../shared/openclaw/worktrees';
import { t } from '../../core/i18n';

type GatewayOwner = { manager: object; generation: number; running: boolean };
interface CleanupDependencies {
  request: (params: { jobId?: string }) => Promise<unknown>;
  owner: () => GatewayOwner;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
}

const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

function parseReceipt(value: unknown): WorktreeCleanupReceipt {
  const receipt = value as Partial<WorktreeCleanupReceipt> | null;
  if (
    !receipt ||
    typeof receipt.jobId !== 'string' ||
    !receipt.jobId.trim() ||
    !Object.values(WorktreeCleanupState).includes(receipt.state as never) ||
    !Array.isArray(receipt.removed) ||
    receipt.removed.some(id => typeof id !== 'string') ||
    !isCount(receipt.orphansDeleted) ||
    !isCount(receipt.snapshotsPruned) ||
    (receipt.error !== undefined && receipt.error !== null && typeof receipt.error !== 'string')
  ) {
    throw new Error(t('worktreeCleanupUnconfirmed'));
  }
  return receipt as WorktreeCleanupReceipt;
}

/** One native maintenance submission; every later request only observes its receipt. */
export class WorktreeCleanupCoordinator {
  private pending?: { owner: GatewayOwner; jobId?: string };
  private inFlight?: Promise<WorktreeCleanResult>;

  constructor(private readonly deps: CleanupDependencies) {}

  clean(): Promise<WorktreeCleanResult> {
    if (this.inFlight) return this.inFlight;
    const task = this.observe().finally(() => {
      if (this.inFlight === task) this.inFlight = undefined;
    });
    this.inFlight = task;
    return task;
  }

  private assertOwner(expected: GatewayOwner): void {
    const current = this.deps.owner();
    if (
      current.manager !== expected.manager ||
      current.generation !== expected.generation ||
      !current.running
    )
      throw new Error(t('worktreeCleanupUnconfirmed'));
  }

  private async observe(): Promise<WorktreeCleanResult> {
    const now = this.deps.now ?? Date.now;
    const wait =
      this.deps.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    const deadline = now() + (this.deps.timeoutMs ?? 90_000);
    const retained = this.pending;
    if (retained && !retained.jobId) throw new Error(t('worktreeCleanupUnconfirmed'));
    const owner = retained?.owner ?? this.deps.owner();
    if (!owner.running || !Number.isSafeInteger(owner.generation) || owner.generation <= 0) {
      throw new Error(t('worktreeCleanupUnavailable'));
    }
    this.assertOwner(owner);
    // Record custody before submitting: a lost first reply cannot authorize a second submission.
    const pending: { owner: GatewayOwner; jobId?: string } = retained ?? { owner };
    this.pending = pending;
    for (;;) {
      this.assertOwner(owner);
      if (now() >= deadline) throw new Error(t('worktreeCleanupUnconfirmed'));
      let value: unknown;
      try {
        value = await this.deps.request(pending.jobId ? { jobId: pending.jobId } : {});
      } catch {
        throw new Error(t('worktreeCleanupUnconfirmed'));
      }
      this.assertOwner(owner);
      const receipt = parseReceipt(value);
      if (pending.jobId && receipt.jobId !== pending.jobId) {
        throw new Error(t('worktreeCleanupUnconfirmed'));
      }
      pending.jobId = receipt.jobId;
      if (receipt.state === WorktreeCleanupState.Completed) {
        this.pending = undefined;
        return {
          jobId: receipt.jobId,
          state: WorktreeCleanupState.Completed,
          removed: receipt.removed,
          orphansDeleted: receipt.orphansDeleted,
          snapshotsPruned: receipt.snapshotsPruned,
        };
      }
      if (receipt.state === WorktreeCleanupState.Failed) {
        this.pending = undefined;
        throw new Error(receipt.error || t('worktreeCleanupFailed'));
      }
      if (now() >= deadline) throw new Error(t('worktreeCleanupUnconfirmed'));
      await wait(Math.min(500, deadline - now()));
    }
  }
}
