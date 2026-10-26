import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { appendAgentTeamInstruction } from '../../../../plugins/extensions/agent-team/prompt/agentTeamPrompt';
import { CoworkSessionCopyIpc } from '../../../shared/cowork/sessionCopy';
import {
  SESSION_SUMMARY_BATCH_LIMIT,
  SessionDirectoryIpc,
} from '../../../shared/cowork/sessionDirectory';
import { CoworkSessionForkIpc } from '../../../shared/cowork/sessionFork';
import { SessionRunBeginErrorCode } from '../../../shared/cowork/sessionRun';
import { SessionRunIpc } from '../../../shared/cowork/sessionRun';
import { CoworkSessionSearchIpc } from '../../../shared/cowork/sessionSearch';
import type { AgentTeamLaunchCoordinator } from '../../cowork/agent-team/agentTeamLaunchCoordinator';
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

import type { CollaborationCoordinator } from '../../cowork/agent-team/collaborationCoordinator';
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

test.each(['present', 'missing', 'removed-during-defaults', 'database-error'])(
  'returns an explicit product session lookup result for %s', async kind => {
    const session = { id: 'selected', historyBinding: { sessionKey: 'native-key' } };
    const getSession = vi.fn().mockReturnValue(kind === 'missing' ? null : session);
    if (kind === 'removed-during-defaults') getSession.mockReturnValueOnce(session).mockReturnValue(null);
    if (kind === 'database-error') getSession.mockImplementation(() => { throw new Error('Database read failed'); });
    const applyHistorySessionDefaults = vi.fn(() => kind === 'removed-during-defaults');
    registerCoworkSessionHandlers({
      getCoworkStore: () => ({ getSession, applyHistorySessionDefaults }) as unknown as CoworkStore,
      getCoworkEngineRouter: () => ({}) as CoworkEngineRouter,
      setSessionPermissionMode: vi.fn(),
    });
    const read = mocks.handle.mock.calls.find(([name]) => name === 'cowork:session:get')![1] as IpcHandler;
    await expect(read(null, 'selected')).resolves.toEqual(kind === 'present' ? { success: true, session }
      : { success: false, error: kind === 'database-error' ? 'Database read failed' : 'Session not found.' });
  },
);

test('rejects invalid session lookup IDs before reading the product store', async () => {
  const getSession = vi.fn();
  registerCoworkSessionHandlers({
    getCoworkStore: () => ({ getSession }) as unknown as CoworkStore,
    getCoworkEngineRouter: () => ({}) as CoworkEngineRouter,
    setSessionPermissionMode: vi.fn(),
  });
  const read = mocks.handle.mock.calls.find(([name]) => name === 'cowork:session:get')![1] as IpcHandler;
  for (const invalid of [null, undefined, {}, '', ' ', 'x'.repeat(513)]) {
    await expect(read(null, invalid)).resolves.toMatchObject({ success: false, error: expect.any(String) });
  }
  expect(getSession).not.toHaveBeenCalled();
});

test('validates directory and summary inputs before reading product metadata', async () => {
  const store = {
    listSessionDirectory: vi.fn(() => []),
    readSessionSummaries: vi.fn(() => []),
    listSessionSearchSummaries: vi.fn(() => []),
  };
  registerCoworkSessionHandlers({
    getCoworkStore: () => store as unknown as CoworkStore,
    getCoworkEngineRouter: () => ({}) as CoworkEngineRouter,
    setSessionPermissionMode: vi.fn(),
  });
  const directory = mocks.handle.mock.calls.find(
    ([name]) => name === SessionDirectoryIpc.List,
  )![1] as IpcHandler;
  const summaries = mocks.handle.mock.calls.find(
    ([name]) => name === SessionDirectoryIpc.ReadSummaries,
  )![1] as IpcHandler;
  const search = mocks.handle.mock.calls.find(
    ([name]) => name === SessionDirectoryIpc.SearchSummaries,
  )![1] as IpcHandler;
  for (const invalid of [null, '', 1, {}, 'a'.repeat(513)]) {
    await expect(directory(null, invalid)).resolves.toMatchObject({ success: false });
  }
  for (const invalid of [
    undefined,
    null,
    {},
    [''],
    [1],
    ['a'.repeat(513)],
    Array.from({ length: SESSION_SUMMARY_BATCH_LIMIT + 1 }, () => 'one'),
  ]) {
    await expect(summaries(null, invalid)).resolves.toMatchObject({ success: false });
  }
  expect(store.listSessionDirectory).not.toHaveBeenCalled();
  expect(store.readSessionSummaries).not.toHaveBeenCalled();
  await expect(directory(null, 'main')).resolves.toEqual({ success: true, entries: [] });
  await expect(summaries(null, ['one', 'one', 'two'])).resolves.toEqual({
    success: true,
    sessions: [],
  });
  expect(store.readSessionSummaries).toHaveBeenCalledExactlyOnceWith(['one', 'two']);
  await expect(search(null)).resolves.toEqual({ success: true, sessions: [] });
});

test('returns directory before Gateway discovery, coalesces concurrent discovery and notifies after adoption', async () => {
  const parent = { id: 'parent', agentId: 'main', nativeSessionKey: 'agent:main:justdo:parent' };
  let resolveNative!: (value: unknown) => void;
  const pendingNative = new Promise(resolve => {
    resolveNative = resolve;
  });
  const requestGateway = vi.fn(async (method: string) =>
    method === 'sessions.list'
      ? pendingNative
      : { session: { worktree: { id: 'tree' }, spawnedCwd: 'E:\\repo\\child' } },
  );
  const onSessionsChanged = vi.fn();
  let adopted = false;
  const store = {
    listSessionDirectory: vi.fn(() => [parent]),
    getSession: vi.fn(() => parent),
    getSessionByNativeKey: vi.fn(() => (adopted ? { id: 'child' } : null)),
    adoptNativeSession: vi.fn(() => {
      adopted = true;
      return { id: 'child' };
    }),
  };
  registerCoworkSessionHandlers({
    getCoworkStore: () => store as unknown as CoworkStore,
    getCoworkEngineRouter: () => ({}) as CoworkEngineRouter,
    setSessionPermissionMode: vi.fn(),
    requestGateway: requestGateway as <T>(method: string, params?: unknown) => Promise<T>,
    onSessionsChanged,
  });
  const handler = mocks.handle.mock.calls.find(
    ([name]) => name === SessionDirectoryIpc.List,
  )![1] as IpcHandler;

  await expect(handler(null)).resolves.toEqual({ success: true, entries: [parent] });
  await handler(null);
  expect(requestGateway).toHaveBeenCalledTimes(1);
  expect(onSessionsChanged).not.toHaveBeenCalled();
  resolveNative({
    sessions: [
      {
        key: 'agent:main:subagent:child',
        parentSessionKey: parent.nativeSessionKey,
        worktree: { id: 'tree' },
      },
    ],
  });
  await vi.waitFor(() => expect(onSessionsChanged).toHaveBeenCalledOnce());
  expect(store.getSession).toHaveBeenCalledExactlyOnceWith('parent');
  expect(store.adoptNativeSession).toHaveBeenCalledOnce();
});

