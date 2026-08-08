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

  acquireForTurn(permissionMode: PermissionMode): Promise<PermissionModeOperationResult> {
    return this.deps.enqueue(async () => {
      const applied = await this.applyRuntimeMode(permissionMode, 'session-turn-permission');
      if ('error' in applied) return applied;
      return { success: true };
    });
  }

  setSessionMode(
    sessionId: string,
    permissionMode: PermissionMode,
  ): Promise<PermissionModeOperationResult> {
    return this.deps.enqueue(async () => {
      const store = this.deps.getCoworkStore();
      const session = store.getSession(sessionId);
      if (!session) return { success: false, error: 'Session not found.' };

      const previousRuntimeMode = store.getConfig().permissionMode;
      const applied = await this.applyRuntimeMode(permissionMode, 'session-permission-change');
      if ('error' in applied) return applied;

      try {
        store.updateSession(sessionId, { permissionMode });
        return { success: true };
      } catch (error) {
        const rollback = await this.applyRuntimeMode(
          previousRuntimeMode,
          'session-permission-persistence-rollback',
        );
        return {
          success: false,
          error:
            'error' in rollback
              ? `Session permission persistence and runtime rollback failed: ${
                  rollback.error || String(error)
                }`
              : error instanceof Error
                ? error.message
                : 'Failed to persist session permission mode.',
          ...('error' in rollback && rollback.status ? { status: rollback.status } : {}),
        };
      }
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
