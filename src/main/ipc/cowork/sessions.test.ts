import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { CoworkSessionCopyIpc } from '../../../shared/cowork/sessionCopy';
import { CoworkSessionForkIpc } from '../../../shared/cowork/sessionFork';
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

import type { CollaborationCoordinator } from './collaboration';
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

test('reports successful task deletions even when another task needs a retry', async () => {
  const deleteTask = vi.fn(async (id: string) => {
    if (id === 'failed') throw new Error('collaborationDeletePending');
    return true;
  });
  registerCoworkSessionHandlers({
    getCoworkStore: () => ({}) as CoworkStore,
    getCoworkEngineRouter: () => ({}) as CoworkEngineRouter,
    setSessionPermissionMode: vi.fn(),
    getCollaboration: () =>
      ({
        read: (id: string) => ({
          room: { id, members: [{ sessionId: id }, { sessionId: `${id}-peer` }] },
        }),
        deleteTask,
      }) as unknown as CollaborationCoordinator,
  });
  const handler = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'cowork:session:deleteBatch',
  )![1] as IpcHandler;
  await expect(handler({}, ['failed', 'done'])).resolves.toEqual({
    success: false,
    deletedSessionIds: ['done', 'done-peer'],
    error: 'collaborationDeletePending',
  });
  expect(deleteTask).toHaveBeenCalledTimes(2);
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

test('copies an idle session from its canonical transcript', async () => {
  const source = {
    id: 'source-session',
    title: 'Source',
    status: 'idle' as const,
    pinned: false,
    cwd: 'E:\\workspace\\project',
    executionMode: 'local' as const,
    permissionMode: 'auto' as const,
    activeSkillIds: ['skill-1'],
    agentId: 'main',
    modelRef: 'provider/model',
    createdAt: 1,
    updatedAt: 1,
  };
  const copied = { ...source, id: 'copied-session', title: 'Source (copy)' };
  const store = {
    getSession: vi.fn().mockReturnValue(source),
    createSession: vi.fn().mockReturnValue(copied),
    copyTerminalSessionRuns: vi.fn().mockReturnValue(1),
    deleteSession: vi.fn(),
  } as unknown as CoworkStore;
  const router = {
    getSessionRuntimeStatus: vi.fn().mockResolvedValue({ known: true, running: false }),
    prepareSession: vi.fn().mockResolvedValue({
      sessionKey: 'agent:main:justdo:copied-session',
      gatewaySessionId: 'gateway-copy',
    }),
    onSessionDeleted: vi.fn(),
  } as unknown as CoworkEngineRouter;
  let copiedGoal: Record<string, unknown> | null = {
    schemaVersion: 1,
    id: 'goal-copy',
    objective: 'Do the work',
    status: 'paused',
    createdAt: 1,
    updatedAt: 2,
    tokenStart: 0,
    tokensUsed: 0,
    continuationTurns: 0,
  };
  const requestGateway = vi.fn(async (method: string, params?: unknown) => {
    if (method === 'sessions.describe') {
      const key = (params as { key?: string } | undefined)?.key;
      return key === 'agent:main:justdo:copied-session'
        ? { session: { sessionId: 'gateway-copy', goal: copiedGoal } }
        : { session: { pluginExtensions: [] } };
    }
    if (method === 'sessions.goal.clear') {
      const identity = params as {
        operationId: string;
        sessionId: string;
        goalId: string;
      };
      copiedGoal = null;
      return { ...identity, action: 'clear', status: 'cleared' };
    }
    return {
      key: 'agent:main:justdo:copied-session',
      sessionId: 'gateway-copy',
    };
  });
  registerCoworkSessionHandlers({
    getCoworkStore: () => store,
    getCoworkEngineRouter: () => router,
    setSessionPermissionMode: vi.fn(),
    requestGateway,
  });
  const handler = mocks.handle.mock.calls.find(
    ([channel]) => channel === CoworkSessionCopyIpc.Copy,
  )?.[1] as IpcHandler;

  await expect(handler({}, { sessionId: source.id, title: copied.title })).resolves.toEqual({
    success: true,
    session: copied,
    planModeEnabled: false,
  });
  expect(store.createSession).toHaveBeenCalledWith(
    copied.title,
    source.cwd,
    source.executionMode,
    source.activeSkillIds,
    source.agentId,
    source.permissionMode,
    source.modelRef,
  );
  expect(requestGateway).toHaveBeenCalledWith('sessions.create', {
    key: 'agent:main:justdo:copied-session',
    parentSessionKey: 'agent:main:justdo:source-session',
    fork: true,
    cwd: source.cwd,
    permissionMode: 'workspace',
  });
  expect(router.prepareSession).toHaveBeenCalledWith(copied.id);
  expect(requestGateway).toHaveBeenCalledWith(
    'sessions.goal.clear',
    expect.objectContaining({
      sessionKey: 'agent:main:justdo:copied-session',
      sessionId: 'gateway-copy',
      goalId: 'goal-copy',
      agentId: 'main',
    }),
  );
  expect(store.deleteSession).not.toHaveBeenCalled();
  expect(store.copyTerminalSessionRuns).toHaveBeenCalledWith(source.id, copied.id);
});

test('preserves enabled Plan mode when copying the canonical session', async () => {
  const source = {
    id: 'source-session',
    title: 'Plan source',
    status: 'idle' as const,
    pinned: false,
    cwd: 'E:\\workspace\\project',
    executionMode: 'local' as const,
    permissionMode: 'ask' as const,
    activeSkillIds: [],
    agentId: 'main',
    createdAt: 1,
    updatedAt: 1,
  };
  const copied = { ...source, id: 'copied-session', title: 'Plan source (copy)' };
  const store = {
    getSession: vi.fn().mockReturnValue(source),
    createSession: vi.fn().mockReturnValue(copied),
    copyTerminalSessionRuns: vi.fn().mockReturnValue(0),
    deleteSession: vi.fn(),
  } as unknown as CoworkStore;
  const router = {
    getSessionRuntimeStatus: vi.fn().mockResolvedValue({ known: true, running: false }),
    prepareSession: vi.fn().mockResolvedValue({
      sessionKey: 'agent:main:justdo:copied-session',
      gatewaySessionId: 'gateway-copy',
    }),
    onSessionDeleted: vi.fn(),
  } as unknown as CoworkEngineRouter;
  const requestGateway = vi.fn(async (method: string, params?: unknown) => {
    if (method === 'sessions.describe') {
      const key = (params as { key?: string } | undefined)?.key;
      if (key === 'agent:main:justdo:copied-session') {
        return { session: { sessionId: 'gateway-copy', goal: null } };
      }
      return {
        session: {
          pluginExtensions: [
            {
              pluginId: 'plan-mode',
              namespace: 'state',
              value: { enabled: true, updatedAt: 1 },
            },
          ],
        },
      };
    }
    if (method === 'sessions.pluginPatch') return { ok: true };
    return { key: 'agent:main:justdo:copied-session', sessionId: 'gateway-copy' };
  });
  registerCoworkSessionHandlers({
    getCoworkStore: () => store,
    getCoworkEngineRouter: () => router,
    setSessionPermissionMode: vi.fn(),
    requestGateway,
  });
  const handler = mocks.handle.mock.calls.find(
    ([channel]) => channel === CoworkSessionCopyIpc.Copy,
  )?.[1] as IpcHandler;

  await expect(handler({}, { sessionId: source.id, title: copied.title })).resolves.toEqual({
    success: true,
    session: copied,
    planModeEnabled: true,
  });
  expect(requestGateway).toHaveBeenCalledWith('sessions.pluginPatch', {
    key: 'agent:main:justdo:copied-session',
    agentId: 'main',
    pluginId: 'plan-mode',
    namespace: 'state',
    value: { enabled: true, updatedAt: expect.any(Number) },
  });
});

test('rolls back a copied local session when Gateway creation fails', async () => {
  const source = {
    id: 'source-session',
    title: 'Source',
    status: 'idle' as const,
    pinned: false,
    cwd: 'E:\\workspace\\project',
    executionMode: 'local' as const,
    permissionMode: 'ask' as const,
    activeSkillIds: [],
    agentId: 'main',
    createdAt: 1,
    updatedAt: 1,
  };
  const copied = { ...source, id: 'copied-session', title: 'Source (copy)' };
  const store = {
    getSession: vi.fn().mockReturnValue(source),
    createSession: vi.fn().mockReturnValue(copied),
    deleteSession: vi.fn(),
  } as unknown as CoworkStore;
  const router = {
    getSessionRuntimeStatus: vi.fn().mockResolvedValue({ known: true, running: false }),
    prepareSession: vi.fn(),
    onSessionDeleted: vi.fn(),
  } as unknown as CoworkEngineRouter;
  registerCoworkSessionHandlers({
    getCoworkStore: () => store,
    getCoworkEngineRouter: () => router,
    setSessionPermissionMode: vi.fn(),
    requestGateway: vi.fn(async (method: string) => {
      if (method === 'sessions.describe') return { session: { pluginExtensions: [] } };
      throw new Error('fork failed');
    }),
  });
  const handler = mocks.handle.mock.calls.find(
    ([channel]) => channel === CoworkSessionCopyIpc.Copy,
  )?.[1] as IpcHandler;

  await expect(handler({}, { sessionId: source.id, title: copied.title })).resolves.toEqual({
    success: false,
    error: 'fork failed',
  });
  expect(store.deleteSession).toHaveBeenCalledWith(copied.id);
  expect(router.onSessionDeleted).toHaveBeenCalledWith(
    copied.id,
    copied.agentId,
    ['agent:main:justdo:copied-session'],
    [copied.cwd],
  );
});

test('refuses to copy when aggregate runtime activity cannot be verified', async () => {
  const store = {
    getSession: vi.fn().mockReturnValue({
      id: 'source-session',
      cwd: 'E:\\workspace\\project',
      agentId: 'main',
    }),
    createSession: vi.fn(),
  } as unknown as CoworkStore;
  const router = {
    getSessionRuntimeStatus: vi.fn().mockResolvedValue({ known: false, running: false }),
  } as unknown as CoworkEngineRouter;
  const requestGateway = vi.fn();
  registerCoworkSessionHandlers({
    getCoworkStore: () => store,
    getCoworkEngineRouter: () => router,
    setSessionPermissionMode: vi.fn(),
    requestGateway,
  });
  const handler = mocks.handle.mock.calls.find(
    ([channel]) => channel === CoworkSessionCopyIpc.Copy,
  )?.[1] as IpcHandler;

  await expect(
    handler({}, { sessionId: 'source-session', title: 'Source (copy)' }),
  ).resolves.toEqual({
    success: false,
    error: 'The current session activity could not be verified. Try again in a moment.',
  });
  expect(store.createSession).not.toHaveBeenCalled();
  expect(requestGateway).not.toHaveBeenCalled();
});

test('preserves the copy error when rollback cleanup also fails', async () => {
  const source = {
    id: 'source-session',
    title: 'Source',
    status: 'idle' as const,
    pinned: false,
    cwd: 'E:\\workspace\\project',
    executionMode: 'local' as const,
    permissionMode: 'ask' as const,
    activeSkillIds: [],
    agentId: 'main',
    createdAt: 1,
    updatedAt: 1,
  };
  const copied = { ...source, id: 'copied-session', title: 'Source (copy)' };
  const store = {
    getSession: vi.fn().mockReturnValue(source),
    createSession: vi.fn().mockReturnValue(copied),
    deleteSession: vi.fn().mockImplementation(() => {
      throw new Error('local cleanup failed');
    }),
  } as unknown as CoworkStore;
  const router = {
    getSessionRuntimeStatus: vi.fn().mockResolvedValue({ known: true, running: false }),
    prepareSession: vi.fn().mockRejectedValue(new Error('adoption failed')),
    onSessionDeleted: vi.fn().mockImplementation(() => {
      throw new Error('runtime cleanup failed');
    }),
  } as unknown as CoworkEngineRouter;
  registerCoworkSessionHandlers({
    getCoworkStore: () => store,
    getCoworkEngineRouter: () => router,
    setSessionPermissionMode: vi.fn(),
    requestGateway: vi.fn().mockResolvedValue({
      key: 'agent:main:justdo:copied-session',
      sessionId: 'gateway-copy',
    }),
  });
  const handler = mocks.handle.mock.calls.find(
    ([channel]) => channel === CoworkSessionCopyIpc.Copy,
  )?.[1] as IpcHandler;

  await expect(handler({}, { sessionId: source.id, title: copied.title })).resolves.toEqual({
    success: false,
    error: 'adoption failed',
  });
  expect(store.deleteSession).toHaveBeenCalledWith(copied.id);
  expect(router.onSessionDeleted).toHaveBeenCalled();
});

test('forks after a historical assistant response by cutting before the next user entry', async () => {
  const source = {
    id: 'source-session',
    title: 'Source',
    status: 'idle' as const,
    pinned: false,
    cwd: 'E:\\workspace\\project',
    executionMode: 'local' as const,
    permissionMode: 'auto' as const,
    activeSkillIds: ['skill-1'],
    agentId: 'main',
    modelRef: 'provider/model',
    createdAt: 1,
    updatedAt: 1,
  };
  const forked = {
    ...source,
    id: 'forked-session',
    title: 'Fork',
    forkSource: { sessionId: source.id, title: source.title, entryId: 'entry-1' },
  };
  const store = {
    getSession: vi.fn().mockReturnValue(source),
    createSession: vi.fn().mockReturnValue(forked),
    copyTerminalSessionRuns: vi.fn().mockReturnValue(1),
    deleteSession: vi.fn(),
  } as unknown as CoworkStore;
  const router = {
    getSessionRuntimeStatus: vi.fn().mockResolvedValue({ known: true, running: false }),
    prepareSession: vi.fn().mockResolvedValue({
      sessionKey: 'agent:main:justdo:forked-session',
      gatewaySessionId: 'gateway-fork',
    }),
    onSessionDeleted: vi.fn(),
  } as unknown as CoworkEngineRouter;
  let forkedGoal: Record<string, unknown> | null = {
    schemaVersion: 1,
    id: 'goal-fork',
    objective: 'Do the work',
    status: 'blocked',
    createdAt: 1,
    updatedAt: 2,
    tokenStart: 0,
    tokensUsed: 0,
    continuationTurns: 0,
  };
  const requestGateway = vi.fn(async (method: string, params?: unknown) => {
    if (method === 'sessions.describe') {
      return { session: { sessionId: 'gateway-fork', goal: forkedGoal } };
    }
    if (method === 'sessions.goal.clear') {
      const identity = params as {
        operationId: string;
        sessionId: string;
        goalId: string;
      };
      forkedGoal = null;
      return { ...identity, action: 'clear', status: 'cleared' };
    }
    return {
      sessionKey: 'agent:main:justdo:forked-session',
    };
  });
  registerCoworkSessionHandlers({
    getCoworkStore: () => store,
    getCoworkEngineRouter: () => router,
    setSessionPermissionMode: vi.fn(),
    requestGateway,
  });
  const handler = mocks.handle.mock.calls.find(
    ([channel]) => channel === CoworkSessionForkIpc.Fork,
  )?.[1] as IpcHandler;

  await expect(
    handler(
      {},
      {
        sessionId: source.id,
        title: forked.title,
        entryId: 'entry-1',
      },
    ),
  ).resolves.toEqual({
    success: true,
    session: forked,
  });
  expect(store.createSession).toHaveBeenCalledWith(
    forked.title,
    source.cwd,
    source.executionMode,
    source.activeSkillIds,
    source.agentId,
    source.permissionMode,
    source.modelRef,
    { sessionId: source.id, title: source.title, entryId: 'entry-1' },
  );
  expect(requestGateway).toHaveBeenCalledWith('sessions.fork', {
    sessionKey: 'agent:main:justdo:source-session',
    agentId: 'main',
    entryId: 'entry-1',
    targetKey: 'agent:main:justdo:forked-session',
    includeEntry: true,
  });
  expect(router.prepareSession).toHaveBeenCalledWith(forked.id);
  expect(requestGateway).toHaveBeenCalledWith(
    'sessions.goal.clear',
    expect.objectContaining({
      sessionKey: 'agent:main:justdo:forked-session',
      sessionId: 'gateway-fork',
      goalId: 'goal-fork',
      agentId: 'main',
    }),
  );
  expect(store.deleteSession).not.toHaveBeenCalled();
  expect(store.copyTerminalSessionRuns).toHaveBeenCalledWith(source.id, forked.id);
});

test('forks the latest completed assistant response at its exact entry', async () => {
  const source = {
    id: 'source-session',
    title: 'Source',
    cwd: 'E:\\workspace\\project',
    executionMode: 'local' as const,
    permissionMode: 'ask' as const,
    activeSkillIds: [],
    agentId: 'main',
    createdAt: 1,
    updatedAt: 1,
  };
  const forked = {
    ...source,
    id: 'forked-session',
    title: 'Fork',
    forkSource: { sessionId: source.id, title: source.title, entryId: 'assistant-entry' },
  };
  const store = {
    getSession: vi.fn().mockReturnValue(source),
    createSession: vi.fn().mockReturnValue(forked),
    copyTerminalSessionRuns: vi.fn().mockReturnValue(1),
    deleteSession: vi.fn(),
  } as unknown as CoworkStore;
  const router = {
    getSessionRuntimeStatus: vi.fn().mockResolvedValue({ known: true, running: false }),
    prepareSession: vi.fn().mockResolvedValue({
      sessionKey: 'agent:main:justdo:forked-session',
      gatewaySessionId: 'gateway-fork',
    }),
    onSessionDeleted: vi.fn(),
  } as unknown as CoworkEngineRouter;
  const requestGateway = vi.fn(async (method: string) => {
    if (method === 'sessions.describe') {
      return { session: { sessionId: 'gateway-fork', goal: null } };
    }
    return { sessionKey: 'agent:main:justdo:forked-session' };
  });
  registerCoworkSessionHandlers({
    getCoworkStore: () => store,
    getCoworkEngineRouter: () => router,
    setSessionPermissionMode: vi.fn(),
    requestGateway,
  });
  const handler = mocks.handle.mock.calls.find(
    ([channel]) => channel === CoworkSessionForkIpc.Fork,
  )?.[1] as IpcHandler;

  await expect(
    handler(
      {},
      {
        sessionId: source.id,
        title: forked.title,
        entryId: 'assistant-entry',
      },
    ),
  ).resolves.toEqual({ success: true, session: forked });
  expect(requestGateway).toHaveBeenCalledWith('sessions.fork', {
    sessionKey: 'agent:main:justdo:source-session',
    agentId: 'main',
    entryId: 'assistant-entry',
    targetKey: 'agent:main:justdo:forked-session',
    includeEntry: true,
  });
  expect(store.copyTerminalSessionRuns).toHaveBeenCalledWith(source.id, forked.id);
  expect(requestGateway).not.toHaveBeenCalledWith('sessions.create', expect.anything());
  expect(store.deleteSession).not.toHaveBeenCalled();
});

test('rolls back a fork when Gateway returns a different target key', async () => {
  const source = {
    id: 'source-session',
    title: 'Source',
    cwd: 'E:\\workspace\\project',
    executionMode: 'local' as const,
    permissionMode: 'ask' as const,
    activeSkillIds: [],
    agentId: 'main',
    createdAt: 1,
    updatedAt: 1,
  };
  const forked = { ...source, id: 'forked-session', title: 'Fork' };
  const store = {
    getSession: vi.fn().mockReturnValue(source),
    createSession: vi.fn().mockReturnValue(forked),
    deleteSession: vi.fn(),
  } as unknown as CoworkStore;
  const router = {
    getSessionRuntimeStatus: vi.fn().mockResolvedValue({ known: true, running: false }),
    prepareSession: vi.fn(),
    onSessionDeleted: vi.fn(),
  } as unknown as CoworkEngineRouter;
  registerCoworkSessionHandlers({
    getCoworkStore: () => store,
    getCoworkEngineRouter: () => router,
    setSessionPermissionMode: vi.fn(),
    requestGateway: vi.fn().mockResolvedValue({ sessionKey: 'agent:main:dashboard:wrong' }),
  });
  const handler = mocks.handle.mock.calls.find(
    ([channel]) => channel === CoworkSessionForkIpc.Fork,
  )?.[1] as IpcHandler;

  await expect(
    handler(
      {},
      {
        sessionId: source.id,
        title: forked.title,
        entryId: 'entry-1',
      },
    ),
  ).resolves.toEqual({
    success: false,
    error: 'OpenClaw did not create the requested forked session.',
  });
  expect(store.deleteSession).toHaveBeenCalledWith(forked.id);
  expect(router.onSessionDeleted).toHaveBeenCalledWith(
    forked.id,
    forked.agentId,
    ['agent:main:justdo:forked-session'],
    [forked.cwd],
  );
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
    getSession: vi.fn().mockReturnValue({ agentId: 'main' }),
    getAgent: vi.fn().mockReturnValue({ enabled: true }),
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
    getSession: vi.fn().mockReturnValue({ agentId: 'main' }),
    getAgent: vi.fn().mockReturnValue({ enabled: true }),
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
    getSession: vi.fn().mockReturnValue({ agentId: 'main' }),
    getAgent: vi.fn().mockReturnValue({ enabled: true }),
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
    getSession: vi.fn().mockReturnValue({ agentId: 'main' }),
    getAgent: vi.fn().mockReturnValue({ enabled: true }),
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

test.each([
  { result: { status: 'ok' }, state: 'completed' },
  { result: { status: 'error' }, state: 'failed' },
  { result: { status: 'error', stopReason: 'rpc' }, state: 'aborted' },
  { result: { status: 'timeout', endedAt: 9000 }, state: 'failed' },
  { result: { status: 'timeout' }, state: undefined },
])('recovers unacknowledged submissions by client identity: $result', async ({ result, state }) => {
  let timing = {
    id: 'timing-1',
    sessionId: 'session-1',
    clientTurnId: 'client-1',
    startedAt: 1000,
    state: 'running',
  };
  const finishSessionRun = vi.fn(
    (_id, nextState, endedAt) => (timing = { ...timing, state: nextState, endedAt }),
  );
  const requestGateway = vi.fn().mockResolvedValue({ runId: 'client-1', ...result });
  registerCoworkSessionHandlers({
    getCoworkStore: () =>
      ({ getLatestSessionRun: () => timing, finishSessionRun }) as unknown as CoworkStore,
    getCoworkEngineRouter: () =>
      ({
        getSessionRuntimeStatus: vi.fn().mockResolvedValue({
          known: true,
          running: false,
          mainRunning: false,
          subagentRunning: false,
        }),
      }) as unknown as CoworkEngineRouter,
    setSessionPermissionMode: vi.fn(),
    requestGateway,
  });
  const handler = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'cowork:session:runtimeStatus',
  )?.[1] as IpcHandler;
  await expect(handler({}, 'session-1')).resolves.toMatchObject({
    success: true,
    running: !state,
    known: Boolean(state),
    timing: { state: state ?? 'running' },
  });
  expect(requestGateway).toHaveBeenCalledWith('agent.wait', { runId: 'client-1', timeoutMs: 0 });
  if (state) expect(finishSessionRun).toHaveBeenCalledWith('timing-1', state, expect.any(Number));
  else expect(finishSessionRun).not.toHaveBeenCalled();
});

test('only aborts an unaccepted receipt after the stop request succeeds', async () => {
  let timing = {
    id: 'timing-1',
    sessionId: 'session-1',
    clientTurnId: 'client-1',
    startedAt: 1000,
    state: 'running',
  };
  let confirmStop: () => void;
  const stopSession = vi.fn(
    () =>
      new Promise<void>(resolve => {
        confirmStop = resolve;
      }),
  );
  const finishSessionRun = vi.fn((_id, state, endedAt) => (timing = { ...timing, state, endedAt }));
  registerCoworkSessionHandlers({
    getCoworkStore: () =>
      ({ getLatestSessionRun: () => timing, finishSessionRun }) as unknown as CoworkStore,
    getCoworkEngineRouter: () =>
      ({
        stopSession,
        getSessionRuntimeStatus: vi.fn().mockResolvedValue({
          known: true,
          running: false,
          mainRunning: false,
          subagentRunning: false,
        }),
      }) as unknown as CoworkEngineRouter,
    setSessionPermissionMode: vi.fn(),
  });
  const stop = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'cowork:session:stop',
  )?.[1] as IpcHandler;
  const poll = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'cowork:session:runtimeStatus',
  )?.[1] as IpcHandler;
  const stopping = stop({}, 'session-1');
  await expect(poll({}, 'session-1')).resolves.toMatchObject({ running: true });
  expect(finishSessionRun).not.toHaveBeenCalled();
  confirmStop!();
  await stopping;
  await expect(poll({}, 'session-1')).resolves.toMatchObject({
    running: false,
    timing: { state: 'aborted' },
  });
});