test('validates search scopes before Gateway access and preserves message identity in IPC results', async () => {
  const store = {
    listSessions: () => [
      { id: 'one', agentId: 'main' },
      { id: 'two', agentId: 'main' },
    ],
  };
  const requestGateway = vi.fn().mockResolvedValue({
    results: [
      {
        sessionKey: 'agent:main:justdo:two',
        sessionId: 'native-two',
        messageId: 'entry-two',
        role: 'user',
        snippet: 'needle',
        timestamp: 1,
        score: 1,
      },
    ],
    archivedTranscriptsExcluded: 2,
  });
  registerCoworkSessionHandlers({
    getCoworkStore: () => store as unknown as CoworkStore,
    getCoworkEngineRouter: () => ({}) as CoworkEngineRouter,
    setSessionPermissionMode: vi.fn(),
    requestGateway,
  });
  const handler = mocks.handle.mock.calls.find(
    ([name]) => name === CoworkSessionSearchIpc.SearchMessages,
  )![1] as IpcHandler;
  for (const options of [null, { sessionIds: 'one' }, { sessionKeys: ['agent:main:other'] }]) {
    await expect(handler(null, 'needle', options)).resolves.toMatchObject({ success: false });
  }
  expect(requestGateway).not.toHaveBeenCalled();
  await expect(
    handler(null, 'needle', { sessionIds: ['one', 'two'], excludeSessionIds: ['one'] }),
  ).resolves.toMatchObject({
    success: true,
    matches: [
      {
        sessionId: 'two',
        nativeSessionKey: 'agent:main:justdo:two',
        nativeSessionId: 'native-two',
        messageId: 'entry-two',
      },
    ],
    archivedTranscriptsExcluded: 2,
  });
  expect(requestGateway).toHaveBeenCalledWith(
    'sessions.search',
    expect.objectContaining({ sessionKeys: ['agent:main:justdo:two'] }),
  );
});

test.each([
  { nativeMode: undefined, localMode: 'ask' },
  { nativeMode: 'guarded', localMode: 'ask' },
  { nativeMode: 'workspace', localMode: 'auto' },
  { nativeMode: 'full', localMode: 'full' },
])(
  'adopts a Gateway worktree child once with $nativeMode permission and its native key',
  async ({ nativeMode, localMode }) => {
    const parent = {
      id: 'parent',
      agentId: 'main',
      executionMode: 'local',
      permissionMode: 'full',
    };
    const sessions = new Map<string, Record<string, unknown>>([['parent', parent]]);
    const store = {
      listSessions: () => [...sessions.values()],
      getSession: (id: string) => sessions.get(id) ?? null,
      getSessionByNativeKey: (key: string) =>
        [...sessions.values()].find(session => session.nativeSessionKey === key) ?? null,
      adoptNativeSession: vi.fn(
        (key: string, parent: { id: string }, _title: string, cwd: string) => {
          const child = {
            id: 'child',
            cwd,
            nativeSessionKey: key,
            nativeParentSessionId: parent.id,
          };
          sessions.set('child', child);
          return child;
        },
      ),
    };
    const childKey = 'agent:main:subagent:child';
    const requestGateway = vi.fn(async (method: string) =>
      method === 'sessions.list'
        ? {
            sessions: [
              {
                key: childKey,
                parentSessionKey: 'agent:main:justdo:parent',
                worktree: { id: 'tree' },
              },
            ],
          }
        : {
            session: {
              spawnedCwd: 'E:\\repo\\child',
              label: 'Isolated task',
              worktree: { id: 'tree' },
              permissionMode: nativeMode,
            },
          },
    );
    registerCoworkSessionHandlers({
      getCoworkStore: () => store as unknown as CoworkStore,
      getCoworkEngineRouter: () => ({}) as CoworkEngineRouter,
      setSessionPermissionMode: vi.fn(),
      requestGateway: requestGateway as <T>(method: string, params?: unknown) => Promise<T>,
    });
    const handler = mocks.handle.mock.calls.find(
      ([name]) => name === 'cowork:session:list',
    )![1] as IpcHandler;
    await handler(null);
    await handler(null);
    expect(requestGateway.mock.calls).toContainEqual(['sessions.describe', { key: childKey }]);
    expect(store.adoptNativeSession).toHaveBeenCalledOnce();
    expect(store.adoptNativeSession).toHaveBeenCalledWith(
      childKey,
      parent,
      'Isolated task',
      'E:\\repo\\child',
      localMode,
    );
  },
);

test('does not broaden an unsupported native read-only worktree permission during adoption', async () => {
  const parent = { id: 'parent', agentId: 'main', permissionMode: 'full' };
  const adoptNativeSession = vi.fn();
  const store = {
    listSessions: () => [parent],
    getSession: () => parent,
    getSessionByNativeKey: () => null,
    adoptNativeSession,
  };
  const requestGateway = vi.fn(async (method: string) =>
    method === 'sessions.list'
      ? {
          sessions: [
            {
              key: 'agent:main:subagent:child',
              parentSessionKey: 'agent:main:justdo:parent',
              worktree: { id: 'tree' },
            },
          ],
        }
      : {
          session: {
            worktree: { id: 'tree' },
            spawnedCwd: 'E:\\repo\\child',
            permissionMode: 'read-only',
          },
        },
  );
  registerCoworkSessionHandlers({
    getCoworkStore: () => store as unknown as CoworkStore,
    getCoworkEngineRouter: () => ({}) as CoworkEngineRouter,
    setSessionPermissionMode: vi.fn(),
    requestGateway: requestGateway as <T>(method: string, params?: unknown) => Promise<T>,
  });
  const handler = mocks.handle.mock.calls.find(
    ([name]) => name === 'cowork:session:list',
  )![1] as IpcHandler;
  await handler(null);
  expect(adoptNativeSession).not.toHaveBeenCalled();
});

test('does not import pending-input harness rows even when native metadata claims a worktree', async () => {
  const parent = { id: 'parent', agentId: 'main', permissionMode: 'full' };
  const store = {
    listSessions: () => [parent],
    getSession: () => parent,
    getSessionByNativeKey: () => null,
    adoptNativeSession: vi.fn(),
  };
  const requestGateway = vi.fn().mockResolvedValue({
    sessions: [
      {
        key: 'agent:main:harness:justdo-team-holding:room:1',
        parentSessionKey: 'agent:main:justdo:parent',
        worktree: { id: 'tree' },
      },
    ],
  });
  registerCoworkSessionHandlers({
    getCoworkStore: () => store as unknown as CoworkStore,
    getCoworkEngineRouter: () => ({}) as CoworkEngineRouter,
    setSessionPermissionMode: vi.fn(),
    requestGateway,
  });
  const handler = mocks.handle.mock.calls.find(
    ([name]) => name === 'cowork:session:list',
  )![1] as IpcHandler;
  await handler(null);
  expect(store.adoptNativeSession).not.toHaveBeenCalled();
  expect(requestGateway).toHaveBeenCalledOnce();
});

