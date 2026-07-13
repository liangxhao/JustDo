import { HookEntry, HookListResult } from '../types/hook';

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

  async loadHooks(): Promise<HookListResult> {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.fetchHooks().finally(() => {
      this.loadPromise = null;
    });
    return this.loadPromise;
  }

  private async fetchHooks(): Promise<HookListResult> {
    try {
      const result: GatewayHookListResult = await window.electron.hooks.list();
      if (result.success && result.hooks) {
        this.hooks = result.hooks.map(normalizeHook);
        this.gatewayOffline = false;
        return {
          ...result,
          hooks: this.hooks,
        };
      }
      this.hooks = [];
      this.gatewayOffline = result.gatewayOffline || false;
      return {
        success: false,
        hooks: [],
        error: result.error,
        gatewayOffline: result.gatewayOffline,
      };
    } catch (error) {
      console.error('Failed to load hooks:', error);
      this.hooks = [];
      this.gatewayOffline = true;
      return {
        success: false,
        hooks: [],
        error: error instanceof Error ? error.message : 'Failed to load hooks',
        gatewayOffline: true,
      };
    }
  }

  isGatewayOffline(): boolean {
    return this.gatewayOffline;
  }

  async setHookEnabled(id: string, enabled: boolean): Promise<HookListResult> {
    const result: GatewayHookListResult = await window.electron.hooks.setEnabled({ id, enabled });
    if (result.success) {
      if (result.hooks) {
        this.hooks = result.hooks.map(normalizeHook);
      }
      this.gatewayOffline = false;
      return {
        ...result,
        hooks: this.hooks,
      };
    }
    this.gatewayOffline = result.gatewayOffline || false;
    throw new Error(result.error || 'Failed to update hook');
  }

  getHooks(): HookEntry[] {
    return this.hooks;
  }
}

export const hookService = new HookService();
