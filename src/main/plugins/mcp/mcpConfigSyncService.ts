import { BrowserWindow } from 'electron';

import type { PluginOperationContext } from '../../../shared/plugins/pluginOperation';
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
    discoverExternalMcpServers?: boolean;
  }) => Promise<OpenClawConfigSyncResult>;
};

type McpConfigSyncResult = {
  tools: number;
  error?: string;
};

export class McpConfigSyncService {
  private readonly deps: McpConfigSyncServiceDeps;
  private syncTail: Promise<void> = Promise.resolve();

  constructor(deps: McpConfigSyncServiceDeps) {
    this.deps = deps;
  }

  syncConfig(): Promise<McpConfigSyncResult> {
    const result = this.syncTail.then(() => this.syncConfigExclusive());
    this.syncTail = result.then(
      (): void => undefined,
      (): void => undefined,
    );
    return result;
  }

  syncConfigAfterExclusiveMutation(
    syncOpenClawConfig: McpConfigSyncServiceDeps['syncOpenClawConfig'],
    context?: PluginOperationContext,
  ): Promise<McpConfigSyncResult> {
    return this.syncConfigExclusive(syncOpenClawConfig, context);
  }

  private syncConfigExclusive(
    syncOpenClawConfig = this.deps.syncOpenClawConfig,
    context?: PluginOperationContext,
  ): Promise<McpConfigSyncResult> {
    const correlation = context ? { requestId: context.requestId } : {};
    return (async () => {
      try {
        console.log('[OpenClawMcp] syncing configuration...');
        this.broadcast('mcp:config:syncStart', correlation);
        const syncResult = await syncOpenClawConfig({
          reason: 'mcp-server-changed',
          discoverExternalMcpServers: false,
        });
        if (!syncResult.success) {
          console.error('[OpenClawMcp] config sync failed:', syncResult.error);
          return { tools: 0, error: syncResult.error || 'Failed to synchronize MCP configuration' };
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
        this.broadcast('mcp:config:syncDone', {
          ...correlation,
          tools: result.tools,
          error: result.error,
        });
        return result;
      })
      .catch(err => {
        const error = err instanceof Error ? err.message : String(err);
        this.broadcast('mcp:config:syncDone', { ...correlation, tools: 0, error });
        return { tools: 0, error };
      });
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
