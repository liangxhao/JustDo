import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { SessionRunBeginErrorCode } from '../../../shared/cowork/sessionRun';
import type { CoworkStore } from '../../data/coworkStore';
import type { CoworkEngineRouter } from '../../engine';

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: mocks.handle,
  },
}));

import { registerCoworkSessionHandlers } from './sessions';

type IpcHandler = (...args: unknown[]) => Promise<unknown>;

const registerHandlers = (stopSession: ReturnType<typeof vi.fn>): IpcHandler => {
  const router = {
    stopSession,
  } as unknown as CoworkEngineRouter;
  registerCoworkSessionHandlers({
    getCoworkStore: () => ({}) as CoworkStore,
    getCoworkEngineRouter: () => router,
    setSessionPermissionMode: vi.fn(),
  });
  const registration = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'cowork:session:stop',
  );
  expect(registration).toBeDefined();
  return registration?.[1] as IpcHandler;
};

beforeEach(() => {
  mocks.handle.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

test('waits for the runtime to confirm a session stop before reporting success', async () => {
  let confirmStop: (() => void) | undefined;
  const stopSession = vi.fn(
    () =>
      new Promise<void>(resolve => {
        confirmStop = resolve;
      }),
  );
  const handler = registerHandlers(stopSession);

  let settled = false;
  const resultPromise = handler({}, 'session-1').finally(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);

  confirmStop?.();
  await expect(resultPromise).resolves.toEqual({ success: true });
});

test('registers session handlers without reading the not-yet-initialized store', () => {
  const getCoworkStore = vi.fn(() => {
    throw new Error('Store not initialized');
  });

  expect(() =>
    registerCoworkSessionHandlers({
      getCoworkStore,
      getCoworkEngineRouter: () => ({ stopSession: vi.fn() }) as unknown as CoworkEngineRouter,
      setSessionPermissionMode: vi.fn(),
    }),
  ).not.toThrow();
  expect(getCoworkStore).not.toHaveBeenCalled();
});

test('reports failure when the runtime cannot confirm a session stop', async () => {
  const handler = registerHandlers(vi.fn().mockRejectedValue(new Error('abort unavailable')));

  await expect(handler({}, 'session-1')).resolves.toEqual({
    success: false,
    error: 'abort unavailable',
  });
});

test('persists a valid permission mode for an existing session', async () => {
  const setSessionPermissionMode = vi.fn().mockResolvedValue({ success: true });
  registerCoworkSessionHandlers({
    getCoworkStore: () => ({}) as CoworkStore,
    getCoworkEngineRouter: () => ({ stopSession: vi.fn() }) as unknown as CoworkEngineRouter,
    setSessionPermissionMode,
  });
  const registration = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'cowork:session:setPermissionMode',
  );
  const handler = registration?.[1] as IpcHandler;

  await expect(handler({}, { sessionId: 'session-1', permissionMode: 'ask' })).resolves.toEqual({
    success: true,
  });
  expect(setSessionPermissionMode).toHaveBeenCalledWith('session-1', 'ask', {
    deferIfActive: false,
  });
});

test('forwards active-run deferral and reports the persisted selection as successful', async () => {
  const setSessionPermissionMode = vi.fn().mockResolvedValue({
    success: true,
    deferred: true,
  });
  registerCoworkSessionHandlers({
    getCoworkStore: () => ({}) as CoworkStore,
    getCoworkEngineRouter: () => ({ stopSession: vi.fn() }) as unknown as CoworkEngineRouter,
    setSessionPermissionMode,
  });
  const registration = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'cowork:session:setPermissionMode',
  );
  const handler = registration?.[1] as IpcHandler;

  await expect(
    handler({}, { sessionId: 'session-1', permissionMode: 'auto', deferIfActive: true }),
  ).resolves.toEqual({ success: true, deferred: true });
  expect(setSessionPermissionMode).toHaveBeenCalledWith('session-1', 'auto', {
    deferIfActive: true,
  });
});

