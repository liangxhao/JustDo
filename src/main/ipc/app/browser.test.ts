import { describe, expect, test, vi } from 'vitest';

import { BrowserMode } from '../../../shared/browser';
import { applyBrowserModeChange } from './browser';

vi.mock('electron', () => ({
  clipboard: { writeText: vi.fn() },
  ipcMain: { handle: vi.fn() },
}));

describe('applyBrowserModeChange', () => {
  test('persists the selected mode and synchronizes it once', async () => {
    let config: Record<string, unknown> = { theme: 'light' };
    const syncConfig = vi.fn().mockResolvedValue({ success: true });

    const result = await applyBrowserModeChange(BrowserMode.User, {
      readAppConfig: () => config,
      writeAppConfig: next => {
        config = next;
      },
      syncConfig,
    });

    expect(result).toEqual({ success: true, mode: BrowserMode.User });
    expect(config).toEqual({ theme: 'light', browserMode: BrowserMode.User });
    expect(syncConfig).toHaveBeenCalledTimes(1);
    expect(syncConfig).toHaveBeenCalledWith('browser-mode-change');
  });

  test('restores app config and OpenClaw config when synchronization fails', async () => {
    const originalConfig = { theme: 'dark', browserMode: BrowserMode.Isolated };
    let config: Record<string, unknown> = originalConfig;
    const syncConfig = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: 'apply failed' })
      .mockResolvedValueOnce({ success: true });

    const result = await applyBrowserModeChange(BrowserMode.User, {
      readAppConfig: () => config,
      writeAppConfig: next => {
        config = next;
      },
      syncConfig,
    });

    expect(result).toEqual({ success: false, errorCode: 'config-sync-failed' });
    expect(config).toBe(originalConfig);
    expect(syncConfig).toHaveBeenNthCalledWith(1, 'browser-mode-change');
    expect(syncConfig).toHaveBeenNthCalledWith(2, 'browser-mode-rollback');
  });

  test('rolls back when synchronization rejects', async () => {
    const originalConfig = { browserMode: BrowserMode.Isolated };
    let config: Record<string, unknown> = originalConfig;
    const syncConfig = vi
      .fn()
      .mockRejectedValueOnce(new Error('unexpected failure'))
      .mockResolvedValueOnce({ success: true });

    const result = await applyBrowserModeChange(BrowserMode.User, {
      readAppConfig: () => config,
      writeAppConfig: next => {
        config = next;
      },
      syncConfig,
    });

    expect(result).toEqual({ success: false, errorCode: 'config-sync-failed' });
    expect(config).toBe(originalConfig);
    expect(syncConfig).toHaveBeenNthCalledWith(2, 'browser-mode-rollback');
  });
});
