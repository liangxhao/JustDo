import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

import { registerStoreHandlers } from './store';

describe('store IPC', () => {
  const set = vi.fn();
  const get = vi.fn();
  const remove = vi.fn();
  const onAppConfigChanged = vi.fn();
  const refreshBuiltinModels = vi.fn();

  beforeEach(() => {
    handlers.clear();
    set.mockReset();
    get.mockReset();
    remove.mockReset();
    onAppConfigChanged.mockReset();
    refreshBuiltinModels.mockReset();
    registerStoreHandlers({
      getStore: () => ({ set, get, delete: remove }) as never,
      onAppConfigChanged,
      refreshBuiltinModels,
    });
  });

  it('returns after persisting app config without waiting for runtime application', () => {
    onAppConfigChanged.mockReturnValue(new Promise<void>(() => undefined));
    const config = { providers: { custom_0: { enabled: true } } };

    const result = handlers.get('store:set')?.({}, 'app_config', config);

    expect(result).toBeUndefined();
    expect(set).toHaveBeenCalledWith('app_config', config);
    expect(onAppConfigChanged).toHaveBeenCalledOnce();
  });

  it('logs a rejected background app config application', async () => {
    const error = new Error('reload failed');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    onAppConfigChanged.mockRejectedValue(error);

    handlers.get('store:set')?.({}, 'app_config', {});
    await Promise.resolve();

    expect(consoleError).toHaveBeenCalledWith(
      '[StoreIPC] Failed to apply persisted app config:',
      error,
    );
    consoleError.mockRestore();
  });

  it('does not synchronize OpenClaw for unrelated store keys', () => {
    handlers.get('store:set')?.({}, 'prevent_sleep_enabled', true);

    expect(set).toHaveBeenCalledWith('prevent_sleep_enabled', true);
    expect(onAppConfigChanged).not.toHaveBeenCalled();
  });
});