test('rejects an invalid session permission mode', async () => {
  const setSessionPermissionMode = vi.fn();
  registerCoworkSessionHandlers({
    getCoworkStore: () => ({}) as CoworkStore,
    getCoworkEngineRouter: () => ({ stopSession: vi.fn() }) as unknown as CoworkEngineRouter,
    setSessionPermissionMode,
  });
  const registration = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'cowork:session:setPermissionMode',
  );
  const handler = registration?.[1] as IpcHandler;

  await expect(handler({}, { sessionId: 'session-1', permissionMode: 'unsafe' })).resolves.toEqual({
    success: false,
    error: 'Invalid session permission mode.',
  });
  expect(setSessionPermissionMode).not.toHaveBeenCalled();
});

test('freezes the persisted timer on the same second confirmed-idle snapshot', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  const runningTiming = {
    id: 'timing-1',
    sessionId: 'session-1',
    clientTurnId: 'run-1',
    rootRunId: 'run-1',
    startedAt: 1_000,
    acceptedAt: 1_100,
    state: 'running' as const,
  };
  const finishSessionRun = vi.fn((_id, _state, endedAt: number) => ({
    ...runningTiming,
    state: 'completed' as const,
    endedAt,
  }));
  const store = {
    getLatestSessionRun: vi.fn().mockReturnValue(runningTiming),
    getSession: vi.fn().mockReturnValue({ status: 'idle' }),
    finishSessionRun,
  } as unknown as CoworkStore;
  const router = {
    getSessionRuntimeStatus: vi.fn().mockResolvedValue({
      known: true,
      mainRunning: false,
      subagentRunning: false,
      running: false,
    }),
  } as unknown as CoworkEngineRouter;
  registerCoworkSessionHandlers({
    getCoworkStore: () => store,
    getCoworkEngineRouter: () => router,
    setSessionPermissionMode: vi.fn(),
  });
  const handler = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'cowork:session:runtimeStatus',
  )?.[1] as IpcHandler;

  await expect(handler({}, 'session-1')).resolves.toMatchObject({
    success: true,
    running: true,
    timing: runningTiming,
  });
  await vi.advanceTimersByTimeAsync(750);
  await expect(handler({}, 'session-1')).resolves.toMatchObject({
    success: true,
    running: false,
    timing: { state: 'completed', endedAt: expect.any(Number) },
  });
  expect(finishSessionRun).toHaveBeenCalledOnce();
});

test('preserves a known-idle confirmation across a truncated unknown snapshot', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  const runningTiming = {
    id: 'timing-paginated',
    sessionId: 'session-1',
    clientTurnId: 'run-paginated',
    rootRunId: 'run-paginated',
    startedAt: 1_000,
    acceptedAt: 1_100,
    state: 'running' as const,
  };
  const finishSessionRun = vi.fn((_id, _state, endedAt: number) => ({
    ...runningTiming,
    state: 'completed' as const,
    endedAt,
  }));
  const store = {
    getLatestSessionRun: vi.fn().mockReturnValue(runningTiming),
    getSession: vi.fn().mockReturnValue({ status: 'idle' }),
    finishSessionRun,
  } as unknown as CoworkStore;
  const getSessionRuntimeStatus = vi
    .fn()
    .mockResolvedValueOnce({
      known: true,
      mainRunning: false,
      subagentRunning: false,
      running: false,
    })
    .mockResolvedValueOnce({
      known: false,
      mainRunning: false,
      subagentRunning: false,
      running: false,
    })
    .mockResolvedValueOnce({
      known: true,
      mainRunning: false,
      subagentRunning: false,
      running: false,
    });
  registerCoworkSessionHandlers({
    getCoworkStore: () => store,
    getCoworkEngineRouter: () => ({ getSessionRuntimeStatus }) as unknown as CoworkEngineRouter,
    setSessionPermissionMode: vi.fn(),
  });
  const handler = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'cowork:session:runtimeStatus',
  )?.[1] as IpcHandler;

  await expect(handler({}, 'session-1')).resolves.toMatchObject({
    success: true,
    known: true,
    running: true,
  });
  await vi.advanceTimersByTimeAsync(750);
  await expect(handler({}, 'session-1')).resolves.toMatchObject({
    success: true,
    known: false,
    running: true,
  });
  await expect(handler({}, 'session-1')).resolves.toMatchObject({
    success: true,
    known: true,
    running: false,
    timing: { state: 'completed' },
  });
  expect(finishSessionRun).toHaveBeenCalledOnce();
});