test.each([CoworkSessionCopyIpc.Copy, CoworkSessionForkIpc.Fork])(
  'rejects %s for a worktree source instead of sharing its checkout without ownership',
  async channel => {
    const createSession = vi.fn();
    const requestGateway = vi.fn();
    const store = {
      getSession: () => ({
        id: 'child',
        nativeSessionKey: 'agent:main:subagent:child',
        cwd: 'E:\\worktree',
      }),
      createSession,
    };
    registerCoworkSessionHandlers({
      getCoworkStore: () => store as unknown as CoworkStore,
      getCoworkEngineRouter: () => ({}) as CoworkEngineRouter,
      setSessionPermissionMode: vi.fn(),
      requestGateway,
    });
    const handler = mocks.handle.mock.calls.find(([name]) => name === channel)![1] as IpcHandler;
    await expect(
      handler(null, { sessionId: 'child', title: 'Copy', entryId: 'entry-1' }),
    ).resolves.toMatchObject({ success: false });
    expect(createSession).not.toHaveBeenCalled();
    expect(requestGateway).not.toHaveBeenCalled();
  },
);

test.each([CoworkSessionCopyIpc.Copy, CoworkSessionForkIpc.Fork])(
  'verifies an imported source identity before %s rather than treating its binding as a worktree',
  async channel => {
    const source = {
      id: 'history',
      nativeSessionKey: 'agent:main:justdo:old',
      historyBinding: { sessionKey: 'agent:main:justdo:old', nativeSessionId: 'original' },
    };
    const store = { getSession: () => source, createSession: vi.fn() };
    const router = {
      getSessionRuntimeStatus: vi.fn().mockResolvedValue({ known: true, running: false }),
      prepareSession: vi.fn().mockResolvedValue({
        sessionKey: source.nativeSessionKey,
        gatewaySessionId: 'replacement',
      }),
    };
    const requestGateway = vi.fn();
    registerCoworkSessionHandlers({
      getCoworkStore: () => store as unknown as CoworkStore,
      getCoworkEngineRouter: () => router as unknown as CoworkEngineRouter,
      setSessionPermissionMode: vi.fn(),
      requestGateway,
    });
    const handler = mocks.handle.mock.calls.find(([name]) => name === channel)![1] as IpcHandler;
    expect(
      await handler(null, { sessionId: 'history', title: 'Copy', entryId: 'entry-1' }),
    ).toMatchObject({
      success: false,
      error: expect.stringContaining('historical source identity changed'),
    });
    expect(router.prepareSession).toHaveBeenCalledWith('history');
    expect(store.createSession).not.toHaveBeenCalled();
    expect(requestGateway).not.toHaveBeenCalled();
  },
);

test('deleting imported history fences the native identity without deleting a shared project', async () => {
  const key = 'agent:main:justdo:old';
  const store = {
    hasNativeChildSessions: () => false,
    getSession: (id: string) => ({
      id,
      cwd: 'E:\\repo',
      nativeSessionKey: key,
      historyBinding: { sessionKey: key, nativeSessionId: 'original' },
    }),
    listSessions: () => [{ id: 'history' }, { id: 'other' }],
    listPlanHandoffs: () => [],
    deleteSession: vi.fn(),
  };
  const requestGateway = vi.fn().mockResolvedValue({});
  registerCoworkSessionHandlers({
    getCoworkStore: () => store as unknown as CoworkStore,
    getCoworkEngineRouter: () =>
      ({ stopSession: vi.fn(), onSessionDeleted: vi.fn() }) as unknown as CoworkEngineRouter,
    setSessionPermissionMode: vi.fn(),
    requestGateway,
  });
  const handler = mocks.handle.mock.calls.find(
    ([name]) => name === 'cowork:session:delete',
  )![1] as IpcHandler;
  expect(await handler(null, 'history')).toEqual({ success: true });
  expect(requestGateway).toHaveBeenCalledWith('sessions.delete', {
    key,
    expectedSessionId: 'original',
    deleteTranscript: true,
  });
  expect(store.deleteSession).toHaveBeenCalledWith('history');
});

test('keeps a native session visible when Gateway preserves its worktree on deletion', async () => {
  const nativeSessionKey = 'agent:main:subagent:child';
  const store = {
    hasNativeChildSessions: () => false,
    getSession: () => ({ id: 'child', agentId: 'main', cwd: 'E:\\repo\\child', nativeSessionKey }),
    listSessions: () => [{ id: 'child' }],
    listPlanHandoffs: () => [],
    deleteSession: vi.fn(),
  };
  const requestGateway = vi.fn().mockResolvedValue({ worktreePreserved: { id: 'tree-1' } });
  registerCoworkSessionHandlers({
    getCoworkStore: () => store as unknown as CoworkStore,
    getCoworkEngineRouter: () => ({ stopSession: vi.fn() }) as unknown as CoworkEngineRouter,
    setSessionPermissionMode: vi.fn(),
    requestGateway,
  });
  const handler = mocks.handle.mock.calls.find(
    ([name]) => name === 'cowork:session:delete',
  )![1] as IpcHandler;
  await expect(handler(null, 'child')).resolves.toMatchObject({ success: false });
  expect(requestGateway).toHaveBeenCalledWith('sessions.delete', {
    key: nativeSessionKey,
    deleteTranscript: true,
  });
  expect(store.deleteSession).not.toHaveBeenCalled();
});

test('batch deletion removes only confirmed imported histories and retains a replaced native binding', async () => {
  const session = (id: string) => ({
    id,
    agentId: 'main',
    cwd: 'E:\\shared-project',
    ...(id !== 'ordinary'
      ? {
          nativeSessionKey: `agent:main:justdo:${id}`,
          historyBinding: {
            sessionKey: `agent:main:justdo:${id}`,
            nativeSessionId: `native-${id}`,
          },
        }
      : {}),
  });
  const store = {
    getSession: session,
    hasNativeChildSessions: () => false,
    listPlanHandoffs: () => [],
    deleteSessions: vi.fn(),
  };
  const router = { stopSession: vi.fn(), onSessionDeleted: vi.fn() };
  const requestGateway = vi.fn(async (method: string, input: unknown) => {
    const params = input as { key: string };
    if (method === 'sessions.delete') {
      if (params.key.endsWith(':changed')) throw new Error('historical identity changed');
      return {};
    }
    return { session: { sessionId: 'replacement' } };
  });
  registerCoworkSessionHandlers({
    getCoworkStore: () => store as unknown as CoworkStore,
    getCoworkEngineRouter: () => router as unknown as CoworkEngineRouter,
    requestGateway: requestGateway as never,
    setSessionPermissionMode: vi.fn(),
  });
  const handler = mocks.handle.mock.calls.find(
    ([name]) => name === 'cowork:session:deleteBatch',
  )![1] as IpcHandler;
  expect(await handler(null, ['history', 'ordinary', 'changed'])).toEqual({
    success: false,
    deletedSessionIds: ['history', 'ordinary'],
    error: 'historical identity changed',
  });
  expect(requestGateway).toHaveBeenCalledWith('sessions.delete', {
    key: 'agent:main:justdo:history',
    expectedSessionId: 'native-history',
    deleteTranscript: true,
  });
  expect(store.deleteSessions).toHaveBeenCalledExactlyOnceWith(['history', 'ordinary']);
  expect(router.onSessionDeleted).toHaveBeenCalledWith(
    'history',
    'main',
    ['agent:main:justdo:history'],
    ['E:\\shared-project'],
  );
  expect(router.onSessionDeleted).not.toHaveBeenCalledWith(
    'changed',
    expect.anything(),
    expect.anything(),
    expect.anything(),
  );
});

