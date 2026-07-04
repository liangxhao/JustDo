import { ipcMain } from 'electron';

import type { SqliteStore } from '../data/sqliteStore';

interface StoreHandlerDependencies {
  getStore: () => SqliteStore;
  onAppConfigChanged: () => Promise<void>;
  refreshBuiltinModels: () => Promise<void>;
}

export const registerStoreHandlers = ({
  getStore,
  onAppConfigChanged,
  refreshBuiltinModels,
}: StoreHandlerDependencies): void => {
  ipcMain.handle('store:get', (_event, key) => {
    return getStore().get(key);
  });

  ipcMain.handle('store:set', async (_event, key, value) => {
    getStore().set(key, value);
    if (key === 'app_config') {
      await onAppConfigChanged();
    }
  });

  ipcMain.handle('store:remove', (_event, key) => {
    getStore().delete(key);
  });

  ipcMain.handle('builtinModels:refresh', async () => {
    try {
      await refreshBuiltinModels();
      return { success: true };
    } catch (error) {
      console.error('[BuiltinModelProvider] Manual refresh failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to refresh builtin models',
      };
    }
  });
};