test('resets idle confirmation when aggregate runtime becomes active again', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  const runningTiming = {
    id: 'timing-resumed',
    sessionId: 'session-1',
    clientTurnId: 'run-resumed',
    rootRunId: 'run-resumed',
    startedAt: 1_000,
    acceptedAt: 1_100,
    state: 'running' as const,
  };
  const finishSessionRun = vi.fn((_id, _state, endedAt: number) => ({
    ...runningTiming,
    state: 'completed' as const,
    endedAt,
  }));
  const store = {
    getLatestSessionRun: vi.fn().mockReturnValue(runningTiming),
    getSession: vi.fn().mockReturnValue({ status: 'idle' }),
    finishSessionRun,
  } as unknown as CoworkStore;
  const getSessionRuntimeStatus = vi
    .fn()
    .mockResolvedValueOnce({
      known: true,
      mainRunning: false,
      subagentRunning: false,
      running: false,
    })
    .mockResolvedValueOnce({
      known: true,
      mainRunning: false,
      subagentRunning: true,
      running: true,
    })
    .mockResolvedValue({
      known: true,
      mainRunning: false,
      subagentRunning: false,
      running: false,
    });
  registerCoworkSessionHandlers({
    getCoworkStore: () => store,
    getCoworkEngineRouter: () => ({ getSessionRuntimeStatus }) as unknown as CoworkEngineRouter,
    setSessionPermissionMode: vi.fn(),
  });
  const handler = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'cowork:session:runtimeStatus',
  )?.[1] as IpcHandler;

  await expect(handler({}, 'session-1')).resolves.toMatchObject({ running: true });
  await vi.advanceTimersByTimeAsync(750);
  await expect(handler({}, 'session-1')).resolves.toMatchObject({
    mainRunning: false,
    subagentRunning: true,
    running: true,
  });
  await expect(handler({}, 'session-1')).resolves.toMatchObject({ running: true });
  expect(finishSessionRun).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(750);
  await expect(handler({}, 'session-1')).resolves.toMatchObject({
    running: false,
    timing: { state: 'completed' },
  });
  expect(finishSessionRun).toHaveBeenCalledOnce();
});

test('does not finalize a submitted run before Gateway acceptance is observed', async () => {
  const submittedTiming = {
    id: 'timing-pending',
    sessionId: 'session-1',
    clientTurnId: 'run-pending',
    rootRunId: 'run-pending',
    startedAt: 1_000,
    state: 'running' as const,
  };
  const finishSessionRun = vi.fn();
  const store = {
    getLatestSessionRun: vi.fn().mockReturnValue(submittedTiming),
    finishSessionRun,
  } as unknown as CoworkStore;
  const router = {
    getSessionRuntimeStatus: vi.fn().mockResolvedValue({
      known: true,
      mainRunning: false,
      subagentRunning: false,
      running: false,
    }),
  } as unknown as CoworkEngineRouter;
  registerCoworkSessionHandlers({
    getCoworkStore: () => store,
    getCoworkEngineRouter: () => router,
    setSessionPermissionMode: vi.fn(),
  });
  const handler = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'cowork:session:runtimeStatus',
  )?.[1] as IpcHandler;

  await expect(handler({}, 'session-1')).resolves.toMatchObject({
    success: true,
    running: true,
    timing: submittedTiming,
  });
  expect(finishSessionRun).not.toHaveBeenCalled();
});