test('does not settle a lost admission ACK from an idle snapshot taken before a child started', async () => {
  const timing = {
    id: 'timing-1',
    sessionId: 'session-1',
    clientTurnId: 'client-1',
    startedAt: 1000,
    state: 'running',
  };
  const finishSessionRun = vi.fn();
  const getSessionRuntimeStatus = vi
    .fn()
    .mockResolvedValueOnce({
      known: true,
      running: false,
      mainRunning: false,
      subagentRunning: false,
    })
    .mockResolvedValueOnce({
      known: true,
      running: true,
      mainRunning: false,
      subagentRunning: true,
    });
  registerCoworkSessionHandlers({
    getCoworkStore: () =>
      ({ getLatestSessionRun: () => timing, finishSessionRun }) as unknown as CoworkStore,
    getCoworkEngineRouter: () => ({ getSessionRuntimeStatus }) as unknown as CoworkEngineRouter,
    setSessionPermissionMode: vi.fn(),
    requestGateway: vi.fn().mockResolvedValue({ status: 'ok', runId: 'client-1' }),
  });
  const poll = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'cowork:session:runtimeStatus',
  )?.[1] as IpcHandler;
  await expect(poll({}, 'session-1')).resolves.toMatchObject({ running: true });
  expect(finishSessionRun).not.toHaveBeenCalled();
});

