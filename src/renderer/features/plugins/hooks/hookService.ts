import { PluginKind } from '@shared/plugins/marketplace';
import { PluginOperationAction, PluginOperationStage } from '@shared/plugins/pluginOperation';

import { HookEntry, HookListResult } from '@/features/plugins/hooks/hook';
import {
  pluginOperationFailure,
  pluginOperationRefreshFailure,
} from '@/features/plugins/shared/pluginMutationFeedback';
import {
  pluginSourceLabel,
  startPluginOperation,
} from '@/features/plugins/shared/pluginOperationService';
import { i18nService } from '@/services/i18n';

type GatewayHookEntry = Omit<HookEntry, 'id' | 'enabled'> & {
  hookKey?: string;
  disabled?: boolean;
  enabledByConfig?: boolean;
};

type GatewayHookListResult = Omit<HookListResult, 'hooks'> & {
  hooks?: GatewayHookEntry[];
};

const normalizeHook = (hook: GatewayHookEntry): HookEntry => ({
  ...hook,
  id: hook.hookKey || hook.name,
  enabled: hook.enabledByConfig ?? !hook.disabled,
  missing: {
    bins: hook.missing?.bins ?? [],
    anyBins: hook.missing?.anyBins ?? [],
    env: hook.missing?.env ?? [],
    config: hook.missing?.config ?? [],
    os: hook.missing?.os ?? [],
  },
  events: hook.events ?? [],
  managedByPlugin: hook.managedByPlugin ?? false,
});

class HookService {
  private hooks: HookEntry[] = [];
  private gatewayOffline = false;
  private loadPromise: Promise<HookListResult> | null = null;
  private loadGeneration = 0;
  private lastResult: HookListResult = { success: true, hooks: [] };

  async loadHooks(options: { force?: boolean } = {}): Promise<HookListResult> {
    if (options.force) this.invalidateListRead();
    const generation = this.loadGeneration;
    let pending = this.loadPromise;
    if (!pending) {
      const reading = this.fetchHooks(generation).finally(() => {
        if (this.loadPromise === reading) this.loadPromise = null;
      });
      this.loadPromise = reading;
      pending = reading;
    }
    const result = await pending;
    return generation === this.loadGeneration ? result : (this.loadPromise ?? this.lastResult);
  }

  private invalidateListRead(): void {
    this.loadGeneration += 1;
    this.loadPromise = null;
  }

  private async fetchHooks(generation: number): Promise<HookListResult> {
    try {
      const result: GatewayHookListResult = await window.electron.hooks.list();
      if (generation !== this.loadGeneration) return this.loadPromise ?? this.lastResult;
      if (result.success && result.hooks) {
        this.hooks = result.hooks.map(normalizeHook);
        this.gatewayOffline = false;
        return (this.lastResult = {
          ...result,
          hooks: this.hooks,
        });
      }
      this.gatewayOffline = result.gatewayOffline || false;
      return (this.lastResult = {
        success: false,
        hooks: this.hooks,
        workspaceDir: this.lastResult.workspaceDir,
        managedHooksDir: this.lastResult.managedHooksDir,
        error: result.error,
        gatewayOffline: result.gatewayOffline,
      });
    } catch (error) {
      if (generation !== this.loadGeneration) return this.loadPromise ?? this.lastResult;
      console.error('Failed to load hooks:', error);
      this.gatewayOffline = true;
      return (this.lastResult = {
        success: false,
        hooks: this.hooks,
        workspaceDir: this.lastResult.workspaceDir,
        managedHooksDir: this.lastResult.managedHooksDir,
        error: error instanceof Error ? error.message : 'Failed to load hooks',
        gatewayOffline: true,
      });
    }
  }

  private async applyMutationResult(
    result: GatewayHookListResult,
    generation: number,
    fallbackHooks = this.hooks,
  ): Promise<HookListResult> {
    if (generation !== this.loadGeneration) {
      const current = await this.loadHooks({ force: true });
      return {
        ...result,
        hooks: current.hooks ?? this.hooks,
        workspaceDir: current.workspaceDir ?? result.workspaceDir,
        managedHooksDir: current.managedHooksDir ?? result.managedHooksDir,
      };
    }
    this.invalidateListRead();
    this.hooks = result.hooks?.map(normalizeHook) ?? fallbackHooks;
    this.gatewayOffline = false;
    return (this.lastResult = { ...result, hooks: this.hooks });
  }