test('reopens a completed receipt only when the active root run matches', async () => {
  const completedTiming = {
    id: 'timing-1',
    sessionId: 'session-1',
    clientTurnId: 'client-turn-1',
    rootRunId: 'gateway-run-1',
    startedAt: 1_000,
    acceptedAt: 1_100,
    endedAt: 6_000,
    state: 'completed' as const,
  };
  const reopenedTiming = {
    ...completedTiming,
    endedAt: undefined,
    state: 'running' as const,
  };
  const reopenSessionRun = vi.fn().mockReturnValue(reopenedTiming);
  const beginSessionRun = vi.fn();
  const store = {
    getLatestSessionRun: vi.fn().mockReturnValue(completedTiming),
    reopenSessionRun,
    beginSessionRun,
  } as unknown as CoworkStore;
  const router = {
    getSessionRuntimeStatus: vi.fn().mockResolvedValue({
      known: true,
      mainRunning: true,
      subagentRunning: false,
      running: true,
      rootRunId: 'gateway-run-1',
    }),
  } as unknown as CoworkEngineRouter;
  registerCoworkSessionHandlers({
    getCoworkStore: () => store,
    getCoworkEngineRouter: () => router,
    setSessionPermissionMode: vi.fn(),
  });
  const handler = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'cowork:session:runtimeStatus',
  )?.[1] as IpcHandler;

  await expect(handler({}, 'session-1')).resolves.toMatchObject({
    success: true,
    running: true,
    timing: reopenedTiming,
  });
  expect(reopenSessionRun).toHaveBeenCalledWith('timing-1');
  expect(beginSessionRun).not.toHaveBeenCalled();
});

test('reopens a restart checkpoint while an active Gateway run has no root id yet', async () => {
  const checkpointTiming = {
    id: 'timing-checkpoint',
    sessionId: 'session-1',
    clientTurnId: 'client-turn-1',
    rootRunId: 'client-turn-1',
    startedAt: 10_000,
    acceptedAt: 10_000,
    endedAt: 10_000,
    state: 'aborted' as const,
  };
  const reopenedTiming = {
    ...checkpointTiming,
    endedAt: undefined,
    state: 'running' as const,
  };
  const reopenSessionRun = vi.fn().mockReturnValue(reopenedTiming);
  const beginSessionRun = vi.fn();
  const store = {
    getLatestSessionRun: vi.fn().mockReturnValue(checkpointTiming),
    reopenSessionRun,
    beginSessionRun,
  } as unknown as CoworkStore;
  const router = {
    getSessionRuntimeStatus: vi.fn().mockResolvedValue({
      known: true,
      mainRunning: true,
      subagentRunning: false,
      running: true,
    }),
  } as unknown as CoworkEngineRouter;
  registerCoworkSessionHandlers({
    getCoworkStore: () => store,
    getCoworkEngineRouter: () => router,
    setSessionPermissionMode: vi.fn(),
  });
  const handler = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'cowork:session:runtimeStatus',
  )?.[1] as IpcHandler;

  await expect(handler({}, 'session-1')).resolves.toMatchObject({
    success: true,
    running: true,
    timing: reopenedTiming,
  });
  expect(reopenSessionRun).toHaveBeenCalledWith('timing-checkpoint');
  expect(beginSessionRun).not.toHaveBeenCalled();
});

