import { afterEach, describe, expect, test, vi } from 'vitest';

import type { CoworkSession, CoworkStore } from '../../data/coworkStore';
import { SessionPermissionModeCoordinator } from './sessionPermissionModeCoordinator';

const createHarness = () => {
  let active = false;
  let session = {
    id: 'session-1',
    cwd: 'C:\\workspace',
    agentId: 'main',
    permissionMode: 'full',
  } as CoworkSession;
  const updateSession = vi.fn(
    (sessionId: string, update: Partial<Pick<CoworkSession, 'permissionMode'>>) => {
      if (sessionId === session.id) session = { ...session, ...update };
    },
  );
  const prepareSession = vi.fn().mockResolvedValue(undefined);
  const store = {
    getSession: (sessionId: string) => (sessionId === session.id ? session : null),
    updateSession,
  } as unknown as CoworkStore;
  const coordinator = new SessionPermissionModeCoordinator({
    getCoworkStore: () => store,
    isSessionActive: () => active,
    prepareSession,
  });
  return {
    coordinator,
    getSession: () => session,
    prepareSession,
    setActive: (value: boolean) => {
      active = value;
    },
    updateSession,
  };
};

describe('SessionPermissionModeCoordinator', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('persists the selected mode before applying the native OpenClaw session policy', async () => {
    const { coordinator, getSession, prepareSession, updateSession } = createHarness();

    await expect(coordinator.setSessionMode('session-1', 'ask')).resolves.toEqual({ success: true });

    expect(prepareSession).toHaveBeenCalledWith({
      sessionId: 'session-1',
      permissionMode: 'ask',
      workspaceRoot: 'C:\\workspace',
      agentId: 'main',
    });
    expect(updateSession).toHaveBeenCalledWith('session-1', { permissionMode: 'ask' });
    expect(updateSession.mock.invocationCallOrder[0]).toBeLessThan(
      prepareSession.mock.invocationCallOrder[0]!,
    );
    expect(getSession().permissionMode).toBe('ask');
  });

  test('reconciles an unchanged local mode so legacy Gateway sessions are repaired', async () => {
    const { coordinator, prepareSession, updateSession } = createHarness();

    await expect(coordinator.setSessionMode('session-1', 'full')).resolves.toEqual({ success: true });

    expect(prepareSession).toHaveBeenCalledOnce();
    expect(updateSession).not.toHaveBeenCalled();
  });

  test('keeps the selected mode pending when immediate native application fails', async () => {
    const { coordinator, getSession, prepareSession, updateSession } = createHarness();
    prepareSession.mockRejectedValueOnce(new Error('Gateway rejected permissionMode'));

    await expect(
      coordinator.setSessionMode('session-1', 'auto', { deferIfActive: true }),
    ).resolves.toEqual({ success: true, deferred: true });

    expect(updateSession).toHaveBeenCalledWith('session-1', { permissionMode: 'auto' });
    expect(getSession().permissionMode).toBe('auto');
  });

  test('retries a deferred native application failure in the background', async () => {
    vi.useFakeTimers();
    const { coordinator, prepareSession } = createHarness();
    prepareSession.mockRejectedValueOnce(new Error('Gateway unavailable'));

    await expect(
      coordinator.setSessionMode('session-1', 'ask', { deferIfActive: true }),
    ).resolves.toEqual({ success: true, deferred: true });

    await vi.advanceTimersByTimeAsync(3_000);

    expect(prepareSession).toHaveBeenCalledTimes(2);
    expect(prepareSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ permissionMode: 'ask' }),
    );
  });

  test('does not contact OpenClaw when local persistence fails', async () => {
    const { coordinator, prepareSession, updateSession } = createHarness();
    updateSession.mockImplementationOnce(() => {
      throw new Error('database unavailable');
    });

    await expect(coordinator.setSessionMode('session-1', 'ask')).resolves.toEqual({
      success: false,
      error: 'database unavailable',
    });

    expect(prepareSession).not.toHaveBeenCalled();
  });

  test('defers an active-run change and applies the latest stored mode after completion', async () => {
    const { coordinator, getSession, prepareSession, setActive } = createHarness();
    setActive(true);

    await expect(
      coordinator.setSessionMode('session-1', 'ask', { deferIfActive: true }),
    ).resolves.toEqual({ success: true, deferred: true });
    expect(getSession().permissionMode).toBe('ask');
    expect(prepareSession).not.toHaveBeenCalled();

    setActive(false);
    await expect(coordinator.applyPendingSessionMode('session-1')).resolves.toEqual({
      success: true,
    });
    expect(prepareSession).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: 'ask' }),
    );
  });

  test('fails strict pre-turn reconciliation while the previous run is active', async () => {
    const { coordinator, getSession, prepareSession, setActive } = createHarness();
    setActive(true);

    await expect(coordinator.setSessionMode('session-1', 'ask')).resolves.toEqual({
      success: false,
      error: 'The previous run is still active.',
    });
    expect(getSession().permissionMode).toBe('ask');
    expect(prepareSession).not.toHaveBeenCalled();
  });

  test('serializes changes for the same session', async () => {
    const { coordinator, prepareSession } = createHarness();
    let releaseFirst!: () => void;
    prepareSession.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          releaseFirst = resolve;
        }),
    );

    const first = coordinator.setSessionMode('session-1', 'ask');
    const second = coordinator.setSessionMode('session-1', 'auto');
    await vi.waitFor(() => expect(prepareSession).toHaveBeenCalledTimes(1));

    releaseFirst();
    await expect(first).resolves.toEqual({ success: true });
    await expect(second).resolves.toEqual({ success: true });
    expect(prepareSession).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ permissionMode: 'auto' }),
    );
  });

  test('serializes terminal continuation preparation behind the latest mode change', async () => {
    const { coordinator, prepareSession } = createHarness();
    let releaseFirst!: () => void;
    prepareSession.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          releaseFirst = resolve;
        }),
    );

    const firstChange = coordinator.setSessionMode('session-1', 'ask');
    const latestChange = coordinator.setSessionMode('session-1', 'auto');
    const continuation = coordinator.prepareSessionForRun('session-1');
    await vi.waitFor(() => expect(prepareSession).toHaveBeenCalledTimes(1));

    releaseFirst();
    await expect(firstChange).resolves.toEqual({ success: true });
    await expect(latestChange).resolves.toEqual({ success: true });
    await expect(continuation).resolves.toEqual({ success: true });
    expect(prepareSession).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ permissionMode: 'auto' }),
    );
    expect(prepareSession).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ permissionMode: 'auto' }),
    );
  });

  test('rejects a missing session before contacting OpenClaw', async () => {
    const { coordinator, prepareSession } = createHarness();

    await expect(coordinator.setSessionMode('missing', 'ask')).resolves.toEqual({
      success: false,
      error: 'Session not found.',
    });
    expect(prepareSession).not.toHaveBeenCalled();
  });
});
