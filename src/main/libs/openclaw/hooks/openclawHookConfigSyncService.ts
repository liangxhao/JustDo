import { BrowserWindow } from 'electron';

import type { OpenClawHookStore } from './openclawHookStore';

type OpenClawConfigSyncResult = {
  success: boolean;
  changed: boolean;
  error?: string;
};

type OpenClawHookConfigSyncServiceDeps = {
  getHookStore: () => OpenClawHookStore;
  syncOpenClawConfig: (options: {
    reason: string;
    restartGatewayIfRunning?: boolean;
  }) => Promise<OpenClawConfigSyncResult>;
};

type OpenClawHookConfigSyncResult = {
  hooks: number;
  error?: string;
};

export class OpenClawHookConfigSyncService {
  private readonly deps: OpenClawHookConfigSyncServiceDeps;
  private syncPromise: Promise<OpenClawHookConfigSyncResult> | null = null;

  constructor(deps: OpenClawHookConfigSyncServiceDeps) {
    this.deps = deps;
  }

  syncConfig(): Promise<OpenClawHookConfigSyncResult> {
    if (this.syncPromise) {
      return this.syncPromise;
    }

    this.syncPromise = (async () => {
      try {
        console.log('[OpenClawHooks] syncing configuration...');
        this.broadcast('hooks:config:syncStart');
        const syncResult = await this.deps.syncOpenClawConfig({
          reason: 'hook-config-changed',
        });
        if (!syncResult.success) {
          console.error('[OpenClawHooks] config sync failed:', syncResult.error);
          return { hooks: 0, error: syncResult.error };
        }
        const enabledHooks = this.deps
          .getHookStore()
          .listHooks()
          .filter(hook => hook.enabled).length;
        console.log(`[OpenClawHooks] sync complete, changed=${syncResult.changed}`);
        return { hooks: enabledHooks };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error('[OpenClawHooks] sync error:', msg);
        return { hooks: 0, error: msg };
      }
    })()
      .then(result => {
        this.broadcast('hooks:config:syncDone', { hooks: result.hooks, error: result.error });
        return result;
      })
      .catch(err => {
        const error = err instanceof Error ? err.message : String(err);
        this.broadcast('hooks:config:syncDone', { hooks: 0, error });
        return { hooks: 0, error };
      })
      .finally(() => {
        this.syncPromise = null;
      });

    return this.syncPromise;
  }

  private broadcast(channel: string, data?: Record<string, unknown>): void {
    BrowserWindow.getAllWindows().forEach(win => {
      if (win.isDestroyed()) return;
      try {
        win.webContents.send(channel, data ?? {});
      } catch (error) {
        console.error(`[OpenClawHooks] Failed to broadcast ${channel}:`, error);
      }
    });
  }
}