test('rejects a new run when startup reconciliation finds the checkpoint still active', async () => {
  const checkpointTiming = {
    id: 'timing-checkpoint',
    sessionId: 'session-1',
    clientTurnId: 'client-turn-1',
    rootRunId: 'client-turn-1',
    startedAt: 10_000,
    acceptedAt: 10_000,
    endedAt: 10_000,
    state: 'aborted' as const,
  };
  const reopenedTiming = {
    ...checkpointTiming,
    endedAt: undefined,
    state: 'running' as const,
  };
  const reopenSessionRun = vi.fn().mockReturnValue(reopenedTiming);
  const beginSessionRun = vi.fn();
  const store = {
    getLatestSessionRun: vi.fn().mockReturnValue(checkpointTiming),
    reopenSessionRun,
    beginSessionRun,
  } as unknown as CoworkStore;
  const getSessionRuntimeStatus = vi.fn().mockResolvedValue({
    known: true,
    mainRunning: true,
    subagentRunning: false,
    running: true,
  });
  registerCoworkSessionHandlers({
    getCoworkStore: () => store,
    getCoworkEngineRouter: () => ({ getSessionRuntimeStatus }) as unknown as CoworkEngineRouter,
    setSessionPermissionMode: vi.fn(),
  });
  const handler = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'cowork:session:run:begin',
  )?.[1] as IpcHandler;

  await expect(
    handler({}, { sessionId: 'session-1', clientTurnId: 'client-turn-2', startedAt: 11_000 }),
  ).resolves.toMatchObject({
    success: false,
    errorCode: SessionRunBeginErrorCode.RuntimeActive,
    snapshot: { running: true, timing: reopenedTiming },
  });
  expect(getSessionRuntimeStatus).toHaveBeenCalledWith('session-1', {
    includeSubagents: true,
    forceRefresh: true,
    fullScan: true,
  });
  expect(reopenSessionRun).toHaveBeenCalledWith('timing-checkpoint');
  expect(beginSessionRun).not.toHaveBeenCalled();
});

test('fails closed when a restart checkpoint cannot be confirmed idle', async () => {
  const checkpointTiming = {
    id: 'timing-checkpoint',
    sessionId: 'session-1',
    clientTurnId: 'client-turn-1',
    rootRunId: 'client-turn-1',
    startedAt: 10_000,
    acceptedAt: 10_000,
    endedAt: 10_000,
    state: 'aborted' as const,
  };
  const beginSessionRun = vi.fn();
  const store = {
    getLatestSessionRun: vi.fn().mockReturnValue(checkpointTiming),
    beginSessionRun,
  } as unknown as CoworkStore;
  const getSessionRuntimeStatus = vi.fn().mockResolvedValue({
    known: false,
    mainRunning: false,
    subagentRunning: false,
    running: false,
  });
  registerCoworkSessionHandlers({
    getCoworkStore: () => store,
    getCoworkEngineRouter: () => ({ getSessionRuntimeStatus }) as unknown as CoworkEngineRouter,
    setSessionPermissionMode: vi.fn(),
  });
  const handler = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'cowork:session:run:begin',
  )?.[1] as IpcHandler;

  await expect(
    handler({}, { sessionId: 'session-1', clientTurnId: 'client-turn-2', startedAt: 11_000 }),
  ).resolves.toEqual({
    success: false,
    errorCode: SessionRunBeginErrorCode.RuntimeUnknown,
  });
  expect(getSessionRuntimeStatus).toHaveBeenCalledWith('session-1', {
    includeSubagents: true,
    forceRefresh: true,
    fullScan: true,
  });
  expect(beginSessionRun).not.toHaveBeenCalled();
});

