import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

import { McpConfigSyncService } from './mcpConfigSyncService';
import type { McpStore } from './mcpStore';

beforeEach(() => vi.clearAllMocks());

test('does not rediscover stale native config while applying a JustDo MCP mutation', async () => {
  const syncOpenClawConfig = vi.fn(async () => ({ success: true, changed: true }));
  const service = new McpConfigSyncService({
    getMcpStore: () =>
      ({ getEnabledServers: vi.fn(() => []) }) as unknown as McpStore,
    syncOpenClawConfig,
  });

  await expect(service.syncConfig()).resolves.toEqual({ tools: 0 });
  expect(syncOpenClawConfig).toHaveBeenCalledWith({
    reason: 'mcp-server-changed',
    discoverExternalMcpServers: false,
  });
});
