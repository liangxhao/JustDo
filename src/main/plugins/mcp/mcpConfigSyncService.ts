import { BrowserWindow } from 'electron';

import type { PluginOperationContext } from '../../../shared/plugins/pluginOperation';

type OpenClawConfigSyncResult = {
  success: boolean;
  changed: boolean;
  error?: string;
};

type McpConfigSyncResult = {
  tools: number;
  error?: string;
};

/** Use the synchronization callback from the owning configuration queue. */
export async function syncMcpConfigAfterMutation(
  syncOpenClawConfig: (options: {
    reason: string;
    discoverExternalMcpServers: false;
  }) => Promise<OpenClawConfigSyncResult>,
  getEnabledServerCount: () => number,
  context?: PluginOperationContext,
): Promise<McpConfigSyncResult> {
  const correlation = context ? { requestId: context.requestId } : {};
  let result: McpConfigSyncResult;
  try {
    console.log('[OpenClawMcp] syncing configuration...');
    broadcast('mcp:config:syncStart', correlation);
    const syncResult = await syncOpenClawConfig({
      reason: 'mcp-server-changed',
      discoverExternalMcpServers: false,
    });
    if (syncResult.success) {
      console.log(`[OpenClawMcp] sync complete, changed=${syncResult.changed}`);
      result = { tools: getEnabledServerCount() };
    } else {
      const error = syncResult.error || 'Failed to synchronize MCP configuration';
      console.error(`[OpenClawMcp] config sync failed: ${JSON.stringify(error)}`);
      result = { tools: 0, error };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[OpenClawMcp] sync error: ${JSON.stringify(message)}`);
    result = { tools: 0, error: message };
  }
  broadcast('mcp:config:syncDone', { ...correlation, tools: result.tools, error: result.error });
  return result;
}

function broadcast(channel: string, data: Record<string, unknown>): void {
  BrowserWindow.getAllWindows().forEach(win => {
    if (win.isDestroyed()) return;
    try {
      win.webContents.send(channel, data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[OpenClawMcp] Failed to broadcast ${channel}: ${JSON.stringify(message)}`);
    }
  });
}
