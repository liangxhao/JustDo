import { app, ipcMain, powerSaveBlocker } from 'electron';
import fs from 'fs';
import path from 'path';

import { type BuildInfo, UNKNOWN_BUILD_INFO } from '../../../shared/buildInfo';
import { type DeveloperConfig, DeveloperConfigIpc } from '../../../shared/developerConfig';
import { getAutoLaunchEnabled, setAutoLaunchEnabled } from '../../core/autoLaunchManager';
import type { SqliteStore } from '../../data/sqliteStore';

interface AppHandlerDependencies {
  getStore: () => SqliteStore;
  getPreventSleepBlockerId: () => number | null;
  setPreventSleepBlockerId: (blockerId: number | null) => void;
  getDeveloperConfig: () => DeveloperConfig;
}

export const registerAppHandlers = ({
  getStore,
  getPreventSleepBlockerId,
  setPreventSleepBlockerId,
  getDeveloperConfig,
}: AppHandlerDependencies): void => {
  ipcMain.handle(DeveloperConfigIpc.Get, () => getDeveloperConfig());

  ipcMain.handle('app:getAutoLaunch', () => {
    const stored = getStore().get<boolean>('auto_launch_enabled');
    return { enabled: stored ?? getAutoLaunchEnabled() };
  });

  ipcMain.handle('app:setAutoLaunch', (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') {
      return { success: false, error: 'Invalid parameter: enabled must be boolean' };
    }
    try {
      setAutoLaunchEnabled(enabled);
      getStore().set('auto_launch_enabled', enabled);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to set auto-launch',
      };
    }
  });

  ipcMain.handle('app:getPreventSleep', () => {
    const enabled = getStore().get<boolean>('prevent_sleep_enabled') ?? false;
    return { enabled };
  });

  ipcMain.handle('app:setPreventSleep', (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') {
      return { success: false, error: 'Invalid parameter: enabled must be boolean' };
    }
    try {
      const blockerId = getPreventSleepBlockerId();
      if (enabled) {
        if (blockerId === null || !powerSaveBlocker.isStarted(blockerId)) {
          setPreventSleepBlockerId(powerSaveBlocker.start('prevent-app-suspension'));
        }
      } else if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) {
        powerSaveBlocker.stop(blockerId);
        setPreventSleepBlockerId(null);
      }
      getStore().set('prevent_sleep_enabled', enabled);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to set prevent-sleep',
      };
    }
  });

  ipcMain.handle('app:getVersion', () => app.getVersion());
  ipcMain.handle('app:getBuildInfo', (): BuildInfo => {
    const buildInfoPath = app.isPackaged
      ? path.join(process.resourcesPath, 'build-info.json')
      : path.join(app.getAppPath(), 'resources', 'build-info.json');
    try {
      const value = JSON.parse(fs.readFileSync(buildInfoPath, 'utf8')) as Partial<BuildInfo>;
      if (
        value.schemaVersion !== 1 ||
        typeof value.buildId !== 'string' ||
        typeof value.commit !== 'string' ||
        typeof value.builtAt !== 'string'
      ) {
        return UNKNOWN_BUILD_INFO;
      }
      return { ...UNKNOWN_BUILD_INFO, ...value };
    } catch {
      return UNKNOWN_BUILD_INFO;
    }
  });
  ipcMain.handle('app:getOpenclawVersion', () => {
    try {
      const packagePath = path.join(app.getAppPath(), 'package.json');
      const packageMetadata = JSON.parse(fs.readFileSync(packagePath, 'utf-8')) as {
        openclaw?: { version?: string };
      };
      return packageMetadata.openclaw?.version ?? 'unknown';
    } catch {
      return 'unknown';
    }
  });
  ipcMain.handle('app:getSystemLocale', () => app.getLocale());
};
