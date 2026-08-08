import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

import type { CoworkConfig } from '../../data/coworkStore';
import { registerCoworkConfigHandlers } from './config';

const baseConfig: CoworkConfig = {
  workingDirectory: 'E:/workspace/project',
  executionMode: 'local',
  agentEngine: 'openclaw',
  permissionMode: 'full',
};

describe('cowork config IPC', () => {
  const syncOpenClawConfig = vi.fn();
  const handleEngineConfigChanged = vi.fn();
  const setConfig = vi.fn();
  let currentConfig: CoworkConfig;

  beforeEach(() => {
    handlers.clear();
    syncOpenClawConfig.mockReset();
    syncOpenClawConfig.mockResolvedValue({ success: true, changed: true });
    handleEngineConfigChanged.mockReset();
    setConfig.mockReset();
    currentConfig = { ...baseConfig };
    setConfig.mockImplementation((update: Partial<CoworkConfig>) => {
      currentConfig = {
        ...currentConfig,
        ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined)),
      };
    });
    registerCoworkConfigHandlers({
      getCoworkStore: () =>
        ({
          getConfig: () => currentConfig,
          setConfig,
        }) as never,
      getCoworkEngineRouter: () => ({ handleEngineConfigChanged }) as never,
      getEngineManager: () => ({ getStatus: () => ({ state: 'running' }) }) as never,
      syncOpenClawConfig,
      ensureEngineRunning: vi.fn(),
      engineNotReadyCode: 'ENGINE_NOT_READY',
    });
  });

  it('rejects an invalid permission mode instead of silently succeeding', async () => {
    const result = await handlers.get('cowork:config:set')?.({}, { permissionMode: 'unsafe' });

    expect(result).toEqual({ success: false, error: 'Invalid permission mode.' });
    expect(setConfig).not.toHaveBeenCalled();
    expect(syncOpenClawConfig).not.toHaveBeenCalled();
  });

  it('hot-updates a global permission change without a workload restriction', async () => {
    const result = await handlers.get('cowork:config:set')?.({}, { permissionMode: 'ask' });

    expect(result).toEqual({ success: true });
    expect(setConfig).toHaveBeenCalledWith({
      workingDirectory: undefined,
      executionMode: undefined,
      agentEngine: undefined,
      permissionMode: 'ask',
    });
    expect(syncOpenClawConfig).toHaveBeenCalledWith({
      reason: 'cowork-config-change',
      restartGatewayIfRunning: false,
    });
  });

  it('rolls back persisted and generated policy when config sync fails', async () => {
    syncOpenClawConfig
      .mockResolvedValueOnce({ success: false, changed: true, error: 'disk full' })
      .mockResolvedValueOnce({ success: true, changed: true });

    const result = await handlers.get('cowork:config:set')?.({}, { permissionMode: 'ask' });

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('preference was rolled back'),
    });
    expect(setConfig).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ permissionMode: 'ask' }),
    );
    expect(setConfig).toHaveBeenNthCalledWith(2, baseConfig);
    expect(syncOpenClawConfig).toHaveBeenNthCalledWith(2, {
      reason: 'cowork-config-change-rollback',
      restartGatewayIfRunning: false,
    });
    expect(currentConfig).toEqual(baseConfig);
  });

  it('reports persisted preference separately when rollback synchronization also fails', async () => {
    syncOpenClawConfig
      .mockResolvedValueOnce({ success: false, changed: true, error: 'apply failed' })
      .mockResolvedValueOnce({ success: false, changed: true, error: 'rollback failed' });

    const result = await handlers.get('cowork:config:set')?.({}, { permissionMode: 'ask' });

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('preference rollback could not be confirmed'),
    });
    expect(result).toMatchObject({
      error: expect.stringContaining('Gateway remains stopped'),
    });
    expect(syncOpenClawConfig).toHaveBeenCalledTimes(2);
    expect(currentConfig).toEqual(baseConfig);
  });

  it('serializes rapid permission changes so an older update cannot overwrite a newer one', async () => {
    let finishFirstSync: ((value: { success: boolean; changed: boolean }) => void) | undefined;
    syncOpenClawConfig
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finishFirstSync = resolve;
          }),
      )
      .mockResolvedValueOnce({ success: true, changed: true });
    const handler = handlers.get('cowork:config:set');

    const first = handler?.({}, { permissionMode: 'ask' });
    const second = handler?.({}, { permissionMode: 'auto' });

    await vi.waitFor(() => expect(setConfig).toHaveBeenCalledTimes(1));
    expect(currentConfig.permissionMode).toBe('ask');

    finishFirstSync?.({ success: true, changed: true });
    await expect(first).resolves.toEqual({ success: true });
    await expect(second).resolves.toEqual({ success: true });
    expect(setConfig).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ permissionMode: 'auto' }),
    );
    expect(currentConfig.permissionMode).toBe('auto');
  });

  it('keeps pure permission changes on the no-restart hot-update path', async () => {
    currentConfig = { ...baseConfig, permissionMode: 'ask' };

    const result = await handlers.get('cowork:config:set')?.({}, { permissionMode: 'auto' });

    expect(result).toEqual({ success: true });
    expect(syncOpenClawConfig).toHaveBeenCalledWith({
      reason: 'cowork-config-change',
      restartGatewayIfRunning: false,
    });
  });

  it('preserves restart fallback for non-permission config changes', async () => {
    const result = await handlers.get('cowork:config:set')?.(
      {},
      { workingDirectory: 'E:/workspace/other-project' },
    );

    expect(result).toEqual({ success: true });
    expect(syncOpenClawConfig).toHaveBeenCalledWith({ reason: 'cowork-config-change' });
  });

  it('preserves restart fallback when permission and other config change together', async () => {
    currentConfig = { ...baseConfig, permissionMode: 'ask' };

    const result = await handlers.get('cowork:config:set')?.(
      {},
      { permissionMode: 'auto', executionMode: 'sandbox' },
    );

    expect(result).toEqual({ success: true });
    expect(syncOpenClawConfig).toHaveBeenCalledWith({ reason: 'cowork-config-change' });
  });
});
