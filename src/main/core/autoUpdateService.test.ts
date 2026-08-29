import type { BrowserWindow } from 'electron';
import type { AppUpdater, UpdateCheckResult } from 'electron-updater';
import { EventEmitter } from 'events';
import { describe, expect, test, vi } from 'vitest';

import { AppUpdateCheckFrequency } from '../../shared/appUpdate';
import { AutoUpdateService, resolveNextAutomaticUpdateCheckAt } from './autoUpdateService';

class FakeUpdater extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = true;
  allowDowngrade = true;
  allowPrerelease = true;
  logger: unknown;
  checkForUpdates = vi.fn<() => Promise<UpdateCheckResult | null>>();
  downloadUpdate = vi.fn<() => Promise<string[]>>();
  quitAndInstall = vi.fn();
}

const makeService = (
  updater: FakeUpdater,
  enabled = true,
  stored: { frequency?: unknown; lastAutomaticCheckAt?: unknown } = {},
) => {
  const installAfterCleanup = vi.fn<(install: () => void) => void>(install => install());
  const recoverAfterInstallFailure = vi.fn();
  const setCheckFrequency = vi.fn((frequency: AppUpdateCheckFrequency) => {
    stored.frequency = frequency;
  });
  const setLastAutomaticCheckAt = vi.fn((checkedAt: number) => {
    stored.lastAutomaticCheckAt = checkedAt;
  });
  const service = new AutoUpdateService({
    currentVersion: '2026.7.23',
    enabled,
    getWindows: () => [] as BrowserWindow[],
    installAfterCleanup,
    recoverAfterInstallFailure,
    getCheckFrequency: () => stored.frequency,
    setCheckFrequency,
    getLastAutomaticCheckAt: () => stored.lastAutomaticCheckAt,
    setLastAutomaticCheckAt,
    updater: updater as unknown as AppUpdater,
  });
  return {
    installAfterCleanup,
    recoverAfterInstallFailure,
    service,
    setCheckFrequency,
    setLastAutomaticCheckAt,
  };
};

