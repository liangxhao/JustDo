import { describe, expect, test, vi } from 'vitest';

import type { CoworkConfig, CoworkSession, CoworkStore } from '../../data/coworkStore';
import { SessionPermissionModeCoordinator } from './sessionPermissionModeCoordinator';

const createHarness = () => {
  let config: CoworkConfig = {
    workingDirectory: 'C:\\workspace',
    executionMode: 'local',
    agentEngine: 'openclaw',
    permissionMode: 'full',
  };
  const session = { id: 'session-1', permissionMode: 'full' } as CoworkSession;
  const setConfig = vi.fn((update: Partial<CoworkConfig>) => {
    config = { ...config, ...update };
  });
  const syncOpenClawConfig = vi.fn().mockResolvedValue({ success: true, changed: true });
  const store = {
    getConfig: () => config,
    setConfig,
    getSession: (sessionId: string) => (sessionId === session.id ? session : null),
  } as unknown as CoworkStore;
  const coordinator = new SessionPermissionModeCoordinator({
    getCoworkStore: () => store,
    syncOpenClawConfig,
    enqueue: task => task(),
  });
  return { coordinator, getConfig: () => config, session, syncOpenClawConfig };
};

describe('SessionPermissionModeCoordinator', () => {
  test('keeps the legacy session IPC global without mutating the session snapshot', async () => {
    const { coordinator, getConfig, session } = createHarness();

    await expect(coordinator.setSessionMode('session-1', 'ask')).resolves.toEqual({ success: true });

    expect(getConfig().permissionMode).toBe('ask');
    expect(session.permissionMode).toBe('full');
  });

  test('rejects the legacy session IPC for a missing session', async () => {
    const { coordinator, getConfig } = createHarness();

    await expect(coordinator.setSessionMode('missing', 'ask')).resolves.toEqual({
      success: false,
      error: 'Session not found.',
    });
    expect(getConfig().permissionMode).toBe('full');
  });
});
