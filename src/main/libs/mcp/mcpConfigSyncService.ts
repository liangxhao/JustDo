import { BrowserWindow } from 'electron';

import type { McpStore } from './mcpStore';

type OpenClawConfigSyncResult = {
  success: boolean;
  changed: boolean;
  error?: string;
};

type McpConfigSyncServiceDeps = {
  getMcpStore: () => McpStore;
  syncOpenClawConfig: (options: {
    reason: string;
    restartGatewayIfRunning?: boolean;
  }) => Promise<OpenClawConfigSyncResult>;
};

type McpConfigSyncResult = {
  tools: number;
  error?: string;
};

export class McpConfigSyncService {
  private readonly deps: McpConfigSyncServiceDeps;
  private syncPromise: Promise<McpConfigSyncResult> | null = null;

  constructor(deps: McpConfigSyncServiceDeps) {
    this.deps = deps;
  }

  syncConfig(): Promise<McpConfigSyncResult> {
    if (this.syncPromise) {
      return this.syncPromise;
    }

    this.syncPromise = (async () => {
      try {
        console.log('[OpenClawMcp] syncing configuration...');
        this.broadcast('mcp:config:syncStart');
        const syncResult = await this.deps.syncOpenClawConfig({
          reason: 'mcp-server-changed',
        });
        if (!syncResult.success) {
          console.error('[OpenClawMcp] config sync failed:', syncResult.error);
          return { tools: 0, error: syncResult.error };
        }
        console.log(`[OpenClawMcp] sync complete, changed=${syncResult.changed}`);
        return { tools: this.deps.getMcpStore().getEnabledServers().length };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error('[OpenClawMcp] sync error:', msg);
        return { tools: 0, error: msg };
      }
    })()
      .then(result => {
        this.broadcast('mcp:config:syncDone', { tools: result.tools, error: result.error });
        return result;
      })
      .catch(err => {
        const error = err instanceof Error ? err.message : String(err);
        this.broadcast('mcp:config:syncDone', { tools: 0, error });
        return { tools: 0, error };
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
        console.error(`[OpenClawMcp] Failed to broadcast ${channel}:`, error);
      }
    });
  }
}
