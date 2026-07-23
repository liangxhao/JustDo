import type { SqliteStore } from '../data/sqliteStore';
import {
  BuiltinModelAccess,
  syncBuiltinModelProvider,
} from './builtinModelProvider';

type OpenClawConfigSyncResult = {
  success: boolean;
  error?: string;
};

type BuiltinModelLifecycleDependencies = {
  getStore: () => SqliteStore;
  syncOpenClawConfig: (options: { reason: string }) => Promise<OpenClawConfigSyncResult>;
  notifyModelsChanged: () => void;
};

export type BuiltinModelLifecycleResult = {
  applied: boolean;
  superseded: boolean;
};

export class BuiltinModelLifecycle {
  private generation = 0;
  private configSyncQueue: Promise<void> = Promise.resolve();

  constructor(private readonly dependencies: BuiltinModelLifecycleDependencies) {}

  refreshAfterLogin(): Promise<BuiltinModelLifecycleResult> {
    return this.refresh(BuiltinModelAccess.Enabled, 'auth-login');
  }

  refreshAfterLogout(): Promise<BuiltinModelLifecycleResult> {
    return this.refresh(BuiltinModelAccess.Disabled, 'auth-logout');
  }

  refreshAuthenticatedModels(reason = 'manual-refresh'): Promise<BuiltinModelLifecycleResult> {
    return this.refresh(BuiltinModelAccess.Enabled, reason);
  }

  private async refresh(
    access: BuiltinModelAccess,
    reason: string,
  ): Promise<BuiltinModelLifecycleResult> {
    const generation = ++this.generation;
    await syncBuiltinModelProvider(this.dependencies.getStore(), { access });
    if (generation !== this.generation) {
      return { applied: false, superseded: true };
    }

    let syncResult: OpenClawConfigSyncResult;
    try {
      syncResult = await this.enqueueOpenClawConfigSync(reason);
    } catch (error) {
      if (generation === this.generation) {
        this.dependencies.notifyModelsChanged();
      }
      throw error;
    }
    if (generation !== this.generation) {
      return { applied: false, superseded: true };
    }

    this.dependencies.notifyModelsChanged();
    if (!syncResult.success) {
      throw new Error(
        syncResult.error || `Failed to sync OpenClaw config after ${reason}`,
      );
    }

    return { applied: true, superseded: false };
  }

  private enqueueOpenClawConfigSync(reason: string): Promise<OpenClawConfigSyncResult> {
    const sync = this.configSyncQueue.then(() =>
      this.dependencies.syncOpenClawConfig({ reason }),
    );
    this.configSyncQueue = sync.then(
      (): void => undefined,
      (): void => undefined,
    );
    return sync;
  }
}
