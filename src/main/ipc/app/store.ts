import { ipcMain } from 'electron';

import type { SqliteStore } from '../../data/sqliteStore';

interface StoreHandlerDependencies {
  getStore: () => SqliteStore;
  onAppConfigChanged: (nextConfig: unknown, previousConfig: unknown) => Promise<void>;
  refreshBuiltinModels: () => Promise<void>;
}

export const registerStoreHandlers = ({
  getStore,
  onAppConfigChanged,
  refreshBuiltinModels,
}: StoreHandlerDependencies): void => {
  let appConfigUpdateQueue: Promise<void> = Promise.resolve();

  ipcMain.handle('store:get', (_event, key) => {
    return getStore().get(key);
  });

  ipcMain.handle('store:set', async (_event, key, value) => {
    const store = getStore();
    if (key !== 'app_config') {
      store.set(key, value);
      return;
    }

    const update = appConfigUpdateQueue.then(async () => {
      const previous = store.get(key);
      try {
        store.set(key, value);
        await onAppConfigChanged(value, previous);
      } catch (error) {
        try {
          if (previous === undefined) {
            store.delete(key);
          } else {
            store.set(key, previous);
          }
          await onAppConfigChanged(previous, value);
        } catch (rollbackError) {
          console.error('[StoreIPC] Failed to re-apply the previous app config:', rollbackError);
        }
        throw error;
      }
    });
    appConfigUpdateQueue = update.catch((): void => undefined);
    return update;
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