test('batch deletion still blocks an actual worktree before any stop or native deletion', async () => {
  const router = { stopSession: vi.fn() };
  const requestGateway = vi.fn();
  const store = {
    getSession: () => ({ nativeSessionKey: 'agent:main:subagent:child' }),
    deleteSessions: vi.fn(),
  };
  registerCoworkSessionHandlers({
    getCoworkStore: () => store as unknown as CoworkStore,
    getCoworkEngineRouter: () => router as unknown as CoworkEngineRouter,
    requestGateway,
    setSessionPermissionMode: vi.fn(),
  });
  const handler = mocks.handle.mock.calls.find(
    ([name]) => name === 'cowork:session:deleteBatch',
  )![1] as IpcHandler;
  expect(await handler(null, ['child'])).toMatchObject({ success: false, deletedSessionIds: [] });
  expect(router.stopSession).not.toHaveBeenCalled();
  expect(requestGateway).not.toHaveBeenCalled();
  expect(store.deleteSessions).not.toHaveBeenCalled();
});

test.each(['cowork:session:delete', 'cowork:session:deleteBatch'])(
  '%s requires an explicit absence receipt after a lost native deletion ACK',
  async channel => {
    for (const receipt of [{}, { session: { sessionId: 'replacement' } }, { session: null }]) {
      mocks.handle.mockReset();
      const key = 'agent:main:justdo:history';
      const store = {
        getSession: () => ({
          id: 'history',
          agentId: 'main',
          cwd: '/project',
          nativeSessionKey: key,
          historyBinding: { sessionKey: key, nativeSessionId: 'original' },
        }),
        hasNativeChildSessions: () => false,
        listPlanHandoffs: () => [],
        deleteSession: vi.fn(),
        deleteSessions: vi.fn(),
      };
      const router = { stopSession: vi.fn(), onSessionDeleted: vi.fn() };
      const requestGateway = vi.fn(async (method: string) => {
        if (method === 'sessions.delete') throw new Error('lost native acknowledgement');
        return receipt;
      });
      registerCoworkSessionHandlers({
        getCoworkStore: () => store as unknown as CoworkStore,
        getCoworkEngineRouter: () => router as unknown as CoworkEngineRouter,
        requestGateway: requestGateway as never,
        setSessionPermissionMode: vi.fn(),
      });
      const handler = mocks.handle.mock.calls.find(([name]) => name === channel)![1] as IpcHandler;
      const result = await handler(null, channel.endsWith('deleteBatch') ? ['history'] : 'history');
      const absent = 'session' in receipt && receipt.session === null;
      expect(result).toMatchObject({ success: absent });
      const remove = channel.endsWith('deleteBatch') ? store.deleteSessions : store.deleteSession;
      expect(remove).toHaveBeenCalledTimes(absent ? 1 : 0);
    }
  },
);

test.each(['', '\\packages\\api'])(
  'does not delete an owned worktree while another conversation uses its workspace (%s)',
  async suffix => {
    const store = {
      hasNativeChildSessions: () => false,
      getSession: (id: string) => ({
        id,
        cwd: `E:\\repo\\child${id === 'other' ? suffix : ''}`,
        ...(id === 'child' ? { nativeSessionKey: 'agent:main:subagent:child' } : {}),
      }),
      listSessions: () => [{ id: 'child' }, { id: 'other' }],
      deleteSession: vi.fn(),
    };
    const requestGateway = vi.fn();
    registerCoworkSessionHandlers({
      getCoworkStore: () => store as unknown as CoworkStore,
      getCoworkEngineRouter: () => ({ stopSession: vi.fn() }) as unknown as CoworkEngineRouter,
      setSessionPermissionMode: vi.fn(),
      requestGateway,
    });
    const handler = mocks.handle.mock.calls.find(
      ([name]) => name === 'cowork:session:delete',
    )![1] as IpcHandler;
    await expect(handler(null, 'child')).resolves.toMatchObject({ success: false });
    expect(requestGateway).not.toHaveBeenCalled();
    expect(store.deleteSession).not.toHaveBeenCalled();
  },
);

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
        acquireSourceDeletion: () => () => {},
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

test('keeps a group-only source in a batch delete while its execution is unresolved', async () => {
  const deleteTask = vi.fn(async (id: string) => {
    if (id === 'group-source') throw new Error('teamDiscussionBusy');
    return false;
  });
  const store = {
    getSession: (id: string) => ({ id, agentId: 'main', cwd: '/project' }),
    listPlanHandoffs: () => [],
    deleteSessions: vi.fn(),
  };
  const router = { stopSession: vi.fn(), onSessionDeleted: vi.fn() };
  registerCoworkSessionHandlers({
    getCoworkStore: () => store as unknown as CoworkStore,
    getCoworkEngineRouter: () => router as unknown as CoworkEngineRouter,
    setSessionPermissionMode: vi.fn(),
    getCollaboration: () =>
      ({
        read: () => ({}),
        deleteTask,
        acquireSourceDeletion: () => () => {},
      }) as unknown as CollaborationCoordinator,
  });
  const handler = mocks.handle.mock.calls.find(
    ([name]) => name === 'cowork:session:deleteBatch',
  )![1] as IpcHandler;
  await expect(handler(null, ['group-source', 'settled'])).resolves.toEqual({
    success: false,
    deletedSessionIds: ['settled'],
    error: 'teamDiscussionBusy',
  });
  expect(deleteTask).toHaveBeenCalledWith('group-source');
  expect(router.stopSession).toHaveBeenCalledExactlyOnceWith('settled', { bestEffort: true });
  expect(store.deleteSessions).toHaveBeenCalledExactlyOnceWith(['settled']);
  expect(router.onSessionDeleted).not.toHaveBeenCalledWith(
    'group-source',
    expect.anything(),
    expect.anything(),
    expect.anything(),
  );
});

