import { BrowserWindow } from 'electron';
import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

import { syncMcpConfigAfterMutation } from './mcpConfigSyncService';

beforeEach(() => vi.clearAllMocks());

test('does not rediscover stale native config while applying a JustDo MCP mutation', async () => {
  const syncOpenClawConfig = vi.fn(async () => ({ success: true, changed: true }));
  await expect(syncMcpConfigAfterMutation(syncOpenClawConfig, () => 0)).resolves.toEqual({ tools: 0 });
  expect(syncOpenClawConfig).toHaveBeenCalledWith({
    reason: 'mcp-server-changed',
    discoverExternalMcpServers: false,
  });
});

test('returns an error for a rejected MCP application even when the native error text is absent', async () => {
  const sync = vi.fn().mockResolvedValue({ success: false, changed: false });
  await expect(syncMcpConfigAfterMutation(sync, () => 0)).resolves.toEqual({
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
  await syncMcpConfigAfterMutation(sync, () => 0, { requestId: 'mcp-operation:one' });
  expect(send).toHaveBeenNthCalledWith(1, 'mcp:config:syncStart', {
    requestId: 'mcp-operation:one',
  });
  expect(send).toHaveBeenNthCalledWith(2, 'mcp:config:syncDone', {
    requestId: 'mcp-operation:one',
    tools: 0,
    error: 'Apply refused',
  });
  send.mockClear();
  await syncMcpConfigAfterMutation(sync, () => 0);
  expect(send).toHaveBeenNthCalledWith(1, 'mcp:config:syncStart', {});
  expect(send).toHaveBeenNthCalledWith(2, 'mcp:config:syncDone', {
    tools: 0,
    error: 'Apply refused',
  });
});
