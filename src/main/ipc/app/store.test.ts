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

  it('waits for the persisted app config to be applied', async () => {
    let resolveApplication: (() => void) | undefined;
    onAppConfigChanged.mockReturnValue(
      new Promise<void>(resolve => {
        resolveApplication = resolve;
      }),
    );
    const config = { providers: { custom_0: { enabled: true } } };

    const result = handlers.get('store:set')?.({}, 'app_config', config) as Promise<void>;
    await Promise.resolve();

    expect(set).toHaveBeenCalledWith('app_config', config);
    expect(onAppConfigChanged).toHaveBeenCalledWith(config, undefined);
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    expect(settled).toBe(false);

    resolveApplication?.();
    await expect(result).resolves.toBeUndefined();
  });

  it('rolls back app config and rejects when runtime application fails', async () => {
    const error = new Error('reload failed');
    const previous = { providers: { custom_0: { displayName: 'Previous' } } };
    get.mockReturnValue(previous);
    onAppConfigChanged.mockRejectedValueOnce(error).mockResolvedValueOnce(undefined);

    const result = handlers.get('store:set')?.({}, 'app_config', {}) as Promise<void>;

    await expect(result).rejects.toThrow('reload failed');
    expect(set).toHaveBeenNthCalledWith(1, 'app_config', {});
    expect(set).toHaveBeenNthCalledWith(2, 'app_config', previous);
    expect(onAppConfigChanged).toHaveBeenNthCalledWith(1, {}, previous);
    expect(onAppConfigChanged).toHaveBeenNthCalledWith(2, previous, {});
  });

  it('removes a newly-created app config when its runtime application fails', async () => {
    get.mockReturnValue(undefined);
    onAppConfigChanged.mockRejectedValueOnce(new Error('invalid config'));
    onAppConfigChanged.mockResolvedValueOnce(undefined);

    const result = handlers.get('store:set')?.({}, 'app_config', {}) as Promise<void>;

    await expect(result).rejects.toThrow('invalid config');
    expect(remove).toHaveBeenCalledWith('app_config');
  });

  it('finishes a failed write rollback before applying the next renderer update', async () => {
    onAppConfigChanged
      .mockRejectedValueOnce(new Error('first rejected'))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    const first = { providers: { custom_0: { displayName: 'First' } } };
    const second = { providers: { custom_0: { displayName: 'Second' } } };

    const firstResult = handlers.get('store:set')?.({}, 'app_config', first) as Promise<void>;
    const secondResult = handlers.get('store:set')?.({}, 'app_config', second) as Promise<void>;
    await Promise.resolve();

    expect(set).toHaveBeenCalledTimes(1);
    await expect(firstResult).rejects.toThrow('first rejected');
    await secondResult;
    expect(set).toHaveBeenNthCalledWith(2, 'app_config', second);
    expect(remove).toHaveBeenCalledWith('app_config');
    expect(onAppConfigChanged).toHaveBeenCalledTimes(3);
  });

  it('does not synchronize OpenClaw for unrelated store keys', async () => {
    await handlers.get('store:set')?.({}, 'prevent_sleep_enabled', true);

    expect(set).toHaveBeenCalledWith('prevent_sleep_enabled', true);
    expect(onAppConfigChanged).not.toHaveBeenCalled();
  });
});
