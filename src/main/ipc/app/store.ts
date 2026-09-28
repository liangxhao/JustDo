import { ipcMain } from 'electron';

import { AppConfigIpc, type AppConfigPatch } from '../../../shared/app/appConfig';
import { buildCustomProviderRenameAliases, ProviderName } from '../../../shared/providers';
import { enqueueAppConfigUpdate } from '../../data/appConfigUpdateQueue';
import type { SqliteStore } from '../../data/sqliteStore';

interface StoreHandlerDependencies {
  getStore: () => SqliteStore;
  onAppConfigChanged: (nextConfig: unknown, previousConfig: unknown) => Promise<void>;
  refreshBuiltinModels: () => Promise<void>;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

// The built-in catalog is owned by Main. Settings may edit model enable flags,
// but an older settings snapshot must not restore removed models or logged-out access.
const mergeProviderPatch = (previous: unknown, incoming: unknown): unknown => {
  const providers = asRecord(incoming);
  if (!providers) return incoming;
  const merged = { ...providers };
  const currentBuiltin = asRecord(asRecord(previous)?.[ProviderName.BuiltinModels]);
  const draftBuiltin = asRecord(providers[ProviderName.BuiltinModels]);
  if (!currentBuiltin) {
    delete merged[ProviderName.BuiltinModels];
    return merged;
  }
  const enabledById = new Map(
    (Array.isArray(draftBuiltin?.models) ? draftBuiltin.models : []).flatMap(value => {
      const model = asRecord(value);
      return typeof model?.id === 'string' && typeof model.enabled === 'boolean'
        ? [[model.id, model.enabled] as const]
        : [];
    }),
  );
  merged[ProviderName.BuiltinModels] = {
    ...currentBuiltin,
    models: (Array.isArray(currentBuiltin.models) ? currentBuiltin.models : []).map(value => {
      const model = asRecord(value);
      return model && typeof model.id === 'string' && enabledById.has(model.id)
        ? { ...model, enabled: enabledById.get(model.id) }
        : value;
    }),
  };
  return merged;
};

export const registerStoreHandlers = ({
  getStore,
  onAppConfigChanged,
  refreshBuiltinModels,
}: StoreHandlerDependencies): void => {
  const persistAppConfig = async (value: unknown, previous: unknown): Promise<void> => {
    const store = getStore();
    try {
      store.set('app_config', value);
      await onAppConfigChanged(value, previous);
    } catch (error) {
      try {
        if (previous === undefined) store.delete('app_config');
        else store.set('app_config', previous);
        await onAppConfigChanged(previous, value);
      } catch (rollbackError) {
        console.error('[StoreIPC] Failed to re-apply the previous app config:', rollbackError);
      }
      throw error;
    }
  };

  ipcMain.handle(AppConfigIpc.Patch, (_event, patch: AppConfigPatch) =>
    enqueueAppConfigUpdate(async () => {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new Error('App config patch must be an object');
      }
      const previous = getStore().get<AppConfigPatch>('app_config');
      const next = { ...previous, ...patch };
      if (patch.providers)
        next.providers = mergeProviderPatch(previous?.providers, patch.providers);
      if (patch.providers && next.model && typeof next.model === 'object') {
        const model = next.model as Record<string, unknown>;
        const aliases = buildCustomProviderRenameAliases(previous?.providers, patch.providers);
        const provider = model.defaultModelProvider;
        if (typeof provider === 'string' && aliases[provider]) {
          next.model = { ...model, defaultModelProvider: aliases[provider] };
        }
      }
      await persistAppConfig(next, previous);
      return getStore().get<AppConfigPatch>('app_config') ?? next;
    }),
  );

  ipcMain.handle('store:get', (_event, key) => {
    // Renderer reads must observe a committed config, after runtime application
    // and any rollback. Main-process synchronization still reads the store directly.
    if (key === 'app_config') {
      return enqueueAppConfigUpdate(async () => getStore().get(key));
    }
    return getStore().get(key);
  });

  ipcMain.handle('store:set', async (_event, key, value) => {
    const store = getStore();
    if (key !== 'app_config') {
      store.set(key, value);
      return;
    }

    return enqueueAppConfigUpdate(async () => {
      const previous = store.get(key);
      await persistAppConfig(value, previous);
    });
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
