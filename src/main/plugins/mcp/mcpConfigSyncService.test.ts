import { BrowserWindow } from 'electron';
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

test('correlates operation-owned sync notifications without changing background sync events', async () => {
  const send = vi.fn();
  vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
    { isDestroyed: () => false, webContents: { send } } as unknown as BrowserWindow,
  ]);
  const sync = vi
    .fn()
    .mockResolvedValue({ success: false, changed: false, error: 'Apply refused' });
  const service = new McpConfigSyncService({
    getMcpStore: () => ({ getEnabledServers: () => [] }) as unknown as McpStore,
    syncOpenClawConfig: sync,
  });

  await service.syncConfigAfterExclusiveMutation(sync, { requestId: 'mcp-operation:one' });
  expect(send).toHaveBeenNthCalledWith(1, 'mcp:config:syncStart', {
    requestId: 'mcp-operation:one',
  });
  expect(send).toHaveBeenNthCalledWith(2, 'mcp:config:syncDone', {
    requestId: 'mcp-operation:one',
    tools: 0,
    error: 'Apply refused',
  });
  send.mockClear();
  await service.syncConfig();
  expect(send).toHaveBeenNthCalledWith(1, 'mcp:config:syncStart', {});
  expect(send).toHaveBeenNthCalledWith(2, 'mcp:config:syncDone', {
    tools: 0,
    error: 'Apply refused',
  });
});
