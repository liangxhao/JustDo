import { describe, expect, test, vi } from 'vitest';

import type { CoworkConfig, CoworkSession, CoworkStore } from '../../data/coworkStore';
import { SessionPermissionModeCoordinator } from './sessionPermissionModeCoordinator';

const createHarness = (options?: { updateSessionError?: Error }) => {
  let config: CoworkConfig = {
    workingDirectory: 'C:\\workspace',
    executionMode: 'local',
    agentEngine: 'openclaw',
    permissionMode: 'full',
  };
  const session = {
    id: 'session-1',
    permissionMode: 'full',
  } as CoworkSession;
  const setConfig = vi.fn((update: Partial<CoworkConfig>) => {
    config = { ...config, ...update };
  });
  const updateSession = vi.fn((_sessionId: string, update: Partial<CoworkSession>) => {
    if (options?.updateSessionError) throw options.updateSessionError;
    Object.assign(session, update);
  });
  const syncOpenClawConfig = vi.fn().mockResolvedValue({ success: true, changed: true });
  const store = {
    getConfig: () => config,
    setConfig,
    getSession: () => session,
    updateSession,
  } as unknown as CoworkStore;
  const coordinator = new SessionPermissionModeCoordinator({
    getCoworkStore: () => store,
    syncOpenClawConfig,
    enqueue: task => task(),
  });
  return { coordinator, getConfig: () => config, session, setConfig, updateSession, syncOpenClawConfig };
};

describe('SessionPermissionModeCoordinator', () => {
  test('atomically activates a turn permission mode', async () => {
    const { coordinator, getConfig } = createHarness();

    const result = await coordinator.acquireForTurn('ask');

    expect(result.success).toBe(true);
    expect(getConfig().permissionMode).toBe('ask');
  });

  test('allows sequential turns to hot-update the shared runtime permission', async () => {
    const { coordinator, getConfig, syncOpenClawConfig } = createHarness();

    await expect(coordinator.acquireForTurn('ask')).resolves.toEqual({ success: true });
    await expect(coordinator.acquireForTurn('auto')).resolves.toEqual({ success: true });

    expect(getConfig().permissionMode).toBe('auto');
    expect(syncOpenClawConfig).toHaveBeenCalledTimes(2);
  });

  test('updates runtime and session persistence in one queued operation', async () => {
    const { coordinator, getConfig, session, updateSession } = createHarness();

    await expect(coordinator.setSessionMode('session-1', 'auto')).resolves.toEqual({
      success: true,
    });
    expect(getConfig().permissionMode).toBe('auto');
    expect(session.permissionMode).toBe('auto');
    expect(updateSession).toHaveBeenCalledWith('session-1', { permissionMode: 'auto' });
  });

  test('hot-updates permission for a session', async () => {
    const { coordinator, getConfig, session } = createHarness();

    await expect(coordinator.setSessionMode('session-1', 'ask')).resolves.toEqual({
      success: true,
    });
    expect(getConfig().permissionMode).toBe('ask');
    expect(session.permissionMode).toBe('ask');
  });

  test('allows a session permission change after other turns have activated modes', async () => {
    const { coordinator, getConfig, session } = createHarness();
    await coordinator.acquireForTurn('ask');
    await coordinator.acquireForTurn('auto');

    await expect(coordinator.setSessionMode('session-1', 'full')).resolves.toEqual({ success: true });
    expect(getConfig().permissionMode).toBe('full');
    expect(session.permissionMode).toBe('full');
  });

  test('rolls runtime back when session persistence fails', async () => {
    const { coordinator, getConfig, syncOpenClawConfig } = createHarness({
      updateSessionError: new Error('database locked'),
    });

    await expect(coordinator.setSessionMode('session-1', 'ask')).resolves.toEqual({
      success: false,
      error: 'database locked',
    });
    expect(getConfig().permissionMode).toBe('full');
    expect(syncOpenClawConfig).toHaveBeenCalledTimes(2);
  });
});
