import { beforeEach, expect, test, vi } from 'vitest';

import { SessionRunBeginErrorCode } from '../../../shared/cowork/sessionRun';
import type { AgentTeamLaunchCoordinator } from '../../cowork/agent-team/agentTeamLaunchCoordinator';
import type { CoworkStore } from '../../data/coworkStore';
import type { CoworkEngineRouter } from '../../engine';
import {
  getSessionRuntimeStatus,
  getSessionRuntimeStatuses,
  invalidateTargetedSessionStatusChecks,
  type RuntimeSessionStatusContext,
} from '../../engine/openclaw/runtimeSessionStatus';

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>());
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) => handlers.set(name, handler) } }));

import { registerCoworkSessionHandlers } from './sessions';

beforeEach(() => handlers.clear());

function fixture(
  getStartupEngineNotReadyResponse?: () => { success: boolean; code: string; error: string } | undefined,
  getAgentTeamLaunch?: () => AgentTeamLaunchCoordinator,
) {
  const sessionId = '43795fc3-437a-4f60-b731-1d115d2b8787';
  const key = `agent:main:justdo:${sessionId}`;
  const source = { id: sessionId, agentId: 'main', cwd: '/workspace', permissionMode: 'ask',
    status: 'idle', nativeSessionKey: key, historyBinding: { nativeSessionId: 'native-current' } };
  const checkpoint = { id: 'restart-checkpoint', sessionId, clientTurnId: 'old-run',
    state: 'aborted', startedAt: 100, acceptedAt: 100, endedAt: 100 };
  const next = { sessionId, clientTurnId: 'new-input', startedAt: 200 };
  const beginSessionRun = vi.fn(input => ({ ...input, id: 'new-receipt', state: 'running' }));
  const getLatestSessionRun = vi.fn<() => unknown>(() => checkpoint);
  const finishSessionRun = vi.fn();
  const reopenSessionRun = vi.fn(() => ({ ...checkpoint, state: 'running' }));
  const store = {
    getSession: () => source, getAgent: () => ({ enabled: true }),
    getSessionRuns: () => [checkpoint], getLatestSessionRun, beginSessionRun,
    reopenSessionRun, finishSessionRun,
  } as unknown as CoworkStore;
  const native = { key, agentId: 'main', sessionId: 'native-current', lifecycleRevision: 'revision', hasActiveRun: false };
  const request = vi.fn().mockResolvedValue({ session: native });
  const state = { active: false, generation: 1 };
  const unknownRuns = new Map<string, unknown>();
  const context = {
    store, ensureGatewayClientReady: async () => {}, gatewayClient: { request },
    get gatewayClientGeneration() { return state.generation; },
    targetedSessionStatusChecks: new Map(), unknownSessionRuns: unknownRuns,
    disconnectedSessionIds: new Set(), disconnectedRecoveryPromises: new Map(),
    compactionInFlightSessionIds: new Set(), isSessionActive: () => state.active,
    goalContinuationCoordinator: { getSnapshot: () => undefined },
    // An unrelated publication can invalidate a full roster during pagination.
    // This is a genuine unknown snapshot, never permission to assume idle.
    getRuntimeSessionSnapshot: vi.fn(async () => ({ known: false, sessions: [], hasMore: false })),
    getSessionRuntimeStatuses: (ids: string[], options: Parameters<typeof getSessionRuntimeStatuses>[1]) =>
      getSessionRuntimeStatuses.call(context, ids, options),
    rootRunIdBySession: new Map(), subagentStatusCache: new Map(),
  } as unknown as RuntimeSessionStatusContext;
  registerCoworkSessionHandlers({ getCoworkStore: () => store,
    getStartupEngineNotReadyResponse,
    getAgentTeamLaunch,
    getCoworkEngineRouter: () => ({ getSessionRuntimeStatus: (id: string, options: Parameters<typeof getSessionRuntimeStatus>[1]) =>
      getSessionRuntimeStatus.call(context, id, options) }) as CoworkEngineRouter,
    setSessionPermissionMode: vi.fn() });
  return { context, request, native, source, state, beginSessionRun, key, unknownRuns,
    checkpoint, getLatestSessionRun, finishSessionRun, reopenSessionRun,
    send: (agentTeamPrompt?: string) => handlers.get('cowork:session:run:begin')!({}, {
      ...next, ...(agentTeamPrompt ? { agentTeamPrompt } : {}),
    }) };
}

test('admits an existing main input from its current native row despite unrelated roster changes', async () => {
  const f = fixture();
  f.request.mockImplementation(async () => {
    invalidateTargetedSessionStatusChecks(f.context.targetedSessionStatusChecks, {
      session: { key: 'agent:other:independent-root', controlOwnerSessionKey: null },
    });
    return { session: f.native };
  });

  await expect(f.send()).resolves.toMatchObject({ success: true, timing: { id: 'new-receipt' } });
  expect(f.request).toHaveBeenCalledExactlyOnceWith('sessions.describe', { key: f.key, agentId: 'main' });
  expect(f.context.getRuntimeSessionSnapshot).not.toHaveBeenCalled();
  expect(f.beginSessionRun).toHaveBeenCalledOnce();
});