test('retains a cancelled unknown admission through repeated idle abort acknowledgements until a real terminal receipt', async () => {
  let timing = {
    id: 'timing-unknown',
    sessionId: 'session-1',
    clientTurnId: 'unknown-run',
    startedAt: 1000,
    state: 'running',
  };
  const finishSessionRun = vi.fn((_id, state, endedAt) => (timing = { ...timing, state, endedAt }));
  const beginSessionRun = vi.fn();
  const registerUnknownSessionRun = vi.fn();
  const requestGateway = vi.fn().mockResolvedValue({ runId: 'unknown-run', status: 'timeout' });
  const idle = { known: true, running: false, mainRunning: false, subagentRunning: false };
  registerCoworkSessionHandlers({
    getCoworkStore: () =>
      ({
        getLatestSessionRun: () => timing,
        finishSessionRun,
        beginSessionRun,
      }) as unknown as CoworkStore,
    getCoworkEngineRouter: () =>
      ({
        registerUnknownSessionRun,
        stopSession: vi.fn().mockResolvedValue(undefined),
        getSessionRuntimeStatus: vi.fn().mockResolvedValue(idle),
      }) as unknown as CoworkEngineRouter,
    setSessionPermissionMode: vi.fn(),
    requestGateway,
  });
  const handler = name =>
    mocks.handle.mock.calls.find(([channel]) => channel === name)?.[1] as IpcHandler;
  expect(
    await handler('cowork:session:run:unknown')(
      {},
      { sessionId: 'session-1', id: timing.id, cancelled: true },
    ),
  ).toMatchObject({ success: true, snapshot: { known: false, running: true } });
  expect(registerUnknownSessionRun).toHaveBeenCalledWith('session-1', 'unknown-run', {
    cancelled: true,
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(handler('cowork:session:stop')({}, 'session-1')).resolves.toMatchObject({
      success: false,
    });
    await expect(handler('cowork:session:runtimeStatus')({}, 'session-1')).resolves.toMatchObject({
      known: false,
      running: true,
      timing: { state: 'running' },
    });
  }
  expect(finishSessionRun).not.toHaveBeenCalled();
  await expect(
    handler('cowork:session:run:begin')(
      {},
      { sessionId: 'session-1', clientTurnId: 'new-run', startedAt: 3000 },
    ),
  ).resolves.toMatchObject({ success: false });
  expect(beginSessionRun).not.toHaveBeenCalled();
  requestGateway.mockResolvedValue({
    runId: 'unknown-run',
    status: 'error',
    stopReason: 'rpc',
    endedAt: 4000,
  });
  await expect(handler('cowork:session:runtimeStatus')({}, 'session-1')).resolves.toMatchObject({
    known: true,
    running: false,
    timing: { state: 'aborted', endedAt: 4000 },
  });
});

test('reopens an optimistic stopped receipt when its lost admission ACK is reported late', async () => {
  let timing = {
    id: 'timing-late',
    sessionId: 'session-1',
    clientTurnId: 'late-run',
    startedAt: 1000,
    state: 'aborted',
    endedAt: 2000,
  };
  const reopenSessionRun = vi.fn(
    () => (timing = { ...timing, state: 'running', endedAt: undefined }),
  );
  const registerUnknownSessionRun = vi.fn();
  registerCoworkSessionHandlers({
    getCoworkStore: () =>
      ({ getLatestSessionRun: () => timing, reopenSessionRun }) as unknown as CoworkStore,
    getCoworkEngineRouter: () =>
      ({
        registerUnknownSessionRun,
        getSessionRuntimeStatus: vi.fn().mockResolvedValue({
          known: true,
          running: false,
          mainRunning: false,
          subagentRunning: false,
        }),
      }) as unknown as CoworkEngineRouter,
    setSessionPermissionMode: vi.fn(),
    requestGateway: vi.fn().mockResolvedValue({ status: 'timeout' }),
  });
  const mark = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'cowork:session:run:unknown',
  )?.[1] as IpcHandler;
  expect(await mark({}, { sessionId: 'session-1', id: timing.id })).toMatchObject({
    success: true,
    snapshot: { known: false, running: true },
  });
  expect(reopenSessionRun).toHaveBeenCalledWith('timing-late');
  expect(registerUnknownSessionRun).toHaveBeenCalledWith('session-1', 'late-run', {
    cancelled: true,
  });
  const poll = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'cowork:session:runtimeStatus',
  )?.[1] as IpcHandler;
  await expect(poll({}, 'session-1')).resolves.toMatchObject({ known: false, running: true });
});