  isGatewayOffline(): boolean {
    return this.gatewayOffline;
  }

  hasHookLoadFailed(): boolean {
    return !this.lastResult.success;
  }

  private async reconcileFailedMutation(operation: ReturnType<typeof startPluginOperation>) {
    operation.stage(PluginOperationStage.REFRESHING_INVENTORY);
    const current = await this.loadHooks({ force: true });
    if (!current.success) operation.fail(pluginOperationRefreshFailure());
  }

  async setHookEnabled(id: string, enabled: boolean): Promise<HookListResult> {
    const operation = startPluginOperation({
      kind: PluginKind.HOOK,
      action: enabled ? PluginOperationAction.ENABLE : PluginOperationAction.DISABLE,
      label: this.hooks.find(hook => hook.id === id)?.name || id,
    });
    try {
      const generation = this.loadGeneration;
      const result: GatewayHookListResult = await window.electron.hooks.setEnabled(
        { id, enabled },
        operation.context,
      );
      if (result.success) {
        const applied = await this.applyMutationResult(result, generation);
        if (result.refreshWarning || this.hasHookLoadFailed())
          operation.fail(pluginOperationRefreshFailure(result));
        return applied;
      }
      if (generation === this.loadGeneration) this.gatewayOffline = result.gatewayOffline || false;
      operation.fail(pluginOperationFailure(result, i18nService.t('hookUpdateFailed')));
      throw new Error(result.error || i18nService.t('hookUpdateFailed'));
    } catch (error) {
      operation.fail({
        message: error instanceof Error ? error.message : i18nService.t('hookUpdateFailed'),
      });
      await this.reconcileFailedMutation(operation);
      throw error;
    } finally {
      operation.finish();
    }
  }

  async importHook(
    sourcePath: string,
    options: { reportFailure?: boolean } = {},
  ): Promise<HookListResult> {
    const operation = startPluginOperation({
      kind: PluginKind.HOOK,
      action: PluginOperationAction.INSTALL,
      label: pluginSourceLabel(sourcePath),
    });
    try {
      const generation = this.loadGeneration;
      const result: GatewayHookListResult = await window.electron.hooks.importPath(
        sourcePath,
        operation.context,
      );
      if (result.success) {
        const applied = await this.applyMutationResult(result, generation);
        const refreshFailed = result.refreshWarning || this.hasHookLoadFailed();
        if (refreshFailed && options.reportFailure !== false)
          operation.fail(pluginOperationRefreshFailure(result));
        return { ...applied, ...(refreshFailed ? { refreshWarning: true as const } : {}) };
      }
      if (options.reportFailure !== false)
        operation.fail(pluginOperationFailure(result, i18nService.t('hookImportFailed')));
      return { ...result, hooks: result.hooks?.map(normalizeHook) };
    } catch (error) {
      if (options.reportFailure !== false)
        operation.fail({
          message: error instanceof Error ? error.message : i18nService.t('hookImportFailed'),
        });
      throw error;
    } finally {
      operation.finish();
    }
  }

  async deleteHook(id: string): Promise<HookListResult> {
    const operation = startPluginOperation({
      kind: PluginKind.HOOK,
      action: PluginOperationAction.REMOVE,
      label: this.hooks.find(hook => hook.id === id)?.name || id,
    });
    try {
      const generation = this.loadGeneration;
      const result: GatewayHookListResult = await window.electron.hooks.delete(
        id,
        operation.context,
      );
      if (!result.success) {
        operation.fail(pluginOperationFailure(result, i18nService.t('hookDeleteFailed')));
        throw new Error(result.error || i18nService.t('hookDeleteFailed'));
      }
      const applied = await this.applyMutationResult(
        result,
        generation,
        this.hooks.filter(hook => hook.id !== id),
      );
      const refreshFailed = result.refreshWarning || this.hasHookLoadFailed();
      if (refreshFailed) operation.fail(pluginOperationRefreshFailure(result));
      return { ...applied, ...(refreshFailed ? { refreshWarning: true as const } : {}) };
    } catch (error) {
      operation.fail({
        message: error instanceof Error ? error.message : i18nService.t('hookDeleteFailed'),
      });
      await this.reconcileFailedMutation(operation);
      throw error;
    } finally {
      operation.finish();
    }
  }

  getHooks(): HookEntry[] {
    return this.hooks;
  }
}

export const hookService = new HookService();
