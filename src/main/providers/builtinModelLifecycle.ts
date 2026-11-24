import { BuiltinModelSyncReason } from '../../shared/providers/builtinModels';
import type { SqliteStore } from '../data/sqliteStore';
import {
  BuiltinModelAuthDiagnosticEvent,
  BuiltinModelAuthDiagnosticReason,
  getBuiltinModelAuthErrorCode,
  writeBuiltinModelAuthDiagnostic,
} from './builtinModelAuthDiagnostics';
import {
  BuiltinModelAccess,
  syncBuiltinModelProvider,
} from './builtinModelProvider';

type OpenClawConfigSyncResult = {
  success: boolean;
  configSynced?: boolean;
  gatewayRestartDeferred?: true;
  hostPolicyVerified?: boolean;
  error?: string;
};

type BuiltinModelLifecycleDependencies = {
  getStore: () => SqliteStore;
  syncOpenClawConfig: (options: { reason: string }) => Promise<OpenClawConfigSyncResult>;
  notifyCatalogChanged: () => void;
  notifyRuntimeModelsChanged: () => void;
};

export class BuiltinModelLifecycle {
  private generation = 0;
  private configSyncQueue: Promise<void> = Promise.resolve();
  private logoutCatalog: Promise<void> | null = null;

  constructor(private readonly dependencies: BuiltinModelLifecycleDependencies) {}

  refreshAfterLogin(): Promise<void> {
    return this.refresh(BuiltinModelAccess.Enabled, BuiltinModelSyncReason.AuthLogin);
  }

  refreshAfterLogout(): Promise<void> {
    return this.refresh(BuiltinModelAccess.Disabled, BuiltinModelSyncReason.AuthLogout);
  }

  async waitForLogoutCatalog(): Promise<void> {
    await this.logoutCatalog;
  }

  refreshAfterCredentialRotation(): Promise<void> {
    // Credential publication must not supersede a catalog refresh that still
    // owes its final provider projection after model discovery completes.
    return this.applyConfig(this.generation, BuiltinModelSyncReason.AuthLogin, true);
  }

  private async refresh(
    access: BuiltinModelAccess,
    reason: string,
  ): Promise<void> {
    const generation = ++this.generation;
    const catalog = syncBuiltinModelProvider(this.dependencies.getStore(), { access });
    if (access === BuiltinModelAccess.Disabled) this.logoutCatalog = catalog;
    await catalog;
    if (this.logoutCatalog === catalog) this.logoutCatalog = null;
    if (generation !== this.generation) {
      return;
    }
    this.dependencies.notifyCatalogChanged();
    await this.applyConfig(generation, reason);
  }

  private async applyConfig(
    generation: number,
    reason: string,
    requireApplication = false,
  ): Promise<void> {
    let syncResult: OpenClawConfigSyncResult;
    try {
      syncResult = await this.enqueueOpenClawConfigSync(reason);
    } catch (error) {
      writeBuiltinModelAuthDiagnostic('warn', BuiltinModelAuthDiagnosticEvent.ConfigSyncFailed, {
        generation, requireApplication,
        reason: BuiltinModelAuthDiagnosticReason.ConfigApplicationFailed,
        errorCode: getBuiltinModelAuthErrorCode(error),
      });
      throw error;
    }
    if (generation !== this.generation) return;

    const projectionConfirmed = reason === BuiltinModelSyncReason.AuthLogout
      ? syncResult.configSynced
      : syncResult.hostPolicyVerified;
    if (syncResult.success && projectionConfirmed && !syncResult.gatewayRestartDeferred) {
      this.dependencies.notifyRuntimeModelsChanged();
    }
    if (!syncResult.success) writeBuiltinModelAuthDiagnostic('warn', BuiltinModelAuthDiagnosticEvent.ConfigSyncFailed, {
      generation, requireApplication, configSynced: syncResult.configSynced === true,
      reason: BuiltinModelAuthDiagnosticReason.ConfigApplicationFailed,
    });
    if (!syncResult.success) {
      if (syncResult.configSynced && !requireApplication) {
        return;
      }
      throw new Error(
        syncResult.error || `Failed to sync OpenClaw config after ${reason}`,
      );
    }
  }

  private enqueueOpenClawConfigSync(reason: string): Promise<OpenClawConfigSyncResult> {
    const sync = this.configSyncQueue.then(() => this.dependencies.syncOpenClawConfig({ reason }));
    this.configSyncQueue = sync.then(
      (): void => undefined,
      (): void => undefined,
    );
    return sync;
  }
}