test('allows a new run after a restart checkpoint is confirmed idle', async () => {
  const checkpointTiming = {
    id: 'timing-checkpoint',
    sessionId: 'session-1',
    clientTurnId: 'client-turn-1',
    rootRunId: 'client-turn-1',
    startedAt: 10_000,
    acceptedAt: 10_000,
    endedAt: 10_000,
    state: 'aborted' as const,
  };
  const newTiming = {
    id: 'timing-new',
    sessionId: 'session-1',
    clientTurnId: 'client-turn-2',
    rootRunId: 'client-turn-2',
    startedAt: 11_000,
    state: 'running' as const,
  };
  const beginSessionRun = vi.fn().mockReturnValue(newTiming);
  const store = {
    getLatestSessionRun: vi.fn().mockReturnValue(checkpointTiming),
    beginSessionRun,
  } as unknown as CoworkStore;
  const getSessionRuntimeStatus = vi.fn().mockResolvedValue({
    known: true,
    mainRunning: false,
    subagentRunning: false,
    running: false,
  });
  registerCoworkSessionHandlers({
    getCoworkStore: () => store,
    getCoworkEngineRouter: () => ({ getSessionRuntimeStatus }) as unknown as CoworkEngineRouter,
    setSessionPermissionMode: vi.fn(),
  });
  const handler = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'cowork:session:run:begin',
  )?.[1] as IpcHandler;
  const input = { sessionId: 'session-1', clientTurnId: 'client-turn-2', startedAt: 11_000 };

  await expect(handler({}, input)).resolves.toMatchObject({
    success: true,
    timing: newTiming,
    snapshot: { running: true, timing: newTiming },
  });
  expect(getSessionRuntimeStatus).toHaveBeenCalledWith('session-1', {
    includeSubagents: true,
    forceRefresh: true,
    fullScan: true,
  });
  expect(beginSessionRun).toHaveBeenCalledWith(input);
});

test('starts a separate recovery clock for an unrelated active root run', async () => {
  const completedTiming = {
    id: 'timing-1',
    sessionId: 'session-1',
    clientTurnId: 'client-turn-1',
    rootRunId: 'gateway-run-1',
    startedAt: 1_000,
    acceptedAt: 1_100,
    endedAt: 6_000,
    state: 'completed' as const,
  };
  const recoveryTiming = {
    id: 'timing-2',
    sessionId: 'session-1',
    clientTurnId: 'runtime-recovery-1',
    rootRunId: 'gateway-run-2',
    startedAt: 10_000,
    acceptedAt: 10_100,
    state: 'running' as const,
  };
  const beginSessionRun = vi.fn().mockReturnValue({
    ...recoveryTiming,
    rootRunId: 'runtime-recovery-1',
  });
  const bindSessionRunRootRun = vi.fn().mockReturnValue(recoveryTiming);
  const reopenSessionRun = vi.fn();
  const store = {
    getLatestSessionRun: vi.fn().mockReturnValue(completedTiming),
    beginSessionRun,
    bindSessionRunRootRun,
    reopenSessionRun,
  } as unknown as CoworkStore;
  const router = {
    getSessionRuntimeStatus: vi.fn().mockResolvedValue({
      known: true,
      mainRunning: true,
      subagentRunning: false,
      running: true,
      rootRunId: 'gateway-run-2',
    }),
  } as unknown as CoworkEngineRouter;
  registerCoworkSessionHandlers({
    getCoworkStore: () => store,
    getCoworkEngineRouter: () => router,
    setSessionPermissionMode: vi.fn(),
  });
  const handler = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'cowork:session:runtimeStatus',
  )?.[1] as IpcHandler;

  await expect(handler({}, 'session-1')).resolves.toMatchObject({
    success: true,
    running: true,
    timing: recoveryTiming,
  });
  expect(beginSessionRun).toHaveBeenCalledOnce();
  expect(bindSessionRunRootRun).toHaveBeenCalledWith('timing-2', 'gateway-run-2');
  expect(reopenSessionRun).not.toHaveBeenCalled();
});

