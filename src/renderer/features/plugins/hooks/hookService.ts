import { HookEntry, HookListResult } from '@/features/plugins/hooks/hook';

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

  async setHookEnabled(id: string, enabled: boolean): Promise<HookListResult> {
    const generation = this.loadGeneration;
    const result: GatewayHookListResult = await window.electron.hooks.setEnabled({ id, enabled });
    if (result.success) {
      return this.applyMutationResult(result, generation);
    }
    if (generation === this.loadGeneration) this.gatewayOffline = result.gatewayOffline || false;
    throw new Error(result.error || 'Failed to update hook');
  }

  async importHook(sourcePath: string): Promise<HookListResult> {
    const generation = this.loadGeneration;
    const result: GatewayHookListResult = await window.electron.hooks.importPath(sourcePath);
    if (result.success) return this.applyMutationResult(result, generation);
    const hooks = result.hooks?.map(normalizeHook);
    return { ...result, hooks };
  }

  async deleteHook(id: string): Promise<HookListResult> {
    const generation = this.loadGeneration;
    const result: GatewayHookListResult = await window.electron.hooks.delete(id);
    if (!result.success) throw new Error(result.error || 'Failed to delete Hook');
    return this.applyMutationResult(
      result,
      generation,
      this.hooks.filter(hook => hook.id !== id),
    );
  }

  getHooks(): HookEntry[] {
    return this.hooks;
  }
}

export const hookService = new HookService();
