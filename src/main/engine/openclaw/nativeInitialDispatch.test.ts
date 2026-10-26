import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
    getVersion: () => 'test-version',
  },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../cowork/coworkLogger', () => ({ coworkLog: vi.fn() }));
vi.mock('../../core/filesystem/projectGit', () => ({
  ensureProjectGitRepository: vi.fn().mockResolvedValue(undefined),
}));

import { createDefaultAgentRuntimeSettings } from '../../../shared/agents/agentRuntimeSettings';
import { t } from '../../core/i18n';
import type { CoworkStore } from '../../data/coworkStore';
import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';
import { enqueueSessionModelOperation } from '../gateway/sessionModelOperations';
import { SESSION_STORAGE_PREPARATION_TIMEOUT_MS } from '../gateway/sessionStoragePreparation';
import type { GatewayClientLike, SessionTurn } from '../gateway/types';
import type { CoworkStartOptions } from '../types';
import { OpenClawRuntimeAdapter } from './openclawRuntimeAdapter';

const sessionId = 'initial-dispatch-session';
const sessionKey = `agent:main:justdo:${sessionId}`;
const gatewaySessionId = 'native-initial-dispatch-session';
const clientTurnId = 'justdo-1700000000000-initial-dispatch';
const startedAt = 1700000000042;

type DispatchInternals = {
  gatewayClient: GatewayClientLike | null;
  gatewayClientGeneration: number;
  ensureGatewayClientReady: () => Promise<void>;
  activeTurns: Map<string, SessionTurn>;
  unknownSessionRuns: Map<string, { runId: string; cancelled: boolean }>;
  resolveTurn: (id: string) => void;
  cleanupSessionTurn: (id: string) => void;
  persistTerminalGoalSnapshot: () => Promise<void>;
};

const cleanup = new Set<() => void>();
afterEach(() => {
  for (const dispose of cleanup) dispose();
  cleanup.clear();
  vi.useRealTimers();
});

function setup(sendReceipt?: Record<string, unknown>) {
  let configGeneration = 0;
  const session = {
    id: sessionId,
    title: 'Synthetic initial dispatch',
    status: 'idle',
    cwd: process.cwd(),
    executionMode: 'local',
    permissionMode: 'full',
    activeSkillIds: [],
    agentId: 'main',
    modelRef: 'fixture/model',
    createdAt: 1,
    updatedAt: 1,
  };
  const timing = { id: 'timing-initial', sessionId, clientTurnId, startedAt, state: 'running' };
  const updateSession = vi.fn((_id: string, changes: Record<string, unknown>) => {
    Object.assign(session, changes);
  });
  const bindSessionRunRootRun = vi.fn();
  const finishSessionRun = vi.fn();
  const store = {
    getSession: (id: string) => (id === sessionId ? session : null),
    getAgent: () => null,
    getConfig: () => ({ maxGoalContinuationTurns: 3 }),
    getAgentRuntimeSettings: () => createDefaultAgentRuntimeSettings(),
    getSessionRunByClientTurnId: (id: string) => (id === clientTurnId ? timing : undefined),
    updateSession,
    bindSessionRunRootRun,
    finishSessionRun,
  };
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'sessions.describe') return { session: null };
    if (method === 'sessions.create') {
      return {
        key: sessionKey,
        sessionId: gatewaySessionId,
        entry: { sessionId: gatewaySessionId, sessionRoot: process.cwd(), permissionMode: 'full' },
      };
    }
    if (method === 'chat.send')
      return sendReceipt ?? { runId: params?.idempotencyKey, status: 'started' };
    throw new Error(`Unexpected Main RPC: ${method}`);
  });
  const adapter = new OpenClawRuntimeAdapter(
    store as unknown as CoworkStore,
    { getGatewayConfigReloadGeneration: () => configGeneration } as OpenClawEngineManager,
  );
  adapter.on('error', vi.fn());
  const internals = adapter as unknown as DispatchInternals;
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  cleanup.add(() => internals.cleanupSessionTurn(sessionId));
  const finish = async (running: Promise<void>) => {
    internals.resolveTurn(sessionId);
    await running;
    internals.cleanupSessionTurn(sessionId);
  };
  return {
    adapter,
    session,
    internals,
    request,
    updateSession,
    bindSessionRunRootRun,
    finishSessionRun,
    finish,
    reloadConfig: () => { configGeneration += 1; },
  };
}