describe('AutoUpdateService', () => {
  test('disables automatic downloads and unsafe version changes', () => {
    const updater = new FakeUpdater();
    makeService(updater);

    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.allowDowngrade).toBe(false);
    expect(updater.allowPrerelease).toBe(false);
  });

  test('downloads only after an explicit user action', async () => {
    const updater = new FakeUpdater();
    updater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: '2026.7.24' },
      versionInfo: { version: '2026.7.24' },
    } as UpdateCheckResult);
    let resolveDownload: ((files: string[]) => void) | undefined;
    updater.downloadUpdate.mockReturnValue(
      new Promise(resolve => {
        resolveDownload = resolve;
      }),
    );
    const { service } = makeService(updater);

    const checkPromise = service.checkForUpdates();
    updater.emit('update-available', { version: '2026.7.24' });
    await checkPromise;
    expect(service.getState().phase).toBe('available');
    expect(updater.downloadUpdate).not.toHaveBeenCalled();

    const downloadPromise = service.downloadUpdate();
    expect(updater.downloadUpdate).toHaveBeenCalledOnce();
    expect(service.getState()).toMatchObject({ phase: 'downloading', downloadPercent: 0 });
    resolveDownload?.(['update.exe']);
    await expect(downloadPromise).resolves.toMatchObject({ success: true });
    expect(service.getState().phase).toBe('downloaded');
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
      getCheckFrequency: () => AppUpdateCheckFrequency.Daily,
      setCheckFrequency: vi.fn(),
      getLastAutomaticCheckAt: () => undefined,
      setLastAutomaticCheckAt: vi.fn(),
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

  test('handles a rejected user-requested download', async () => {
    const updater = new FakeUpdater();
    let rejectDownload: ((error: Error) => void) | undefined;
    updater.downloadUpdate.mockReturnValue(
      new Promise<string[]>((_, reject) => {
        rejectDownload = reject;
      }),
    );
    const { service } = makeService(updater);

    updater.emit('update-available', { version: '2026.7.24' });
    const downloadPromise = service.downloadUpdate();
    rejectDownload?.(new Error('download failed'));
    await expect(downloadPromise).resolves.toMatchObject({
      success: false,
      errorCode: 'DOWNLOAD_FAILED',
    });
    expect(service.getState()).toMatchObject({
      phase: 'error',
      errorCode: 'DOWNLOAD_FAILED',
    });
  });

  test('persists frequency changes and disables the automatic schedule for never', () => {
    const updater = new FakeUpdater();
    const { service, setCheckFrequency } = makeService(updater);

    expect(service.getPreferences().checkFrequency).toBe(AppUpdateCheckFrequency.Daily);
    const preferences = service.setCheckFrequency(AppUpdateCheckFrequency.Never);
    expect(preferences).toMatchObject({
      checkFrequency: AppUpdateCheckFrequency.Never,
    });
    expect(preferences).not.toHaveProperty('nextCheckAt');
    expect(setCheckFrequency).toHaveBeenCalledWith(AppUpdateCheckFrequency.Never);
  });

  test('runs an overdue automatic check shortly after startup and records the attempt', async () => {
    vi.useFakeTimers();
    try {
      const now = new Date(2026, 7, 29, 15, 0, 0).getTime();
      vi.setSystemTime(now);
      const updater = new FakeUpdater();
      updater.checkForUpdates.mockResolvedValue(null);
      const { service, setLastAutomaticCheckAt } = makeService(updater, true, {
        frequency: AppUpdateCheckFrequency.Daily,
        lastAutomaticCheckAt: new Date(2026, 7, 28, 10, 0, 0).getTime(),
      });

      service.scheduleAutomaticChecks();
      expect(service.getPreferences().nextCheckAt).toBe(now + 10_000);
      await vi.advanceTimersByTimeAsync(10_000);

      expect(setLastAutomaticCheckAt).toHaveBeenCalledWith(now + 10_000);
      expect(updater.checkForUpdates).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  test('continues checking and scheduling when the check timestamp cannot be persisted', async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const now = new Date(2026, 7, 29, 15, 0, 0).getTime();
      vi.setSystemTime(now);
      const updater = new FakeUpdater();
      updater.checkForUpdates.mockResolvedValue(null);
      const { service, setLastAutomaticCheckAt } = makeService(updater, true, {
        frequency: AppUpdateCheckFrequency.Daily,
        lastAutomaticCheckAt: new Date(2026, 7, 28, 10, 0, 0).getTime(),
      });
      setLastAutomaticCheckAt.mockImplementation(() => {
        throw new Error('storage unavailable');
      });

      service.scheduleAutomaticChecks();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(updater.checkForUpdates).toHaveBeenCalledOnce();
      expect(service.getPreferences().nextCheckAt).toBe(new Date(2026, 7, 30, 10, 0, 0).getTime());
    } finally {
      consoleError.mockRestore();
      vi.useRealTimers();
    }
  });

  test('cancels a pending automatic check when the frequency changes to never', async () => {
    vi.useFakeTimers();
    try {
      const now = new Date(2026, 7, 29, 15, 0, 0).getTime();
      vi.setSystemTime(now);
      const updater = new FakeUpdater();
      updater.checkForUpdates.mockResolvedValue(null);
      const { service } = makeService(updater, true, {
        frequency: AppUpdateCheckFrequency.Daily,
        lastAutomaticCheckAt: new Date(2026, 7, 28, 10, 0, 0).getTime(),
      });

      service.scheduleAutomaticChecks();
      service.setCheckFrequency(AppUpdateCheckFrequency.Never);
      await vi.advanceTimersByTimeAsync(10_000);

      expect(updater.checkForUpdates).not.toHaveBeenCalled();
      expect(service.getPreferences()).not.toHaveProperty('nextCheckAt');
    } finally {
      vi.useRealTimers();
    }
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

describe('resolveNextAutomaticUpdateCheckAt', () => {
  test('checks shortly after startup when the latest daily slot was missed', () => {
    const now = new Date(2026, 7, 29, 15, 0, 0).getTime();

    expect(
      resolveNextAutomaticUpdateCheckAt({
        frequency: AppUpdateCheckFrequency.Daily,
        lastCheckAt: new Date(2026, 7, 28, 10, 0, 0).getTime(),
        now,
      }),
    ).toBe(now + 10_000);
  });

  test('schedules the next local 10:00 slot after a completed daily check', () => {
    const now = new Date(2026, 7, 29, 15, 0, 0).getTime();

    expect(
      resolveNextAutomaticUpdateCheckAt({
        frequency: AppUpdateCheckFrequency.Daily,
        lastCheckAt: new Date(2026, 7, 29, 10, 5, 0).getTime(),
        now,
      }),
    ).toBe(new Date(2026, 7, 30, 10, 0, 0).getTime());
  });

  test('uses Monday at local 10:00 for weekly checks and honors never', () => {
    const wednesday = new Date(2026, 7, 26, 12, 0, 0).getTime();

    expect(
      resolveNextAutomaticUpdateCheckAt({
        frequency: AppUpdateCheckFrequency.Weekly,
        lastCheckAt: new Date(2026, 7, 24, 10, 5, 0).getTime(),
        now: wednesday,
      }),
    ).toBe(new Date(2026, 7, 31, 10, 0, 0).getTime());
    expect(
      resolveNextAutomaticUpdateCheckAt({
        frequency: AppUpdateCheckFrequency.Never,
        lastCheckAt: undefined,
        now: wednesday,
      }),
    ).toBeUndefined();
  });
});
