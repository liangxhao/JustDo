import type { BrowserWindow } from 'electron';
import type { AppUpdater, UpdateCheckResult } from 'electron-updater';
import { EventEmitter } from 'events';
import { describe, expect, test, vi } from 'vitest';

import { AutoUpdateService } from './autoUpdateService';

class FakeUpdater extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = true;
  allowDowngrade = true;
  allowPrerelease = true;
  logger: unknown;
  checkForUpdates = vi.fn<() => Promise<UpdateCheckResult | null>>();
  quitAndInstall = vi.fn();
}

const makeService = (updater: FakeUpdater, enabled = true) => {
  const installAfterCleanup = vi.fn<(install: () => void) => void>(install => install());
  const recoverAfterInstallFailure = vi.fn();
  const service = new AutoUpdateService({
    currentVersion: '2026.7.23',
    enabled,
    getWindows: () => [] as BrowserWindow[],
    installAfterCleanup,
    recoverAfterInstallFailure,
    updater: updater as unknown as AppUpdater,
  });
  return { installAfterCleanup, recoverAfterInstallFailure, service };
};

describe('AutoUpdateService', () => {
  test('configures safe automatic download defaults', () => {
    const updater = new FakeUpdater();
    makeService(updater);

    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.allowDowngrade).toBe(false);
    expect(updater.allowPrerelease).toBe(false);
  });

  test('maps updater events to renderer-safe state', () => {
    const updater = new FakeUpdater();
    const { service } = makeService(updater);

    updater.emit('update-available', {
      version: '2026.7.24',
      releaseNotes: '  Fixed updates  ',
    });
    expect(service.getState()).toMatchObject({
      phase: 'available',
      availableVersion: '2026.7.24',
      releaseNotes: 'Fixed updates',
    });

    updater.emit('download-progress', { percent: 42.4 });
    expect(service.getState()).toMatchObject({ phase: 'downloading', downloadPercent: 42.4 });

    updater.emit('update-downloaded', { version: '2026.7.24', releaseNotes: '' });
    expect(service.getState()).toMatchObject({
      phase: 'downloaded',
      availableVersion: '2026.7.24',
    });
  });

  test('deduplicates checks and installs only a downloaded update', async () => {
    const updater = new FakeUpdater();
    let resolveCheck: ((value: null) => void) | undefined;
    updater.checkForUpdates.mockReturnValue(
      new Promise(resolve => {
        resolveCheck = resolve;
      }),
    );
    const { installAfterCleanup, service } = makeService(updater);

    const firstCheck = service.checkForUpdates();
    const secondCheck = service.checkForUpdates();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(service.quitAndInstall().success).toBe(false);

    resolveCheck?.(null);
    await Promise.all([firstCheck, secondCheck]);
    updater.emit('update-downloaded', { version: '2026.7.24' });

    expect(service.quitAndInstall().success).toBe(true);
    expect(installAfterCleanup).toHaveBeenCalledOnce();
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(service.quitAndInstall().success).toBe(false);
  });

  test('does not call the updater in unsupported environments', async () => {
    const updater = new FakeUpdater();
    const { service } = makeService(updater, false);

    expect(await service.checkForUpdates()).toMatchObject({ phase: 'unsupported' });
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  test('does not resolve the Electron updater in unsupported environments', () => {
    const service = new AutoUpdateService({
      currentVersion: '2026.7.23',
      enabled: false,
      getWindows: () => [],
      installAfterCleanup: vi.fn(),
      recoverAfterInstallFailure: vi.fn(),
    });

    expect(service.getState()).toMatchObject({ phase: 'unsupported' });
  });

  test('publishes a safe error state without leaking the raw updater error', () => {
    const updater = new FakeUpdater();
    const { service } = makeService(updater);

    updater.emit('error', new Error('https://secret.example/token-value'));

    expect(service.getState()).toMatchObject({
      phase: 'error',
      errorCode: 'CHECK_FAILED',
    });
    expect(JSON.stringify(service.getState())).not.toContain('token-value');
  });

  test('handles a rejected automatic download promise', async () => {
    const updater = new FakeUpdater();
    let rejectDownload: ((error: Error) => void) | undefined;
    const downloadPromise = new Promise<string[]>((_, reject) => {
      rejectDownload = reject;
    });
    updater.checkForUpdates.mockResolvedValue({
      downloadPromise,
      isUpdateAvailable: true,
      updateInfo: { version: '2026.7.24' },
      versionInfo: { version: '2026.7.24' },
    } as UpdateCheckResult);
    const { service } = makeService(updater);

    await service.checkForUpdates();
    rejectDownload?.(new Error('download failed'));
    await vi.waitFor(() => {
      expect(service.getState()).toMatchObject({
        phase: 'error',
        errorCode: 'CHECK_FAILED',
      });
    });
  });

  test('restarts the app when the installer fails after cleanup', () => {
    const updater = new FakeUpdater();
    const { recoverAfterInstallFailure, service } = makeService(updater);
    updater.emit('update-downloaded', { version: '2026.7.24' });
    expect(service.quitAndInstall().success).toBe(true);

    updater.emit('error', new Error('installer spawn failed'));

    expect(service.getState()).toMatchObject({ phase: 'error', errorCode: 'INSTALL_FAILED' });
    expect(recoverAfterInstallFailure).toHaveBeenCalledOnce();
  });
});