test('does not fail a receipt while the aggregate runtime is still active', async () => {
  const runningTiming = {
    id: 'timing-1',
    sessionId: 'session-1',
    clientTurnId: 'client-turn-1',
    rootRunId: 'gateway-run-1',
    startedAt: 1_000,
    acceptedAt: 1_100,
    state: 'running' as const,
  };
  const finishSessionRun = vi.fn();
  const store = {
    getLatestSessionRun: vi.fn().mockReturnValue(runningTiming),
    bindSessionRunRootRun: vi.fn().mockReturnValue(runningTiming),
    finishSessionRun,
  } as unknown as CoworkStore;
  const router = {
    getSessionRuntimeStatus: vi.fn().mockResolvedValue({
      known: true,
      mainRunning: false,
      subagentRunning: true,
      running: true,
      rootRunId: 'gateway-run-1',
    }),
  } as unknown as CoworkEngineRouter;
  registerCoworkSessionHandlers({
    getCoworkStore: () => store,
    getCoworkEngineRouter: () => router,
    setSessionPermissionMode: vi.fn(),
  });
  const handler = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'cowork:session:run:fail',
  )?.[1] as IpcHandler;

  await expect(
    handler({}, { sessionId: 'session-1', id: 'timing-1', endedAt: 5_000 }),
  ).resolves.toMatchObject({ success: true, snapshot: { running: true } });
  expect(router.getSessionRuntimeStatus).toHaveBeenCalledWith('session-1', {
    includeSubagents: true,
    forceRefresh: true,
    fullScan: true,
  });
  expect(finishSessionRun).not.toHaveBeenCalled();
});

test('fails a receipt after a full scan confirms aggregate idle', async () => {
  const failedTiming = {
    id: 'timing-1',
    sessionId: 'session-1',
    clientTurnId: 'client-turn-1',
    rootRunId: 'gateway-run-1',
    startedAt: 1_000,
    acceptedAt: 1_100,
    endedAt: 5_000,
    state: 'failed' as const,
  };
  const finishSessionRun = vi.fn().mockReturnValue(failedTiming);
  const store = { finishSessionRun } as unknown as CoworkStore;
  const getSessionRuntimeStatus = vi.fn().mockResolvedValue({
    known: true,
    mainRunning: false,
    subagentRunning: false,
    running: false,
  });
  registerCoworkSessionHandlers({
    getCoworkStore: () => store,
    getCoworkEngineRouter: () => ({ getSessionRuntimeStatus }) as unknown as CoworkEngineRouter,
    setSessionPermissionMode: vi.fn(),
  });
  const handler = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'cowork:session:run:fail',
  )?.[1] as IpcHandler;

  await expect(
    handler({}, { sessionId: 'session-1', id: 'timing-1', endedAt: 5_000 }),
  ).resolves.toMatchObject({
    success: true,
    snapshot: { known: true, running: false, timing: failedTiming },
  });
  expect(getSessionRuntimeStatus).toHaveBeenCalledWith('session-1', {
    includeSubagents: true,
    forceRefresh: true,
    fullScan: true,
  });
  expect(finishSessionRun).toHaveBeenCalledWith('timing-1', 'failed', 5_000);
});

test('keeps a failed receipt open when the full scan is unknown', async () => {
  const runningTiming = {
    id: 'timing-1',
    sessionId: 'session-1',
    clientTurnId: 'client-turn-1',
    rootRunId: 'gateway-run-1',
    startedAt: 1_000,
    acceptedAt: 1_100,
    state: 'running' as const,
  };
  const finishSessionRun = vi.fn();
  const store = {
    getLatestSessionRun: vi.fn().mockReturnValue(runningTiming),
    finishSessionRun,
  } as unknown as CoworkStore;
  const getSessionRuntimeStatus = vi.fn().mockResolvedValue({
    known: false,
    mainRunning: false,
    subagentRunning: false,
    running: false,
  });
  registerCoworkSessionHandlers({
    getCoworkStore: () => store,
    getCoworkEngineRouter: () => ({ getSessionRuntimeStatus }) as unknown as CoworkEngineRouter,
    setSessionPermissionMode: vi.fn(),
  });
  const handler = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'cowork:session:run:fail',
  )?.[1] as IpcHandler;

  await expect(
    handler({}, { sessionId: 'session-1', id: 'timing-1', endedAt: 5_000 }),
  ).resolves.toMatchObject({
    success: true,
    snapshot: { known: false, running: true, timing: runningTiming },
  });
  expect(finishSessionRun).not.toHaveBeenCalled();
});