test('rejects input immediately during engine preparation without waiting for native runtime reads', async () => {
  let pending = true;
  const f = fixture(() => pending ? { success: false, code: 'ENGINE_NOT_READY', error: 'starting' } : undefined);
  await expect(f.send()).resolves.toMatchObject({ success: false, code: 'ENGINE_NOT_READY' });
  expect(f.request).not.toHaveBeenCalled();
  expect(f.beginSessionRun).not.toHaveBeenCalled();
  pending = false;
  await expect(f.send()).resolves.toMatchObject({ success: true });
});

test('rechecks startup admission after a native status read before creating a run receipt', async () => {
  let pending = false;
  const f = fixture(() => pending ? { success: false, code: 'ENGINE_NOT_READY', error: 'starting' } : undefined);
  f.request.mockImplementation(async () => { pending = true; return { session: f.native }; });
  await expect(f.send()).resolves.toMatchObject({ success: false, code: 'ENGINE_NOT_READY' });
  expect(f.beginSessionRun).not.toHaveBeenCalled();
});

test('retires the exact Team reservation if startup admission changes while registration is in flight', async () => {
  let pending = false;
  const launch = {
    releaseIfSettled: vi.fn().mockResolvedValue(true),
    register: vi.fn(async () => { pending = true; }),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
  const f = fixture(() => pending ? { success: false, code: 'ENGINE_NOT_READY', error: 'starting' } : undefined,
    () => launch as unknown as AgentTeamLaunchCoordinator);
  await expect(f.send('Compare approaches')).resolves.toMatchObject({ success: false, code: 'ENGINE_NOT_READY' });
  expect(launch.cancel).toHaveBeenCalledExactlyOnceWith(f.source.id, 'new-input');
  expect(f.beginSessionRun).not.toHaveBeenCalled();
});

test.each(['accepted-run', 'replacement-checkpoint', 'removed'])(
  'does not reconcile or overwrite a %s that replaces the checkpoint during the exact read', async kind => {
    const f = fixture();
    f.request.mockImplementation(async () => {
      f.getLatestSessionRun.mockReturnValue(kind === 'removed' ? undefined : {
        ...f.checkpoint, id: 'replacement',
        ...(kind === 'accepted-run' ? { state: 'running', startedAt: 200, acceptedAt: 201, endedAt: undefined } : {}),
      });
      return { session: f.native };
    });
    await expect(f.send()).resolves.toMatchObject({ success: false, errorCode: SessionRunBeginErrorCode.RuntimeUnknown });
    expect(f.beginSessionRun).not.toHaveBeenCalled();
    expect(f.finishSessionRun).not.toHaveBeenCalled();
    expect(f.reopenSessionRun).not.toHaveBeenCalled();
    expect(f.context.getRuntimeSessionSnapshot).not.toHaveBeenCalled();
  },
);

test.each(['hasActiveRun', 'hasActiveSubagentRun'])('refuses native queued/running activity: %s', async field => {
  const f = fixture();
  f.request.mockResolvedValue({ session: { ...f.native, [field]: true } });
  await expect(f.send()).resolves.toMatchObject({ success: false, errorCode: SessionRunBeginErrorCode.RuntimeActive });
  expect(f.beginSessionRun).not.toHaveBeenCalled();
});

test.each(['absent', 'unbound-absent', 'foreign', 'error', 'target-changed', 'ancestor-unknown', 'connection-changed'])(
  'retains the startup checkpoint without admitting input when native evidence is %s', async kind => {
    const f = fixture();
    if (kind === 'absent') f.request.mockResolvedValue({ session: null });
    if (kind === 'unbound-absent') {
      Reflect.deleteProperty(f.source, 'nativeSessionKey');
      Reflect.deleteProperty(f.source, 'historyBinding');
      f.request.mockResolvedValue({ session: null });
    }
    if (kind === 'foreign') f.request.mockResolvedValue({ session: { ...f.native, sessionId: 'replacement' } });
    if (kind === 'error') f.request.mockRejectedValue(new Error('UNAVAILABLE'));
    if (kind === 'target-changed' || kind === 'ancestor-unknown' || kind === 'connection-changed') {
      f.request.mockImplementation(async () => {
        if (kind === 'connection-changed') f.state.generation += 1;
        else invalidateTargetedSessionStatusChecks(f.context.targetedSessionStatusChecks,
          kind === 'target-changed' ? { session: { key: f.key, controlOwnerSessionKey: null } }
            : { session: { key: 'agent:other:child', spawnedBy: 'unknown-ancestor' } });
        return { session: f.native };
      });
    }
    await expect(f.send()).resolves.toMatchObject({ success: false, errorCode: SessionRunBeginErrorCode.RuntimeUnknown });
    expect(f.request).toHaveBeenCalledTimes(kind === 'target-changed' || kind === 'ancestor-unknown' ? 2 : 1);
    expect(f.beginSessionRun).not.toHaveBeenCalled();
  },
);

test.each(['unknown', 'disconnected', 'local-active'])('retains existing %s custody before a native read', async kind => {
  const f = fixture();
  const sessionId = f.native.key.split(':').at(-1)!;
  if (kind === 'unknown') f.unknownRuns.set(sessionId, {});
  if (kind === 'disconnected') f.context.disconnectedSessionIds.add(sessionId);
  if (kind === 'local-active') f.state.active = true;
  await expect(f.send()).resolves.toMatchObject({ success: false,
    errorCode: kind === 'local-active' ? SessionRunBeginErrorCode.RuntimeActive : SessionRunBeginErrorCode.RuntimeUnknown });
  expect(f.request).not.toHaveBeenCalled();
  expect(f.beginSessionRun).not.toHaveBeenCalled();
});