test.each([false, true])(
  'transfers a yielded admission into ordinary aggregate reconciliation (cancelled=%s)',
  async cancelled => {
    vi.useFakeTimers();
    vi.setSystemTime(5000);
    let timing = {
      id: 'timing-yielded',
      sessionId: 'session-1',
      clientTurnId: 'yielded-run',
      startedAt: 1000,
      state: 'running',
    };
    const bindSessionRunRootRun = vi.fn(
      (_id, rootRunId) => (timing = { ...timing, rootRunId, acceptedAt: Date.now() }),
    );
    const finishSessionRun = vi.fn(
      (_id, state, endedAt) => (timing = { ...timing, state, endedAt }),
    );
    registerCoworkSessionHandlers({
      getCoworkStore: () =>
        ({
          getLatestSessionRun: () => timing,
          getSession: () => ({ status: 'idle' }),
          bindSessionRunRootRun,
          finishSessionRun,
        }) as unknown as CoworkStore,
      getCoworkEngineRouter: () =>
        ({
          registerUnknownSessionRun: vi.fn(),
          getSessionRuntimeStatus: vi.fn().mockResolvedValue({
            known: true,
            running: false,
            mainRunning: false,
            subagentRunning: false,
          }),
        }) as unknown as CoworkEngineRouter,
      setSessionPermissionMode: vi.fn(),
      requestGateway: vi
        .fn()
        .mockResolvedValue({ status: 'ok', yielded: true, runId: 'yielded-run' }),
    });
    const handler = name =>
      mocks.handle.mock.calls.find(([channel]) => channel === name)?.[1] as IpcHandler;
    await handler('cowork:session:run:unknown')(
      {},
      { sessionId: 'session-1', id: timing.id, cancelled },
    );
    await expect(handler('cowork:session:runtimeStatus')({}, 'session-1')).resolves.toMatchObject({
      known: true,
      running: true,
      timing: { acceptedAt: 5000 },
    });
    expect(finishSessionRun).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(750);
    await expect(handler('cowork:session:runtimeStatus')({}, 'session-1')).resolves.toMatchObject({
      known: true,
      running: false,
      timing: { state: cancelled ? 'aborted' : 'completed' },
    });
  },
);