test.each(['cowork:session:delete', 'cowork:session:deleteBatch'])(
  'holds the source deletion lease through standalone stop and store deletion in %s',
  async channel => {
    let frozen = false;
    let finishStop!: () => void;
    const waiting = new Promise<void>(resolve => {
      finishStop = resolve;
    });
    const release = vi.fn(() => {
      frozen = false;
    });
    const acquireSourceDeletion = vi.fn(() => {
      frozen = true;
      return release;
    });
    const deleteTask = vi.fn(async () => false);
    const beginSessionRun = vi.fn();
    const deleteSession = vi.fn(() => {
      expect(frozen).toBe(true);
    });
    const deleteSessions = vi.fn(() => {
      expect(frozen).toBe(true);
    });
    const store = {
      getSession: (id: string) => ({ id, agentId: 'main', cwd: '/project' }),
      hasNativeChildSessions: () => false,
      listPlanHandoffs: () => [],
      beginSessionRun,
      deleteSession,
      deleteSessions,
    };
    const router = {
      stopSession: vi.fn(() => {
        expect(frozen).toBe(true);
        return waiting;
      }),
      onSessionDeleted: vi.fn(),
    };
    registerCoworkSessionHandlers({
      getCoworkStore: () => store as unknown as CoworkStore,
      getCoworkEngineRouter: () => router as unknown as CoworkEngineRouter,
      setSessionPermissionMode: vi.fn(),
      getCollaboration: () =>
        ({
          read: () => ({}),
          isSourceDeleting: () => frozen,
          acquireSourceDeletion,
          deleteTask,
        }) as unknown as CollaborationCoordinator,
    });
    const handler = (name: string) =>
      mocks.handle.mock.calls.find(([registered]) => registered === name)![1] as IpcHandler;
    const deleting = handler(channel)(
      null,
      channel.endsWith('deleteBatch') ? ['source'] : 'source',
    );
    await vi.waitFor(() => expect(router.stopSession).toHaveBeenCalledOnce());
    expect(acquireSourceDeletion).toHaveBeenCalledExactlyOnceWith(['source']);
    expect(release).not.toHaveBeenCalled();
    await expect(
      handler('cowork:session:run:begin')(null, {
        sessionId: 'source',
        clientTurnId: 'new-turn',
        startedAt: 1,
      }),
    ).resolves.toMatchObject({ success: false, error: 'collaborationDeletePending' });
    expect(beginSessionRun).not.toHaveBeenCalled();

    finishStop();
    await expect(deleting).resolves.toMatchObject({ success: true });
    expect(deleteTask).toHaveBeenCalledWith('source');
    expect(channel.endsWith('deleteBatch') ? deleteSessions : deleteSession).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(frozen).toBe(false);
  },
);

test('releases the batch deletion lease when preflight rejects a native child', async () => {
  const release = vi.fn();
  const deleteTask = vi.fn();
  const stopSession = vi.fn();
  registerCoworkSessionHandlers({
    getCoworkStore: () =>
      ({ getSession: () => ({}), hasNativeChildSessions: () => true }) as unknown as CoworkStore,
    getCoworkEngineRouter: () => ({ stopSession }) as unknown as CoworkEngineRouter,
    setSessionPermissionMode: vi.fn(),
    getCollaboration: () =>
      ({ acquireSourceDeletion: () => release, deleteTask }) as unknown as CollaborationCoordinator,
  });
  const handler = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'cowork:session:deleteBatch',
  )![1] as IpcHandler;

  await expect(handler(null, ['source'])).resolves.toMatchObject({
    success: false,
    deletedSessionIds: [],
  });

  expect(release).toHaveBeenCalledOnce();
  expect(deleteTask).not.toHaveBeenCalled();
  expect(stopSession).not.toHaveBeenCalled();
});

test.each(['cowork:session:delete', 'cowork:session:deleteBatch'])(
  'returns a structured failure when acquiring the deletion lease fails in %s',
  async channel => {
    const stopSession = vi.fn();
    registerCoworkSessionHandlers({
      getCoworkStore: () => ({}) as CoworkStore,
      getCoworkEngineRouter: () => ({ stopSession }) as unknown as CoworkEngineRouter,
      setSessionPermissionMode: vi.fn(),
      getCollaboration: () =>
        ({
          acquireSourceDeletion: () => {
            throw new Error('metadata unavailable');
          },
        }) as unknown as CollaborationCoordinator,
    });
    const handler = mocks.handle.mock.calls.find(
      ([registered]) => registered === channel,
    )![1] as IpcHandler;

    await expect(
      handler(null, channel.endsWith('deleteBatch') ? ['source'] : 'source'),
    ).resolves.toMatchObject({
      success: false,
      error: 'metadata unavailable',
    });
    expect(stopSession).not.toHaveBeenCalled();
  },
);

