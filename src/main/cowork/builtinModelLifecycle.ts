import { BuiltinModelSyncReason } from '../../shared/builtinModels';
import type { SqliteStore } from '../data/sqliteStore';
import {
  BuiltinModelAccess,
  syncBuiltinModelProvider,
} from './builtinModelProvider';

type OpenClawConfigSyncResult = {
  success: boolean;
  configSynced?: boolean;
  error?: string;
};

type BuiltinModelLifecycleDependencies = {
  getStore: () => SqliteStore;
  syncOpenClawConfig: (options: { reason: string }) => Promise<OpenClawConfigSyncResult>;
  notifyModelsChanged: () => void;
};

export class BuiltinModelLifecycle {
  private generation = 0;
  private configSyncQueue: Promise<void> = Promise.resolve();

  constructor(private readonly dependencies: BuiltinModelLifecycleDependencies) {}

  refreshAfterLogin(): Promise<void> {
    return this.refresh(BuiltinModelAccess.Enabled, BuiltinModelSyncReason.AuthLogin);
  }

  refreshAfterLogout(): Promise<void> {
    return this.refresh(BuiltinModelAccess.Disabled, BuiltinModelSyncReason.AuthLogout);
  }

  private async refresh(
    access: BuiltinModelAccess,
    reason: string,
  ): Promise<void> {
    const generation = ++this.generation;
    await syncBuiltinModelProvider(this.dependencies.getStore(), { access });
    if (generation !== this.generation) {
      return;
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
      return;
    }

    this.dependencies.notifyModelsChanged();
    if (!syncResult.success) {
      if (syncResult.configSynced) {
        const gatewayError = syncResult.error || 'Gateway did not apply the updated model config';
        console.warn(
          `[BuiltinModelLifecycle] Model config was synced after ${reason}, but Gateway application failed: ${gatewayError}`,
        );
        return;
      }
      throw new Error(
        syncResult.error || `Failed to sync OpenClaw config after ${reason}`,
      );
    }
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
