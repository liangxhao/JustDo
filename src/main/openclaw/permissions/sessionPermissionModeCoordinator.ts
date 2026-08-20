import type { PermissionMode } from '../../../shared/openclaw/approvals';
import type { CoworkStore } from '../../data/coworkStore';
import type { OpenClawEngineStatus } from '../runtime/openclawEngineManager';

interface SyncResult {
  success: boolean;
  changed: boolean;
  status?: OpenClawEngineStatus;
  error?: string;
}

interface CoordinatorDependencies {
  getCoworkStore: () => CoworkStore;
  syncOpenClawConfig: (options: {
    reason: string;
    restartGatewayIfRunning?: boolean;
  }) => Promise<SyncResult>;
  enqueue: <T>(task: () => Promise<T>) => Promise<T>;
}

export type PermissionModeOperationResult =
  | { success: true }
  | { success: false; error: string; status?: OpenClawEngineStatus };

export class SessionPermissionModeCoordinator {
  constructor(private readonly deps: CoordinatorDependencies) {}

  setSessionMode(
    sessionId: string,
    permissionMode: PermissionMode,
  ): Promise<PermissionModeOperationResult> {
    return this.deps.enqueue(async () => {
      const store = this.deps.getCoworkStore();
      const session = store.getSession(sessionId);
      if (!session) return { success: false, error: 'Session not found.' };

      return this.applyRuntimeMode(permissionMode, 'global-permission-change');
    });
  }

  private async applyRuntimeMode(
    permissionMode: PermissionMode,
    reason: string,
  ): Promise<PermissionModeOperationResult> {
    const store = this.deps.getCoworkStore();
    const previous = store.getConfig();
    if (previous.permissionMode === permissionMode) return { success: true };
    store.setConfig({ permissionMode });
    const sync = await this.deps.syncOpenClawConfig({
      reason,
      restartGatewayIfRunning: false,
    });
    if (sync.success) return { success: true };

    store.setConfig(previous);
    const rollback = await this.deps.syncOpenClawConfig({
      reason: `${reason}-rollback`,
      restartGatewayIfRunning: false,
    });
    return {
      success: false,
      error: rollback.success
        ? sync.error || 'Runtime permission synchronization failed.'
        : `Runtime permission synchronization and rollback failed: ${
            rollback.error || sync.error || 'unknown error'
          }`,
      status: rollback.status || sync.status,
    };
  }
}