test('binds a Main-started yielded turn whose lost ACK never used the renderer unknown IPC', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(5000);
  let timing = {
    id: 'main-yielded',
    sessionId: 'session-1',
    clientTurnId: 'main-run',
    startedAt: 1000,
    state: 'running',
  };
  const bindSessionRunRootRun = vi.fn(
    (_id, rootRunId) => (timing = { ...timing, rootRunId, acceptedAt: Date.now() }),
  );
  const finishSessionRun = vi.fn((_id, state, endedAt) => (timing = { ...timing, state, endedAt }));
  registerCoworkSessionHandlers({
    getCoworkStore: () =>
      ({
        getLatestSessionRun: () => timing,
        getSession: () => ({ status: 'idle' }),
        bindSessionRunRootRun,
        finishSessionRun,
      }) as unknown as CoworkStore,
    getCoworkEngineRouter: () =>
      ({
        getSessionRuntimeStatus: vi.fn().mockResolvedValue({
          known: true,
          running: false,
          mainRunning: false,
          subagentRunning: false,
        }),
      }) as unknown as CoworkEngineRouter,
    setSessionPermissionMode: vi.fn(),
    requestGateway: vi.fn().mockResolvedValue({ status: 'ok', yielded: true, runId: 'main-run' }),
  });
  const poll = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'cowork:session:runtimeStatus',
  )?.[1] as IpcHandler;
  await expect(poll({}, 'session-1')).resolves.toMatchObject({
    running: true,
    known: true,
    timing: { acceptedAt: 5000 },
  });
  expect(bindSessionRunRootRun).toHaveBeenCalledWith('main-yielded', 'main-run');
  expect(finishSessionRun).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(750);
  await expect(poll({}, 'session-1')).resolves.toMatchObject({
    running: false,
    timing: { state: 'completed' },
  });
});

test('a local specialist conversation is not remotely managed', async () => {
  registerCoworkSessionHandlers({
    getCoworkStore: () =>
      ({ getSession: () => ({ agentId: 'research' }) }) as unknown as CoworkStore,
    getCoworkEngineRouter: () => ({}) as CoworkEngineRouter,
    setSessionPermissionMode: vi.fn(),
  });
  const handler = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'cowork:session:remoteManaged',
  )![1] as IpcHandler;
  await expect(handler({}, 'specialist-chat')).resolves.toEqual({
    success: true,
    remoteManaged: false,
  });
});
