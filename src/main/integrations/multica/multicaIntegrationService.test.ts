import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MulticaIntegrationStatus } from '../../../shared/integrations/multica';
import type { SqliteStore } from '../../data/sqliteStore';
import { MulticaIntegrationService } from './multicaIntegrationService';

vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => {
    const callback = args[args.length - 1] as (error: Error) => void;
    callback(new Error('Multica CLI is not installed in this test.'));
  },
}));

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function launcherFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'integration-launcher-'));
  directories.push(directory);
  const oldPath = path.join(directory, 'old-agent.exe');
  const currentPath = path.join(directory, 'current-agent.exe');
  fs.writeFileSync(oldPath, 'old');
  fs.writeFileSync(currentPath, 'current');
  let state = { enabled: true, launcherPath: oldPath, command: oldPath.replaceAll('\\', '/') };
  const store = {
    get: vi.fn(() => state),
    set: vi.fn((_key: string, next: typeof state) => {
      state = next;
    }),
  } as unknown as SqliteStore;
  const createLauncher = vi.fn(() => ({
    path: currentPath,
    command: currentPath.replaceAll('\\', '/'),
  }));
  const ensureBridgeRunning = vi.fn().mockResolvedValue(undefined);
  const service = new MulticaIntegrationService({
    getStore: () => store,
    getBridgeState: () => ({ running: true, activeTaskCount: 0 }),
    ensureBridgeRunning,
    getOpenClawVersion: () => null,
    getLauncherTarget: () => ({ path: currentPath, args: [] }),
    createLauncher,
  });
  return { service, store, currentPath, oldPath, createLauncher, ensureBridgeRunning };
}

describe('MulticaIntegrationService', () => {
  it.skipIf(process.platform !== 'win32')(
    'shows the current target even when the saved launcher still exists',
    async () => {
      const fixture = launcherFixture();

      const status = await fixture.service.getStatus();

      expect(status.launcherPath).toBe(fixture.currentPath);
      expect(status.manualSetup.command).toBe(fixture.currentPath.replaceAll('\\', '/'));
      expect(status.launcherReady).toBe(true);
      expect(fixture.ensureBridgeRunning).not.toHaveBeenCalled();
      expect(fixture.store.set).not.toHaveBeenCalled();
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'does not use an old launcher to hide a missing current target',
    async () => {
      const fixture = launcherFixture();
      fs.rmSync(fixture.currentPath);

      const status = await fixture.service.getStatus();

      expect(fs.existsSync(fixture.oldPath)).toBe(true);
      expect(status.launcherPath).toBe(fixture.currentPath);
      expect(status.launcherReady).toBe(false);
    },
  );

  it('refreshes an enabled launcher even when the saved executable still exists', async () => {
    const fixture = launcherFixture();

    const result = await fixture.service.refresh();

    expect(result.success).toBe(true);
    expect(fixture.createLauncher).toHaveBeenCalledWith(fixture.currentPath, []);
    expect(fixture.store.set).toHaveBeenCalledWith('multica_integration_v2', {
      enabled: true,
      launcherPath: fixture.currentPath,
      command: fixture.currentPath.replaceAll('\\', '/'),
    });
  });

  it('persists the disabled state even when launcher cleanup fails', async () => {
    let state = {
      enabled: true,
      launcherPath: 'owned-launcher',
      command: 'owned-launcher',
    };
    const store = {
      get: vi.fn(() => state),
      set: vi.fn((_key: string, next: typeof state) => {
        state = next;
      }),
    } as unknown as SqliteStore;
    const service = new MulticaIntegrationService({
      getStore: () => store,
      getBridgeState: () => ({ running: true, activeTaskCount: 0 }),
      ensureBridgeRunning: vi.fn().mockResolvedValue(undefined),
      getOpenClawVersion: () => 'v2026.9.2',
      getLauncherTarget: () => ({ path: 'unused', args: [] }),
      removeLauncher: () => {
        throw new Error('locked');
      },
    });
    vi.spyOn(service, 'getStatus').mockResolvedValue({
      enabled: false,
    } as MulticaIntegrationStatus);

    const result = await service.disable();

    expect(result.success).toBe(true);
    expect(state.enabled).toBe(false);
    expect(store.set).toHaveBeenCalledWith(
      'multica_integration_v2',
      expect.objectContaining({ enabled: false }),
    );
  });

  it('does not enable the integration when the local bridge cannot start', async () => {
    let state = { enabled: false, launcherPath: '', command: '' };
    const store = {
      get: vi.fn(() => state),
      set: vi.fn((_key: string, next: typeof state) => {
        state = next;
      }),
    } as unknown as SqliteStore;
    const service = new MulticaIntegrationService({
      getStore: () => store,
      getBridgeState: () => ({ running: false, activeTaskCount: 0 }),
      ensureBridgeRunning: vi.fn().mockRejectedValue(new Error('listen failed')),
      getOpenClawVersion: () => 'v2026.9.2',
      getLauncherTarget: () => ({ path: 'unused', args: [] }),
    });
    vi.spyOn(service, 'getStatus').mockResolvedValue({
      enabled: false,
    } as MulticaIntegrationStatus);

    const result = await service.enable();

    expect(result.success).toBe(false);
    expect(state.enabled).toBe(false);
    expect(store.set).not.toHaveBeenCalled();
  });
});