const initialSelection = () => ({
  key: sessionKey, sessionId: gatewaySessionId,
  entry: { sessionId: gatewaySessionId, sessionRoot: process.cwd(), permissionMode: 'full',
    providerOverride: 'fixture', modelOverride: 'new' },
  resolved: { modelProvider: 'fixture', model: 'new' },
});

const initialSelectionRow = () => ({
  key: sessionKey, sessionId: gatewaySessionId, sessionRoot: process.cwd(), permissionMode: 'full',
  modelProvider: 'fixture', model: 'new', modelOverrideSource: 'user',
  activeModelProvider: 'previous', activeModel: 'execution',
});

function useInitialSelection(s: ReturnType<typeof setup>) {
  const original = s.request.getMockImplementation()!;
  let created = false;
  s.request.mockImplementation(async (method, params) => {
    if (method === 'sessions.create') {
      created = true;
      s.reloadConfig();
      return initialSelection();
    }
    if (method === 'sessions.describe') return { session: created ? initialSelectionRow() : null };
    return original(method, params);
  });
}

const pendingStorage = () => Object.assign(new Error('Session access facts are unavailable'), {
  code: 'UNAVAILABLE', gatewayCode: 'UNAVAILABLE',
});

describe('initial native storage preparation', () => {
  it('waits only on the read, then creates and sends once with the captured model', async () => {
    vi.useFakeTimers();
    const s = setup();
    useInitialSelection(s);
    s.request.mockRejectedValueOnce(pendingStorage());
    const accepted = vi.fn();
    const running = s.adapter.startSession(sessionId, 'Use the captured selection', {
      clientTurnId, initialModelRef: 'fixture/new', onAccepted: accepted,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.request.mock.calls.map(([method]) => method)).toEqual(['sessions.describe']);
    s.reloadConfig();
    s.session.modelRef = 'fixture/background-default';
    await vi.advanceTimersByTimeAsync(1_000);
    expect(accepted).toHaveBeenCalledOnce();
    expect(s.request.mock.calls.filter(([method]) => method === 'sessions.create')).toHaveLength(1);
    expect(s.request.mock.calls.filter(([method]) => method === 'chat.send')).toHaveLength(1);
    expect(s.request).toHaveBeenCalledWith('sessions.create', {
      key: sessionKey, cwd: process.cwd(), permissionMode: 'full', model: 'fixture/new',
    });
    expect(s.request.mock.calls.filter(([method]) => method === 'sessions.describe')).toHaveLength(3);
    await s.finish(running);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops a hanging read immediately and never creates after Stop', async () => {
    vi.useFakeTimers();
    const s = setup();
    vi.spyOn(s.internals, 'persistTerminalGoalSnapshot').mockResolvedValue(undefined);
    let releaseRead!: (value: unknown) => void;
    s.request.mockImplementationOnce(async () => new Promise(resolve => { releaseRead = resolve; }));
    const running = s.adapter.startSession(sessionId, 'Cancelled before create', { clientTurnId });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.request).toHaveBeenCalledOnce();
    await s.adapter.stopSession(sessionId);
    await running;
    releaseRead({ session: null });
    await Promise.resolve();
    expect(s.request.mock.calls.every(([method]) => method === 'sessions.describe')).toBe(true);
    expect(s.session.status).toBe('idle');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts the preceding preparation when a new turn takes its place', async () => {
    vi.useFakeTimers();
    const s = setup();
    useInitialSelection(s);
    s.request.mockImplementationOnce(async () => new Promise(() => {}));
    const first = s.adapter.startSession(sessionId, 'Superseded input', {
      clientTurnId, initialModelRef: 'fixture/new',
    });
    await vi.advanceTimersByTimeAsync(0);
    const accepted = vi.fn();
    const second = s.adapter.startSession(sessionId, 'Current input', {
      clientTurnId: 'justdo-1700000000001-replacement', initialModelRef: 'fixture/new', onAccepted: accepted,
    });
    await vi.advanceTimersByTimeAsync(0);
    await first;
    expect(accepted).toHaveBeenCalledOnce();
    expect(s.request.mock.calls.filter(([method]) => method === 'sessions.create')).toHaveLength(1);
    expect(s.request.mock.calls.filter(([method]) => method === 'chat.send')).toHaveLength(1);
    expect(s.request.mock.calls.find(([method]) => method === 'chat.send')?.[1]?.message).toBe('Current input');
    await s.finish(second);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not create when the captured connection changes during a hanging read', async () => {
    vi.useFakeTimers();
    const s = setup();
    s.request.mockImplementation(async () => new Promise(() => {}));
    const running = s.adapter.startSession(sessionId, 'Keep the native owner', { clientTurnId });
    const rejected = expect(running).rejects.toThrow(t('sessionStoragePreparationChanged'));
    await vi.advanceTimersByTimeAsync(0);
    s.internals.gatewayClientGeneration += 1;
    await vi.advanceTimersByTimeAsync(250);
    await rejected;
    expect(s.request.mock.calls.map(([method]) => method)).toEqual(['sessions.describe']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['agent', 'workspace', 'permission', 'binding', 'native-key', 'branch'] as const)(
    'does not create after its product %s context changes', async changed => {
      vi.useFakeTimers();
      const s = setup();
      s.request.mockImplementation(async () => new Promise(() => {}));
      const running = s.adapter.startSession(sessionId, 'Keep the captured context', { clientTurnId });
      const rejected = expect(running).rejects.toThrow(t('sessionStoragePreparationChanged'));
      await vi.advanceTimersByTimeAsync(0);
      if (changed === 'agent') s.session.agentId = 'other';
      if (changed === 'workspace') s.session.cwd = `${process.cwd()}-replacement`;
      if (changed === 'permission') s.session.permissionMode = 'ask';
      if (changed === 'binding') Object.assign(s.session, { historyBinding: {
        sessionKey, nativeSessionId: 'replacement-native-session',
      } });
      if (changed === 'native-key') Object.assign(s.session, { nativeSessionKey: 'replacement-key' });
      if (changed === 'branch') Object.assign(s.session, { branchCreationPending: true });
      await vi.advanceTimersByTimeAsync(250);
      await rejected;
      expect(s.request.mock.calls.map(([method]) => method)).toEqual(['sessions.describe']);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('ends the bounded wait without creating or sending', async () => {
    vi.useFakeTimers();
    const s = setup();
    s.request.mockRejectedValue(pendingStorage());
    const running = s.adapter.startSession(sessionId, 'Storage is still preparing', { clientTurnId });
    const rejected = expect(running).rejects.toThrow(t('sessionStoragePreparationTimeout'));
    await vi.advanceTimersByTimeAsync(SESSION_STORAGE_PREPARATION_TIMEOUT_MS);
    await rejected;
    expect(s.request.mock.calls.every(([method]) => method === 'sessions.describe')).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retry a create already dispatched even when its error says storage is unavailable', async () => {
    const s = setup();
    const request = s.request.getMockImplementation()!;
    const uncertainCreate = pendingStorage();
    s.request.mockImplementation(async (method, params) => {
      if (method === 'sessions.create') throw uncertainCreate;
      return request(method, params);
    });
    await expect(s.adapter.startSession(sessionId, 'A single creation attempt', { clientTurnId }))
      .rejects.toBe(uncertainCreate);
    expect(s.request.mock.calls.map(([method]) => method)).toEqual(['sessions.describe', 'sessions.create']);
  });
});

describe('Main initial turn delegated to the presenting Renderer', () => {
  it('confirms the captured first-message model before delegating the only native send', async () => {
    const s = setup();
    useInitialSelection(s);
    const dispatch = vi.fn<NonNullable<CoworkStartOptions['dispatchChatSend']>>().mockResolvedValue({
      runId: clientTurnId, status: 'started',
    });
    const accepted = vi.fn();
    const running = s.adapter.startSession(sessionId, 'Use the model I just selected', {
      clientTurnId, initialModelRef: 'fixture/new', dispatchChatSend: dispatch, onAccepted: accepted,
    });
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce());
    expect(s.request).toHaveBeenCalledWith('sessions.create', {
      key: sessionKey, cwd: process.cwd(), permissionMode: 'full', model: 'fixture/new',
    });
    expect(s.updateSession).toHaveBeenCalledWith(sessionId, { modelRef: 'fixture/new' });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0][0]).toMatchObject({ sessionKey, sessionId: gatewaySessionId });
    expect(s.request.mock.invocationCallOrder[0]).toBeLessThan(dispatch.mock.invocationCallOrder[0]);
    await s.finish(running);
  });

  it('refuses an intervening model change instead of sending with the later model', async () => {
    const s = setup();
    useInitialSelection(s);
    const dispatch = vi.fn<NonNullable<CoworkStartOptions['dispatchChatSend']>>();
    const beforeNativeSend = async () => {
      s.request.mockResolvedValueOnce({ session: {
        ...initialSelectionRow(), model: 'later-selection',
      } });
    };
    await expect(s.adapter.startSession(sessionId, 'Use the captured choice', {
      clientTurnId, initialModelRef: 'fixture/new', dispatchChatSend: dispatch, beforeNativeSend,
    })).rejects.toMatchObject({ requestSent: false });
    expect(dispatch).not.toHaveBeenCalled();
    expect(s.request.mock.calls.map(([method]) => method)).toEqual(['sessions.describe', 'sessions.create', 'sessions.describe']);
  });

  it('refuses a changed connection before sending a previously prepared selection', async () => {
    const s = setup();
    useInitialSelection(s);
    const dispatch = vi.fn<NonNullable<CoworkStartOptions['dispatchChatSend']>>();
    await expect(s.adapter.startSession(sessionId, 'Keep this selection', {
      clientTurnId, initialModelRef: 'fixture/new', dispatchChatSend: dispatch,
      beforeNativeSend: async () => { s.internals.gatewayClientGeneration += 1; },
    })).rejects.toMatchObject({ requestSent: false });
    expect(dispatch).not.toHaveBeenCalled();
    expect(s.request.mock.calls.map(([method]) => method)).toEqual(['sessions.describe', 'sessions.create']);
  });

  it('refuses an unpinned default even when its current model still matches the captured selection', async () => {
    const s = setup();
    useInitialSelection(s);
    const dispatch = vi.fn<NonNullable<CoworkStartOptions['dispatchChatSend']>>();
    await expect(s.adapter.startSession(sessionId, 'Keep my explicit choice', {
      clientTurnId, initialModelRef: 'fixture/new', dispatchChatSend: dispatch,
      beforeNativeSend: async () => {
        s.request.mockResolvedValueOnce({ session: {
          ...initialSelectionRow(), modelOverrideSource: null,
        } });
      },
    })).rejects.toMatchObject({ requestSent: false });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('refuses the same native session ID returned under a different session key', async () => {
    const s = setup();
    useInitialSelection(s);
    const dispatch = vi.fn<NonNullable<CoworkStartOptions['dispatchChatSend']>>();
    await expect(s.adapter.startSession(sessionId, 'Keep the prepared identity', {
      clientTurnId, initialModelRef: 'fixture/new', dispatchChatSend: dispatch,
      beforeNativeSend: async () => {
        s.request.mockResolvedValueOnce({ session: {
          ...initialSelectionRow(), key: 'replacement-key',
        } });
      },
    })).rejects.toMatchObject({ requestSent: false });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('holds model ordering through send acknowledgement and releases it before the run completes', async () => {
    const s = setup();
    useInitialSelection(s);
    let acknowledge!: (value: unknown) => void;
    const dispatch = vi.fn<NonNullable<CoworkStartOptions['dispatchChatSend']>>(() => new Promise(resolve => {
      acknowledge = resolve;
    }));
    const accepted = vi.fn();
    const running = s.adapter.startSession(sessionId, 'Use the captured model', {
      clientTurnId, initialModelRef: 'fixture/new', dispatchChatSend: dispatch, onAccepted: accepted,
    });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    const laterPatch = vi.fn(async () => undefined);
    const later = enqueueSessionModelOperation(sessionKey, laterPatch);
    await Promise.resolve();
    expect(laterPatch).not.toHaveBeenCalled();
    acknowledge({ runId: clientTurnId, status: 'started' });
    await later;
    expect(laterPatch).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce());
    await s.finish(running);
  });

  it('does not send when native preparation returns the preceding model', async () => {
    const s = setup();
    s.request.mockResolvedValueOnce({ session: null });
    s.request.mockResolvedValueOnce({
      key: sessionKey, sessionId: gatewaySessionId,
      entry: { sessionId: gatewaySessionId, sessionRoot: process.cwd(), permissionMode: 'full',
        providerOverride: 'fixture', modelOverride: 'old' },
      resolved: { modelProvider: 'fixture', model: 'old' },
    });
    const dispatch = vi.fn<NonNullable<CoworkStartOptions['dispatchChatSend']>>();
    await expect(s.adapter.startSession(sessionId, 'Use my latest model', {
      clientTurnId, initialModelRef: 'fixture/new', dispatchChatSend: dispatch,
    })).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
    expect(s.request.mock.calls.map(([method]) => method)).toEqual(['sessions.describe', 'sessions.create']);
  });

  it.each(['/stop', '停止！', 'please stop'])(
    'settles the native non-executing control receipt for %s',
    async message => {
      const s = setup();
      const receipt = { ok: true, aborted: false, runIds: [] };
      const dispatch = vi
        .fn<NonNullable<CoworkStartOptions['dispatchChatSend']>>()
        .mockResolvedValue(receipt);
      const accepted = vi.fn();
      const complete = vi.fn();
      s.adapter.on('complete', complete);

      await s.adapter.startSession(sessionId, message, {
        clientTurnId,
        dispatchChatSend: dispatch,
        onAccepted: accepted,
      });

      expect(dispatch).toHaveBeenCalledOnce();
      expect(accepted).toHaveBeenCalledOnce();
      expect(complete).toHaveBeenCalledExactlyOnceWith(sessionId, 'idle');
      expect(s.updateSession).toHaveBeenLastCalledWith(sessionId, { status: 'idle' });
      expect(s.bindSessionRunRootRun).not.toHaveBeenCalled();
      expect(s.finishSessionRun).toHaveBeenCalledExactlyOnceWith(
        'timing-initial',
        'aborted',
        expect.any(Number),
      );
      expect(s.internals.activeTurns.has(sessionId)).toBe(false);
      expect(s.internals.unknownSessionRuns.has(sessionId)).toBe(false);
      expect(s.request.mock.calls.some(([method]) => method === 'chat.send')).toBe(false);
    },
  );

  it('settles an explicit background control acknowledgement including its native warning', async () => {
    const s = setup({
      ok: true,
      aborted: true,
      runIds: ['native-existing-run'],
      warning: 'Synthetic save warning.',
    });
    const accepted = vi.fn();
    await s.adapter.startSession(sessionId, '/stop', { clientTurnId, onAccepted: accepted });

    expect(s.request.mock.calls.map(([method]) => method)).toEqual([
      'sessions.describe',
      'sessions.create',
      'chat.send',
    ]);
    expect(accepted).toHaveBeenCalledOnce();
    expect(s.internals.activeTurns.has(sessionId)).toBe(false);
    expect(s.internals.unknownSessionRuns.has(sessionId)).toBe(false);
    expect(s.bindSessionRunRootRun).not.toHaveBeenCalled();
  });

  it('does not accept a stop control acknowledgement as structured Goal admission', async () => {
    const s = setup();
    const dispatch = vi
      .fn<NonNullable<CoworkStartOptions['dispatchChatSend']>>()
      .mockResolvedValue({ ok: true, aborted: false, runIds: [] });
    const accepted = vi.fn();
    await expect(
      s.adapter.startSession(sessionId, '/goal Synthetic goal', {
        clientTurnId,
        dispatchChatSend: dispatch,
        onAccepted: accepted,
      }),
    ).rejects.toThrow('mismatched Goal start receipt');

    expect(accepted).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(s.internals.activeTurns.has(sessionId)).toBe(false);
    expect(s.internals.unknownSessionRuns.has(sessionId)).toBe(false);
  });

  it('prepares the native session in Main and delegates the identical single chat admission', async () => {
    const s = setup();
    const dispatch = vi
      .fn<NonNullable<CoworkStartOptions['dispatchChatSend']>>()
      .mockResolvedValue({
        runId: clientTurnId,
        status: 'started',
      });
    const accepted = vi.fn();
    const beforeNativeSend = vi.fn().mockResolvedValue(undefined);
    const onNativeSendAbandoned = vi.fn().mockResolvedValue(undefined);
    const running = s.adapter.startSession(sessionId, '  Explore this scenario  ', {
      clientTurnId,
      onAccepted: accepted,
      dispatchChatSend: dispatch,
      beforeNativeSend,
      onNativeSendAbandoned,
      untrustedContext: '  Synthetic private context  ',
      attachments: [{ name: 'input.png', mimeType: 'image/png', base64Data: 'aGVsbG8=' }],
    });

    await vi.waitFor(() => expect(s.bindSessionRunRootRun).toHaveBeenCalled());

    expect(s.request).toHaveBeenCalledWith('sessions.create', {
      key: sessionKey,
      cwd: process.cwd(),
      permissionMode: 'full',
    });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      {
        sessionKey,
        message: 'Explore this scenario',
        deliver: false,
        justdoUserInitiated: true,
        justdoUntrustedContext: 'Synthetic private context',
        timeoutMs: 0,
        idempotencyKey: clientTurnId,
        attachments: [
          { type: 'image', fileName: 'input.png', mimeType: 'image/png', content: 'aGVsbG8=' },
        ],
      },
      { sessionKey, gatewaySessionId },
    );
    expect(accepted).toHaveBeenCalledOnce();
    expect(beforeNativeSend).toHaveBeenCalledOnce();
    expect(beforeNativeSend.mock.invocationCallOrder[0]).toBeLessThan(
      dispatch.mock.invocationCallOrder[0],
    );
    expect(onNativeSendAbandoned).not.toHaveBeenCalled();
    expect(s.bindSessionRunRootRun).toHaveBeenCalledExactlyOnceWith('timing-initial', clientTurnId);
    expect(s.internals.activeTurns.get(sessionId)?.runId).toBe(clientTurnId);
    await s.finish(running);
  });

  it('keeps background admission on the existing Main client without UI capability fields', async () => {
    const s = setup();
    const running = s.adapter.startSession(sessionId, 'Synthetic background task', {
      clientTurnId,
    });
    await vi.waitFor(() => expect(s.bindSessionRunRootRun).toHaveBeenCalled());

    expect(s.request.mock.calls.map(([method]) => method)).toEqual([
      'sessions.describe',
      'sessions.create',
      'chat.send',
    ]);
    const params = s.request.mock.calls.find(([method]) => method === 'chat.send')?.[1];
    expect(params).toMatchObject({ sessionKey, idempotencyKey: clientTurnId });
    expect(params).not.toHaveProperty('caps');
    expect(params).not.toHaveProperty('clientCaps');
    expect(params).not.toHaveProperty('originatingClientCaps');
    await s.finish(running);
  });

  it.each(['/goal status', '/goal pause'])(
    'preserves native slash session identity for %s',
    async command => {
      const s = setup();
      const dispatch = vi
        .fn<NonNullable<CoworkStartOptions['dispatchChatSend']>>()
        .mockResolvedValue({ runId: clientTurnId });
      const running = s.adapter.startSession(sessionId, command, {
        clientTurnId,
        dispatchChatSend: dispatch,
      });
      await vi.waitFor(() => expect(s.bindSessionRunRootRun).toHaveBeenCalled());

      expect(dispatch).toHaveBeenCalledExactlyOnceWith(
        {
          sessionKey,
          sessionId: gatewaySessionId,
          message: command,
          deliver: false,
          justdoUserInitiated: true,
          timeoutMs: 0,
          idempotencyKey: clientTurnId,
        },
        { sessionKey, gatewaySessionId },
      );
      expect(s.request.mock.calls.some(([method]) => method === 'chat.send')).toBe(false);
      await s.finish(running);
    },
  );

  it('delegates structured Goal admission with its durable issued time and no transient timeout', async () => {
    const s = setup();
    const dispatch = vi
      .fn<NonNullable<CoworkStartOptions['dispatchChatSend']>>()
      .mockResolvedValue({
        operationId: clientTurnId,
        action: 'start',
        sessionId: gatewaySessionId,
        runId: clientTurnId,
        goalId: 'fixture-goal',
        status: 'started',
      });
    const accepted = vi.fn();
    const running = s.adapter.startSession(sessionId, '/goal start  Ship the synthetic release  ', {
      clientTurnId,
      dispatchChatSend: dispatch,
      onAccepted: accepted,
    });
    await vi.waitFor(() => expect(s.bindSessionRunRootRun).toHaveBeenCalled());

    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      {
        sessionKey,
        sessionId: gatewaySessionId,
        message: 'Ship the synthetic release',
        intent: { kind: 'session-goal-start', version: 1, issuedAtMs: startedAt },
        deliver: false,
        justdoUserInitiated: true,
        idempotencyKey: clientTurnId,
      },
      { sessionKey, gatewaySessionId },
    );
    expect(accepted).toHaveBeenCalledOnce();
    expect(s.request.mock.calls.some(([method]) => method === 'chat.send')).toBe(false);
    await s.finish(running);
  });

  it('rejects a mismatched Goal receipt before publishing Main admission', async () => {
    const s = setup();
    const dispatch = vi
      .fn<NonNullable<CoworkStartOptions['dispatchChatSend']>>()
      .mockResolvedValue({
        operationId: clientTurnId,
        action: 'start',
        sessionId: 'wrong-native-session',
        runId: clientTurnId,
        goalId: 'fixture-goal',
        status: 'started',
      });
    const accepted = vi.fn();
    await expect(
      s.adapter.startSession(sessionId, '/goal Synthetic goal', {
        clientTurnId,
        dispatchChatSend: dispatch,
        onAccepted: accepted,
      }),
    ).rejects.toThrow('mismatched Goal start receipt');

    expect(dispatch).toHaveBeenCalledOnce();
    expect(accepted).not.toHaveBeenCalled();
    expect(s.request.mock.calls.some(([method]) => method === 'chat.send')).toBe(false);
    expect(s.internals.activeTurns.has(sessionId)).toBe(false);
  });

  it('keeps an uncertain Renderer admission fenced and never retries it through Main', async () => {
    const s = setup();
    const dispatch = vi.fn<NonNullable<CoworkStartOptions['dispatchChatSend']>>().mockRejectedValue(
      Object.assign(new Error('connection lost while dispatching initial chat turn'), {
        code: 'CLIENT_TIMEOUT',
        requestSent: true,
      }),
    );
    const accepted = vi.fn();
    const beforeNativeSend = vi.fn().mockResolvedValue(undefined);
    const onNativeSendAbandoned = vi.fn().mockResolvedValue(undefined);
    const running = s.adapter.startSession(sessionId, 'Synthetic scenario', {
      clientTurnId,
      dispatchChatSend: dispatch,
      onAccepted: accepted,
      beforeNativeSend,
      onNativeSendAbandoned,
    });
    await vi.waitFor(() => expect(s.internals.unknownSessionRuns.has(sessionId)).toBe(true));

    expect(s.internals.unknownSessionRuns.get(sessionId)?.runId).toBe(clientTurnId);
    expect(accepted).not.toHaveBeenCalled();
    await expect(
      s.adapter.startSession(sessionId, 'Retry', { clientTurnId, dispatchChatSend: dispatch }),
    ).rejects.toThrow('awaiting confirmation');
    expect(dispatch).toHaveBeenCalledOnce();
    expect(beforeNativeSend).toHaveBeenCalledOnce();
    expect(onNativeSendAbandoned).not.toHaveBeenCalled();
    expect(s.request.mock.calls.some(([method]) => method === 'chat.send')).toBe(false);
    await s.finish(running);
  });

  it('treats a known pre-send Renderer rejection as unsubmitted without fallback', async () => {
    const s = setup();
    const dispatch = vi
      .fn<NonNullable<CoworkStartOptions['dispatchChatSend']>>()
      .mockRejectedValue(
        Object.assign(new Error('Initial turn client/session unavailable'), { requestSent: false }),
      );
    const accepted = vi.fn();
    const beforeNativeSend = vi.fn().mockResolvedValue(undefined);
    const onNativeSendAbandoned = vi.fn().mockResolvedValue(undefined);
    await expect(
      s.adapter.startSession(sessionId, 'Synthetic scenario', {
        clientTurnId,
        dispatchChatSend: dispatch,
        onAccepted: accepted,
        beforeNativeSend,
        onNativeSendAbandoned,
      }),
    ).rejects.toThrow('client/session unavailable');

    expect(dispatch).toHaveBeenCalledOnce();
    expect(beforeNativeSend).toHaveBeenCalledOnce();
    expect(onNativeSendAbandoned).toHaveBeenCalledOnce();
    expect(accepted).not.toHaveBeenCalled();
    expect(s.internals.unknownSessionRuns.has(sessionId)).toBe(false);
    expect(s.internals.activeTurns.has(sessionId)).toBe(false);
    expect(s.request.mock.calls.some(([method]) => method === 'chat.send')).toBe(false);
  });

  it('does not delegate an initial input when the Team launch boundary has been revoked', async () => {
    const s = setup();
    const dispatch = vi.fn<NonNullable<CoworkStartOptions['dispatchChatSend']>>();
    const beforeNativeSend = vi.fn().mockRejectedValue(new Error('Team launch was cancelled'));
    const onNativeSendAbandoned = vi.fn().mockResolvedValue(undefined);
    await expect(
      s.adapter.startSession(sessionId, 'Start a team', {
        clientTurnId,
        dispatchChatSend: dispatch,
        beforeNativeSend,
        onNativeSendAbandoned,
      }),
    ).rejects.toThrow('Team launch was cancelled');

    expect(dispatch).not.toHaveBeenCalled();
    expect(onNativeSendAbandoned).toHaveBeenCalledOnce();
    expect(s.internals.unknownSessionRuns.has(sessionId)).toBe(false);
    expect(s.request.mock.calls.some(([method]) => method === 'chat.send')).toBe(false);
  });
});

it('prepares an adopted App incarnation by describe without recreating its native runtime', async () => {
  const s = setup();
  s.request.mockImplementation(async method => {
    if (method !== 'sessions.describe') throw new Error(`Unexpected mutation: ${method}`);
    return { session: { sessionId: gatewaySessionId, sessionRoot: process.cwd(), permissionMode: 'full' } };
  });
  expect(await s.adapter.prepareSession(sessionId, { expectedSessionId: gatewaySessionId })).toEqual({ sessionKey, gatewaySessionId });
  expect(s.request).toHaveBeenCalledExactlyOnceWith('sessions.describe', { key: sessionKey, agentId: 'main' });
});

it('rejects a replaced App incarnation before recreating or sending anything', async () => {
  const s = setup();
  s.request.mockResolvedValue({ session: { sessionId: 'replacement', sessionRoot: process.cwd(), permissionMode: 'full' } });
  await expect(s.adapter.prepareSession(sessionId, { expectedSessionId: gatewaySessionId })).rejects.toThrow('identity changed');
  expect(s.request).toHaveBeenCalledOnce();
});
