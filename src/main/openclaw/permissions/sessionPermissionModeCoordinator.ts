import type { PermissionMode } from '../../../shared/openclaw/approvals';
import type { CoworkStore } from '../../data/coworkStore';

interface CoordinatorDependencies {
  getCoworkStore: () => CoworkStore;
  isSessionActive: (sessionId: string) => boolean;
  prepareSession: (options: {
    sessionId: string;
    permissionMode: PermissionMode;
    workspaceRoot: string;
    agentId: string;
  }) => Promise<void>;
}

export type PermissionModeOperationResult =
  | { success: true; deferred?: boolean }
  | { success: false; error: string };

export class SessionPermissionModeCoordinator {
  private static readonly RETRY_DELAY_MS = 3_000;
  private readonly tails = new Map<string, Promise<void>>();
  private readonly pendingSessionIds = new Set<string>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: CoordinatorDependencies) {}

  setSessionMode(
    sessionId: string,
    permissionMode: PermissionMode,
    options: { deferIfActive?: boolean } = {},
  ): Promise<PermissionModeOperationResult> {
    return this.enqueue(sessionId, async () => {
      const store = this.deps.getCoworkStore();
      const session = store.getSession(sessionId);
      if (!session) return { success: false, error: 'Session not found.' };

      try {
        if (session.permissionMode !== permissionMode) {
          store.updateSession(sessionId, { permissionMode });
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to save the permission mode.',
        };
      }

      if (this.deps.isSessionActive(sessionId)) {
        this.pendingSessionIds.add(sessionId);
        return options.deferIfActive
          ? { success: true, deferred: true }
          : { success: false, error: 'The previous run is still active.' };
      }

      return this.applyStoredSessionMode(sessionId, options.deferIfActive === true);
    });
  }

  applyPendingSessionMode(sessionId: string): Promise<PermissionModeOperationResult> {
    return this.enqueue(sessionId, async () => {
      if (!this.pendingSessionIds.has(sessionId)) return { success: true };
      if (this.deps.isSessionActive(sessionId)) {
        this.scheduleRetry(sessionId);
        return { success: true, deferred: true };
      }
      return this.applyStoredSessionMode(sessionId, true);
    });
  }

  prepareSessionForRun(sessionId: string): Promise<PermissionModeOperationResult> {
    return this.enqueue(sessionId, async () => {
      if (this.deps.isSessionActive(sessionId)) {
        return { success: false, error: 'The previous run is still active.' };
      }
      return this.applyStoredSessionMode(sessionId, false);
    });
  }

  private async applyStoredSessionMode(
    sessionId: string,
    deferOnFailure: boolean,
  ): Promise<PermissionModeOperationResult> {
    const session = this.deps.getCoworkStore().getSession(sessionId);
    if (!session) {
      this.pendingSessionIds.delete(sessionId);
      this.clearRetry(sessionId);
      return { success: false, error: 'Session not found.' };
    }

    try {
      await this.deps.prepareSession({
        sessionId,
        permissionMode: session.permissionMode,
        workspaceRoot: session.cwd,
        agentId: session.agentId,
      });
      this.pendingSessionIds.delete(sessionId);
      this.clearRetry(sessionId);
      return { success: true };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'OpenClaw session permission synchronization failed.';
      this.pendingSessionIds.add(sessionId);
      if (deferOnFailure) this.scheduleRetry(sessionId);
      return deferOnFailure ? { success: true, deferred: true } : { success: false, error: message };
    }
  }

  private scheduleRetry(sessionId: string): void {
    if (this.retryTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(sessionId);
      void this.applyPendingSessionMode(sessionId);
    }, SessionPermissionModeCoordinator.RETRY_DELAY_MS);
    timer.unref?.();
    this.retryTimers.set(sessionId, timer);
  }

  private clearRetry(sessionId: string): void {
    const timer = this.retryTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(sessionId);
  }

  private enqueue<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    const result = previous.catch((): void => undefined).then(task);
    const tail = result.then(
      (): void => undefined,
      (): void => undefined,
    );
    this.tails.set(sessionId, tail);
    void tail.finally(() => {
      if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId);
    });
    return result;
  }
}