test('rejects a resumed run when source deletion starts while restart status is pending', async () => {
  let deleting = false;
  let reply!: (value: { known: boolean; running: boolean }) => void;
  const waiting = new Promise<{ known: boolean; running: boolean }>(resolve => {
    reply = resolve;
  });
  const beginSessionRun = vi.fn();
  const getSessionRuntimeStatus = vi.fn(() => waiting);
  registerCoworkSessionHandlers({
    getCoworkStore: () =>
      ({
        getSession: () => ({ id: 'source', agentId: 'main' }),
        getAgent: () => ({ enabled: true }),
        getLatestSessionRun: () => ({
          id: 'checkpoint',
          sessionId: 'source',
          clientTurnId: 'old-turn',
          rootRunId: 'old-turn',
          startedAt: 10,
          acceptedAt: 10,
          endedAt: 10,
          state: 'aborted',
        }),
        beginSessionRun,
      }) as unknown as CoworkStore,
    getCoworkEngineRouter: () => ({ getSessionRuntimeStatus }) as unknown as CoworkEngineRouter,
    setSessionPermissionMode: vi.fn(),
    getCollaboration: () =>
      ({
        read: () => ({}),
        isSourceDeleting: () => deleting,
      }) as unknown as CollaborationCoordinator,
  });
  const handler = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'cowork:session:run:begin',
  )![1] as IpcHandler;
  const pending = handler(null, { sessionId: 'source', clientTurnId: 'new-turn', startedAt: 11 });
  expect(getSessionRuntimeStatus).toHaveBeenCalledOnce();
  deleting = true;
  reply({ known: false, running: false });

  await expect(pending).resolves.toEqual({ success: false, error: 'collaborationDeletePending' });
  expect(beginSessionRun).not.toHaveBeenCalled();
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

test('registers the exact explicit input before the source run and fences native send marking', async () => {
  const events: string[] = [];
  const launch = {
    releaseIfSettled: vi.fn().mockResolvedValue(true),
    register: vi.fn(async () => {
      events.push('registered');
    }),
    markSubmissionStarted: vi.fn(),
    cancel: vi.fn(),
  };
  const beginSessionRun = vi.fn(input => {
    events.push('reserved');
    return { ...input, id: 'receipt', state: 'running' };
  });
  registerCoworkSessionHandlers({
    getAgentTeamLaunch: () => launch as unknown as AgentTeamLaunchCoordinator,
    getCoworkStore: () =>
      ({
        getSession: () => ({ agentId: 'main' }),
        getAgent: () => ({ enabled: true }),
        getLatestSessionRun: () => ({ clientTurnId: 'client' }),
        beginSessionRun,
      }) as unknown as CoworkStore,
    getCoworkEngineRouter: () => ({}) as CoworkEngineRouter,
    setSessionPermissionMode: vi.fn(),
  });
  const handler = (channel: string) =>
    mocks.handle.mock.calls.find(([name]) => name === channel)![1] as IpcHandler;
  const prompt = appendAgentTeamInstruction('Discuss', 'group');
  await expect(
    handler('cowork:session:run:begin')(null, {
      sessionId: 'source',
      clientTurnId: 'client',
      startedAt: 1,
      agentTeamPrompt: prompt,
    }),
  ).resolves.toMatchObject({ success: true });
  expect(events).toEqual(['registered', 'reserved']);
  expect(launch.register).toHaveBeenCalledWith(
    expect.objectContaining({ prompt, clientTurnId: 'client', sessionId: 'source' }),
  );
  await expect(
    handler(SessionRunIpc.TeamSubmissionStarted)(null, {
      sessionId: 'source',
      clientTurnId: 'wrong',
    }),
  ).resolves.toMatchObject({ success: false });
  expect(launch.markSubmissionStarted).not.toHaveBeenCalled();
  await expect(
    handler(SessionRunIpc.TeamSubmissionStarted)(null, {
      sessionId: 'source',
      clientTurnId: 'client',
    }),
  ).resolves.toMatchObject({ success: true });
  expect(launch.markSubmissionStarted).toHaveBeenCalledWith('source', 'client');
});

function registerTeamFollowupFixture() {
  const launch = {
    releaseIfSettled: vi.fn().mockResolvedValue(false),
    register: vi.fn(),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
  const beginSessionRun = vi.fn(input => ({ ...input, id: 'followup', state: 'running' }));
  registerCoworkSessionHandlers({
    getAgentTeamLaunch: () => launch as unknown as AgentTeamLaunchCoordinator,
    getCoworkStore: () =>
      ({
        getSession: () => ({ agentId: 'main' }),
        getAgent: () => ({ enabled: true }),
        getLatestSessionRun: () => ({ state: 'completed', clientTurnId: 'previous-team' }),
        beginSessionRun,
      }) as unknown as CoworkStore,
    getCoworkEngineRouter: () => ({}) as CoworkEngineRouter,
    setSessionPermissionMode: vi.fn(),
  });
  const handler = mocks.handle.mock.calls.find(
    ([name]) => name === 'cowork:session:run:begin',
  )![1] as IpcHandler;
  const input = { sessionId: 'source', clientTurnId: 'new-input', startedAt: 2 };
  return { launch, beginSessionRun, handler, input };
}

test.each(['settled', 'unsettled', 'unavailable'])(
  'admits an ordinary main follow-up while the previous Team launch cleanup is %s',
  async condition => {
    const { launch, beginSessionRun, handler, input } = registerTeamFollowupFixture();
    if (condition === 'settled') launch.releaseIfSettled.mockResolvedValue(true);
    if (condition === 'unavailable')
      launch.releaseIfSettled.mockRejectedValue(new Error('Gateway disconnected'));

    await expect(handler(null, input)).resolves.toMatchObject({
      success: true,
      timing: { id: 'followup', clientTurnId: 'new-input' },
    });
    expect(beginSessionRun).toHaveBeenCalledWith(input);
    expect(launch.releaseIfSettled).toHaveBeenCalledWith('source');
    expect(launch.register).not.toHaveBeenCalled();
    expect(launch.cancel).not.toHaveBeenCalled();
  },
);

test.each(['task', 'group'] as const)(
  'keeps a new explicit %s Team launch blocked until the previous launch is settled',
  async mode => {
    const { launch, beginSessionRun, handler, input } = registerTeamFollowupFixture();
    await expect(
      handler(null, { ...input, agentTeamPrompt: appendAgentTeamInstruction('New team', mode) }),
    ).resolves.toMatchObject({ success: false });
    expect(launch.releaseIfSettled).toHaveBeenCalledWith('source');
    expect(launch.register).not.toHaveBeenCalled();
    expect(beginSessionRun).not.toHaveBeenCalled();
  },
);

test('preserves the active user-run rejection independently of previous Team launch cleanup', async () => {
  const { launch, beginSessionRun, handler, input } = registerTeamFollowupFixture();
  beginSessionRun.mockImplementation(() => {
    throw new Error('This session already has an active user run.');
  });
  await expect(handler(null, input)).resolves.toMatchObject({
    success: false,
    error: 'This session already has an active user run.',
  });
  expect(launch.releaseIfSettled).toHaveBeenCalledWith('source');
  expect(launch.cancel).not.toHaveBeenCalled();
});

test('does not let a failed guard cancellation prevent stopping the actual source run', async () => {
  const stopSession = vi.fn().mockResolvedValue(undefined);
  registerCoworkSessionHandlers({
    getAgentTeamLaunch: () =>
      ({
        cancel: vi.fn().mockRejectedValue(new Error('disconnected')),
      }) as unknown as AgentTeamLaunchCoordinator,
    getCoworkStore: () => ({}) as CoworkStore,
    getCoworkEngineRouter: () => ({ stopSession }) as unknown as CoworkEngineRouter,
    setSessionPermissionMode: vi.fn(),
  });
  const handler = mocks.handle.mock.calls.find(
    ([name]) => name === 'cowork:session:stop',
  )![1] as IpcHandler;
  await expect(handler(null, 'source')).resolves.toEqual({ success: true });
  expect(stopSession).toHaveBeenCalledWith('source', { diagnosticUserInitiated: true });
});

test('stops the source immediately while guard cancellation is still awaiting Gateway', async () => {
  let finishGuard!: () => void;
  const cancel = vi.fn(
    () =>
      new Promise<void>(resolve => {
        finishGuard = resolve;
      }),
  );
  const stopSession = vi.fn().mockResolvedValue(undefined);
  registerCoworkSessionHandlers({
    getAgentTeamLaunch: () => ({ cancel }) as unknown as AgentTeamLaunchCoordinator,
    getCoworkStore: () => ({}) as CoworkStore,
    getCoworkEngineRouter: () => ({ stopSession }) as unknown as CoworkEngineRouter,
    setSessionPermissionMode: vi.fn(),
  });
  const handler = mocks.handle.mock.calls.find(
    ([name]) => name === 'cowork:session:stop',
  )![1] as IpcHandler;
  const stopping = handler(null, 'source');
  await vi.waitFor(() =>
    expect(stopSession).toHaveBeenCalledWith('source', { diagnosticUserInitiated: true }),
  );
  expect(cancel).toHaveBeenCalledExactlyOnceWith('source', undefined);
  expect(cancel.mock.invocationCallOrder[0]).toBeLessThan(stopSession.mock.invocationCallOrder[0]);
  await expect(stopping).resolves.toEqual({ success: true });
  finishGuard();
});

test('releases a closed pre-send sender only through the exact guard client contract', async () => {
  const abortBeforeSend = vi.fn().mockResolvedValue(true);
  registerCoworkSessionHandlers({
    getAgentTeamLaunch: () => ({ abortBeforeSend }) as unknown as AgentTeamLaunchCoordinator,
    getCoworkStore: () => ({}) as CoworkStore,
    getCoworkEngineRouter: () => ({}) as CoworkEngineRouter,
    setSessionPermissionMode: vi.fn(),
  });
  const handler = mocks.handle.mock.calls.find(
    ([name]) => name === SessionRunIpc.TeamSubmissionAbortedBeforeSend,
  )![1] as IpcHandler;
  await expect(
    handler(null, { sessionId: 'source', clientTurnId: 'exact-client' }),
  ).resolves.toEqual({ success: true });
  expect(abortBeforeSend).toHaveBeenCalledWith('source', 'exact-client');
  await expect(
    handler(null, { sessionId: 'source', clientTurnId: 'exact-client', neverSubmitted: true }),
  ).resolves.toMatchObject({ success: false });
  expect(abortBeforeSend).toHaveBeenCalledOnce();
  abortBeforeSend.mockResolvedValue(false);
  await expect(
    handler(null, { sessionId: 'source', clientTurnId: 'old-client' }),
  ).resolves.toMatchObject({ success: false });
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
    markSessionBranchPending: vi.fn(),
    clearSessionBranchPending: vi.fn(),
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
    if (method === 'chat.history') {
      if ((params as { cursor?: string })?.cursor)
        return {
          kind: 'delta',
          deltaCursor: 'cursor',
          messages: [],
          sessionInfo: { sessionId: 'gateway-copy' },
        };
      return {
        sessionId: 'gateway-copy',
        deltaCursor: 'cursor',
        totalMessages: 1,
        messages: [
          { role: 'assistant', __openclaw: { id: 'copy-answer', runId: 'copied-native-run' } },
        ],
      };
    }
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
  expect(router.prepareSession).toHaveBeenCalledWith(copied.id, { pendingBranchPreparation: true });
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
  expect(store.copyTerminalSessionRuns).toHaveBeenCalledWith(
    source.id,
    copied.id,
    new Set(['copied-native-run']),
  );
  expect(vi.mocked(store.markSessionBranchPending).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(router.prepareSession).mock.invocationCallOrder[0],
  );
  expect(store.clearSessionBranchPending).toHaveBeenCalledWith(copied.id);
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
    markSessionBranchPending: vi.fn(),
    clearSessionBranchPending: vi.fn(),
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

test('retains the target identity when the copy creation response is lost', async () => {
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
    markSessionBranchPending: vi.fn(),
    clearSessionBranchPending: vi.fn(),
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
    session: { ...copied, status: 'error', branchCreationPending: true },
  });
  expect(store.deleteSession).not.toHaveBeenCalled();
  expect(router.onSessionDeleted).not.toHaveBeenCalled();
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

test('preserves the preparation failure when native recovery lookup is incomplete', async () => {
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
    markSessionBranchPending: vi.fn(),
    clearSessionBranchPending: vi.fn(),
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
    session: { ...copied, status: 'error', branchCreationPending: true },
  });
  expect(store.deleteSession).not.toHaveBeenCalled();
  expect(router.onSessionDeleted).not.toHaveBeenCalled();
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
    markSessionBranchPending: vi.fn(),
    clearSessionBranchPending: vi.fn(),
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
    if (method === 'chat.history') {
      if ((params as { cursor?: string })?.cursor)
        return {
          kind: 'delta',
          deltaCursor: 'cursor',
          messages: [],
          sessionInfo: { sessionId: 'gateway-fork' },
        };
      return {
        sessionId: 'gateway-fork',
        deltaCursor: 'cursor',
        totalMessages: 1,
        messages: [{ role: 'assistant', __openclaw: { id: 'entry-1', runId: 'cut-run' } }],
      };
    }
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
  expect(router.prepareSession).toHaveBeenCalledWith(forked.id, { pendingBranchPreparation: true });
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
  expect(store.copyTerminalSessionRuns).toHaveBeenCalledWith(
    source.id,
    forked.id,
    new Set(['cut-run']),
  );
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
    markSessionBranchPending: vi.fn(),
    clearSessionBranchPending: vi.fn(),
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
  const requestGateway = vi.fn(async (method: string, params?: unknown) => {
    if (method === 'chat.history') {
      if ((params as { cursor?: string })?.cursor)
        return {
          kind: 'delta',
          deltaCursor: 'cursor',
          messages: [],
          sessionInfo: { sessionId: 'gateway-fork' },
        };
      return {
        sessionId: 'gateway-fork',
        deltaCursor: 'cursor',
        totalMessages: 1,
        messages: [
          { role: 'assistant', __openclaw: { id: 'assistant-entry', runId: 'latest-run' } },
        ],
      };
    }
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
  expect(store.copyTerminalSessionRuns).toHaveBeenCalledWith(
    source.id,
    forked.id,
    new Set(['latest-run']),
  );
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
    markSessionBranchPending: vi.fn(),
    clearSessionBranchPending: vi.fn(),
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
    requestGateway: vi.fn(async (method: string) =>
      method === 'sessions.describe'
        ? { session: null }
        : { sessionKey: 'agent:main:dashboard:wrong' },
    ),
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

test.each(['copy', 'fork'] as const)(
  'retains a %s whose physical identity changes during preparation',
  async action => {
    const source = {
      id: 'source',
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
    const target = { ...source, id: 'target', title: 'Target' };
    const store = {
      getSession: vi.fn().mockReturnValue(source),
      createSession: vi.fn().mockReturnValue(target),
      markSessionBranchPending: vi.fn(),
      clearSessionBranchPending: vi.fn(),
      deleteSession: vi.fn(),
      updateSession: vi.fn(),
      copyTerminalSessionRuns: vi.fn(),
    } as unknown as CoworkStore;
    const router = {
      getSessionRuntimeStatus: vi.fn().mockResolvedValue({ known: true, running: false }),
      prepareSession: vi.fn().mockResolvedValue({
        sessionKey: 'agent:main:justdo:target',
        gatewaySessionId: 'replacement',
      }),
      onSessionDeleted: vi.fn(),
    } as unknown as CoworkEngineRouter;
    const requestGateway = vi.fn(async (method: string, params?: unknown) => {
      if (method === 'sessions.describe')
        return {
          session: (params as { key: string }).key.endsWith(':target')
            ? { sessionId: 'original', goal: null }
            : { pluginExtensions: [] },
        };
      if (method === 'sessions.create')
        return { key: 'agent:main:justdo:target', sessionId: 'original' };
      return { sessionKey: 'agent:main:justdo:target' };
    });
    registerCoworkSessionHandlers({
      getCoworkStore: () => store,
      getCoworkEngineRouter: () => router,
      setSessionPermissionMode: vi.fn(),
      requestGateway,
    });
    const handler = mocks.handle.mock.calls.find(
      ([channel]) =>
        channel === (action === 'copy' ? CoworkSessionCopyIpc.Copy : CoworkSessionForkIpc.Fork),
    )![1] as IpcHandler;
    await expect(
      handler({}, { sessionId: source.id, title: target.title, entryId: 'answer' }),
    ).resolves.toMatchObject({
      success: false,
      session: { id: target.id, status: 'error' },
      error: `The ${action === 'copy' ? 'copied' : 'forked'} session identity changed during preparation.`,
    });
    expect(store.deleteSession).not.toHaveBeenCalled();
    expect(store.copyTerminalSessionRuns).not.toHaveBeenCalled();
    expect(requestGateway).not.toHaveBeenCalledWith('sessions.goal.clear', expect.anything());
  },
);

test('does not clear a replacement session Goal after a copy', async () => {
  const source = {
    id: 'source',
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
  const target = { ...source, id: 'target', title: 'Copy' };
  const store = {
    getSession: vi.fn().mockReturnValue(source),
    createSession: vi.fn().mockReturnValue(target),
    markSessionBranchPending: vi.fn(),
    clearSessionBranchPending: vi.fn(),
    deleteSession: vi.fn(),
    updateSession: vi.fn(),
    copyTerminalSessionRuns: vi.fn(),
  } as unknown as CoworkStore;
  const router = {
    getSessionRuntimeStatus: vi.fn().mockResolvedValue({ known: true, running: false }),
    prepareSession: vi
      .fn()
      .mockResolvedValue({ sessionKey: 'agent:main:justdo:target', gatewaySessionId: 'original' }),
    onSessionDeleted: vi.fn(),
  } as unknown as CoworkEngineRouter;
  const requestGateway = vi.fn(async (method: string, params?: unknown) => {
    if (method === 'sessions.describe')
      return {
        session: (params as { key: string }).key.endsWith(':target')
          ? { sessionId: 'replacement', goal: { id: 'foreign-goal' } }
          : { pluginExtensions: [] },
      };
    return { key: 'agent:main:justdo:target', sessionId: 'original' };
  });
  registerCoworkSessionHandlers({
    getCoworkStore: () => store,
    getCoworkEngineRouter: () => router,
    setSessionPermissionMode: vi.fn(),
    requestGateway,
  });
  const handler = mocks.handle.mock.calls.find(
    ([channel]) => channel === CoworkSessionCopyIpc.Copy,
  )![1] as IpcHandler;
  await expect(handler({}, { sessionId: source.id, title: target.title })).resolves.toMatchObject({
    success: false,
    error: 'The copied session identity changed during Goal verification.',
    session: { id: target.id, status: 'error' },
  });
  expect(requestGateway).not.toHaveBeenCalledWith('sessions.goal.clear', expect.anything());
});

test.each(['copy', 'fork'] as const)(
  '%s distinguishes native rejection from an unknown creation',
  async action => {
    for (const rejected of [true, false]) {
      mocks.handle.mockReset();
      const source = {
        id: 'source',
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
      const target = { ...source, id: 'target', title: 'Copy' };
      const store = {
        getSession: vi.fn().mockReturnValue(source),
        createSession: vi.fn().mockReturnValue(target),
        markSessionBranchPending: vi.fn(),
        clearSessionBranchPending: vi.fn(),
        deleteSession: vi.fn(),
        updateSession: vi.fn(),
      } as unknown as CoworkStore;
      const router = {
        getSessionRuntimeStatus: vi.fn().mockResolvedValue({ known: true, running: false }),
        onSessionDeleted: vi.fn(),
        prepareSession: vi.fn(),
      } as unknown as CoworkEngineRouter;
      const failure = Object.assign(
        new Error(rejected ? 'rejected' : 'request timeout: session creation'),
        rejected
          ? { gatewayCode: 'INVALID_REQUEST' }
          : { code: 'CLIENT_TIMEOUT', requestSent: true },
      );
      const requestGateway = vi.fn(async (method: string, params?: unknown) => {
        if (method === 'sessions.describe')
          return {
            session: (params as { key: string }).key.endsWith(':target')
              ? null
              : { pluginExtensions: [] },
          };
        throw failure;
      });
      registerCoworkSessionHandlers({
        getCoworkStore: () => store,
        getCoworkEngineRouter: () => router,
        requestGateway,
        setSessionPermissionMode: vi.fn(),
      });
      const handler = mocks.handle.mock.calls.find(
        ([channel]) =>
          channel === (action === 'copy' ? CoworkSessionCopyIpc.Copy : CoworkSessionForkIpc.Fork),
      )![1] as IpcHandler;
      const result = await handler(
        {},
        { sessionId: source.id, title: target.title, entryId: 'answer' },
      );
      if (rejected) {
        expect(result).toEqual({ success: false, error: 'rejected' });
        expect(store.deleteSession).toHaveBeenCalledWith(target.id);
      } else {
        expect(result).toMatchObject({
          success: false,
          session: { id: target.id, branchCreationPending: true },
        });
        expect(store.deleteSession).not.toHaveBeenCalled();
      }
      expect(
        requestGateway.mock.calls.filter(
          ([method]) => method === (action === 'copy' ? 'sessions.create' : 'sessions.fork'),
        ),
      ).toHaveLength(1);
      expect(router.prepareSession).not.toHaveBeenCalled();
    }
  },
);

test('unfinished branch metadata blocks run admission and both source-copy actions before native access', async () => {
  const store = {
    getSession: vi.fn().mockReturnValue({ id: 'pending', branchCreationPending: true }),
    beginSessionRun: vi.fn(),
  } as unknown as CoworkStore;
  const requestGateway = vi.fn();
  const router = { getSessionRuntimeStatus: vi.fn() } as unknown as CoworkEngineRouter;
  registerCoworkSessionHandlers({
    getCoworkStore: () => store,
    getCoworkEngineRouter: () => router,
    requestGateway,
    setSessionPermissionMode: vi.fn(),
  });
  for (const channel of [
    CoworkSessionCopyIpc.Copy,
    CoworkSessionForkIpc.Fork,
    'cowork:session:run:begin',
  ]) {
    const handler = mocks.handle.mock.calls.find(([name]) => name === channel)![1] as IpcHandler;
    await expect(
      handler(
        {},
        {
          sessionId: 'pending',
          title: 'Copy',
          entryId: 'answer',
          clientTurnId: 'input',
          startedAt: 1,
        },
      ),
    ).resolves.toMatchObject({ success: false });
  }
  expect(store.beginSessionRun).not.toHaveBeenCalled();
  expect(requestGateway).not.toHaveBeenCalled();
  expect(router.getSessionRuntimeStatus).not.toHaveBeenCalled();
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
    targeted: true,
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
    targeted: true,
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
    targeted: true,
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
  const bindSessionRunRootRun = vi.fn(
    (_id, rootRunId) => (timing = { ...timing, rootRunId, acceptedAt: Date.now() }),
  );
  const requestGateway = vi.fn().mockResolvedValue({ runId: 'client-1', ...result });
  registerCoworkSessionHandlers({
    getCoworkStore: () =>
      ({
        getLatestSessionRun: () => timing,
        finishSessionRun,
        bindSessionRunRootRun,
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
  if (state) {
    expect(finishSessionRun).toHaveBeenCalledWith('timing-1', state, expect.any(Number));
    expect(bindSessionRunRootRun).toHaveBeenCalledWith('timing-1', 'client-1');
  } else {
    expect(finishSessionRun).not.toHaveBeenCalled();
    expect(bindSessionRunRootRun).not.toHaveBeenCalled();
  }
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
  const bindSessionRunRootRun = vi.fn(
    (_id, rootRunId) => (timing = { ...timing, rootRunId, acceptedAt: Date.now() }),
  );
  const beginSessionRun = vi.fn();
  const registerUnknownSessionRun = vi.fn();
  const requestGateway = vi.fn().mockResolvedValue({ runId: 'unknown-run', status: 'timeout' });
  const idle = { known: true, running: false, mainRunning: false, subagentRunning: false };
  registerCoworkSessionHandlers({
    getCoworkStore: () =>
      ({
        getLatestSessionRun: () => timing,
        finishSessionRun,
        bindSessionRunRootRun,
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
    timing: {
      state: 'aborted',
      endedAt: 4000,
      rootRunId: 'unknown-run',
      acceptedAt: expect.any(Number),
    },
  });
  expect(bindSessionRunRootRun).toHaveBeenCalledExactlyOnceWith('timing-unknown', 'unknown-run');
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
