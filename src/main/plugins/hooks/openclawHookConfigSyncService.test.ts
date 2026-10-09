import { expect, test, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

import { OpenClawHookConfigSyncService } from './openclawHookConfigSyncService';
import type { OpenClawHookStore } from './openclawHookStore';

test('queues Hook recovery and a later mutation as separate configuration applications', async () => {
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
  const service = new OpenClawHookConfigSyncService({
    getHookStore: () => ({ listHooks: () => [] }) as unknown as OpenClawHookStore,
    syncOpenClawConfig,
  });
  const first = service.syncConfig();
  const second = service.syncConfig();
  await vi.waitFor(() => expect(syncOpenClawConfig).toHaveBeenCalledOnce());
  release({ success: true, changed: true });
  await Promise.all([first, second]);
  expect(syncOpenClawConfig).toHaveBeenCalledTimes(2);
});

test('does not let a failed Hook application without error text look successful', async () => {
  const service = new OpenClawHookConfigSyncService({
    getHookStore: () => ({ listHooks: () => [] }) as unknown as OpenClawHookStore,
    syncOpenClawConfig: vi.fn().mockResolvedValue({ success: false, changed: false }),
  });
  await expect(service.syncConfig()).resolves.toEqual({
    hooks: 0,
    error: 'Failed to synchronize Hook configuration',
  });
});
