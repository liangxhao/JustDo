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
    getMcpStore: () => ({ getEnabledServers: vi.fn(() => []) }) as unknown as McpStore,
    syncOpenClawConfig,
  });

  await expect(service.syncConfig()).resolves.toEqual({ tools: 0 });
  expect(syncOpenClawConfig).toHaveBeenCalledWith({
    reason: 'mcp-server-changed',
    discoverExternalMcpServers: false,
  });
});

test('queues a later MCP sync behind the current sync instead of reusing stale work', async () => {
  let release!: (value: { success: boolean; changed: boolean }) => void;
  const syncOpenClawConfig = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = resolve;
        }),
    )
    .mockResolvedValue({ success: true, changed: true });
  const service = new McpConfigSyncService({
    getMcpStore: () => ({ getEnabledServers: () => [] }) as unknown as McpStore,
    syncOpenClawConfig,
  });
  const first = service.syncConfig();
  const second = service.syncConfig();
  await vi.waitFor(() => expect(syncOpenClawConfig).toHaveBeenCalledOnce());
  release({ success: true, changed: true });
  await Promise.all([first, second]);
  expect(syncOpenClawConfig).toHaveBeenCalledTimes(2);
});

test('returns an error for a rejected MCP application even when the native error text is absent', async () => {
  const service = new McpConfigSyncService({
    getMcpStore: () => ({ getEnabledServers: () => [] }) as unknown as McpStore,
    syncOpenClawConfig: vi.fn().mockResolvedValue({ success: false, changed: false }),
  });
  await expect(service.syncConfig()).resolves.toEqual({
    tools: 0,
    error: 'Failed to synchronize MCP configuration',
  });
});
