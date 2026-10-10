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
import type { CoworkStore } from '../../data/coworkStore';
import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';
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
  ensureGatewayClientReady: () => Promise<void>;
  activeTurns: Map<string, SessionTurn>;
  unknownSessionRuns: Map<string, { runId: string; cancelled: boolean }>;
  resolveTurn: (id: string) => void;
  cleanupSessionTurn: (id: string) => void;
};

const cleanup = new Set<() => void>();
afterEach(() => {
  for (const dispose of cleanup) dispose();
  cleanup.clear();
});

function setup(sendReceipt?: Record<string, unknown>) {
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
    if (method === 'sessions.create') {
      return {
        key: sessionKey,
        sessionId: gatewaySessionId,
        entry: { sessionId: gatewaySessionId, sessionRoot: process.cwd(), permissionMode: 'full' },
      };
    }
    if (method === 'chat.send') return sendReceipt ?? { runId: params?.idempotencyKey, status: 'started' };
    throw new Error(`Unexpected Main RPC: ${method}`);
  });
  const adapter = new OpenClawRuntimeAdapter(
    store as unknown as CoworkStore,
    {} as OpenClawEngineManager,
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
  return { adapter, internals, request, updateSession, bindSessionRunRootRun, finishSessionRun, finish };
}

describe('Main initial turn delegated to the presenting Renderer', () => {
  it.each(['/stop', '停止！', 'please stop'])('settles the native non-executing control receipt for %s', async message => {
    const s = setup();
    const receipt = { ok: true, aborted: false, runIds: [] };
    const dispatch = vi.fn<NonNullable<CoworkStartOptions['dispatchChatSend']>>().mockResolvedValue(receipt);
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
    expect(s.finishSessionRun).toHaveBeenCalledExactlyOnceWith('timing-initial', 'aborted', expect.any(Number));
    expect(s.internals.activeTurns.has(sessionId)).toBe(false);
    expect(s.internals.unknownSessionRuns.has(sessionId)).toBe(false);
    expect(s.request.mock.calls.some(([method]) => method === 'chat.send')).toBe(false);
  });

  it('settles an explicit background control acknowledgement including its native warning', async () => {
    const s = setup({ ok: true, aborted: true, runIds: ['native-existing-run'], warning: 'Synthetic save warning.' });
    const accepted = vi.fn();
    await s.adapter.startSession(sessionId, '/stop', { clientTurnId, onAccepted: accepted });

    expect(s.request.mock.calls.map(([method]) => method)).toEqual(['sessions.create', 'chat.send']);
    expect(accepted).toHaveBeenCalledOnce();
    expect(s.internals.activeTurns.has(sessionId)).toBe(false);
    expect(s.internals.unknownSessionRuns.has(sessionId)).toBe(false);
    expect(s.bindSessionRunRootRun).not.toHaveBeenCalled();
  });

  it('does not accept a stop control acknowledgement as structured Goal admission', async () => {
    const s = setup();
    const dispatch = vi.fn<NonNullable<CoworkStartOptions['dispatchChatSend']>>().mockResolvedValue({ ok: true, aborted: false, runIds: [] });
    const accepted = vi.fn();
    await expect(s.adapter.startSession(sessionId, '/goal Synthetic goal', {
      clientTurnId, dispatchChatSend: dispatch, onAccepted: accepted,
    })).rejects.toThrow('mismatched Goal start receipt');

    expect(accepted).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(s.internals.activeTurns.has(sessionId)).toBe(false);
    expect(s.internals.unknownSessionRuns.has(sessionId)).toBe(false);
  });

  it('prepares the native session in Main and delegates the identical single chat admission', async () => {
    const s = setup();
    const dispatch = vi.fn<NonNullable<CoworkStartOptions['dispatchChatSend']>>().mockResolvedValue({
      runId: clientTurnId,
      status: 'started',
    });
    const accepted = vi.fn();
    const running = s.adapter.startSession(sessionId, '  Explore this scenario  ', {
      clientTurnId,
      onAccepted: accepted,
      dispatchChatSend: dispatch,
      untrustedContext: '  Synthetic private context  ',
      attachments: [{ name: 'input.png', mimeType: 'image/png', base64Data: 'aGVsbG8=' }],
    });

    await vi.waitFor(() => expect(s.bindSessionRunRootRun).toHaveBeenCalled());

    expect(s.request).toHaveBeenCalledExactlyOnceWith('sessions.create', {
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
        attachments: [{ type: 'image', fileName: 'input.png', mimeType: 'image/png', content: 'aGVsbG8=' }],
      },
      { sessionKey, gatewaySessionId },
    );
    expect(accepted).toHaveBeenCalledOnce();
    expect(s.bindSessionRunRootRun).toHaveBeenCalledExactlyOnceWith('timing-initial', clientTurnId);
    expect(s.internals.activeTurns.get(sessionId)?.runId).toBe(clientTurnId);
    await s.finish(running);
  });

  it('keeps background admission on the existing Main client without UI capability fields', async () => {
    const s = setup();
    const running = s.adapter.startSession(sessionId, 'Synthetic background task', { clientTurnId });
    await vi.waitFor(() => expect(s.bindSessionRunRootRun).toHaveBeenCalled());

    expect(s.request.mock.calls.map(([method]) => method)).toEqual(['sessions.create', 'chat.send']);
    const params = s.request.mock.calls.find(([method]) => method === 'chat.send')?.[1];
    expect(params).toMatchObject({ sessionKey, idempotencyKey: clientTurnId });
    expect(params).not.toHaveProperty('caps');
    expect(params).not.toHaveProperty('clientCaps');
    expect(params).not.toHaveProperty('originatingClientCaps');
    await s.finish(running);
  });

  it.each(['/goal status', '/goal pause'])('preserves native slash session identity for %s', async command => {
    const s = setup();
    const dispatch = vi.fn<NonNullable<CoworkStartOptions['dispatchChatSend']>>().mockResolvedValue({ runId: clientTurnId });
    const running = s.adapter.startSession(sessionId, command, { clientTurnId, dispatchChatSend: dispatch });
    await vi.waitFor(() => expect(s.bindSessionRunRootRun).toHaveBeenCalled());

    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      { sessionKey, sessionId: gatewaySessionId, message: command, deliver: false, justdoUserInitiated: true, timeoutMs: 0, idempotencyKey: clientTurnId },
      { sessionKey, gatewaySessionId },
    );
    expect(s.request.mock.calls.some(([method]) => method === 'chat.send')).toBe(false);
    await s.finish(running);
  });

  it('delegates structured Goal admission with its durable issued time and no transient timeout', async () => {
    const s = setup();
    const dispatch = vi.fn<NonNullable<CoworkStartOptions['dispatchChatSend']>>().mockResolvedValue({
      operationId: clientTurnId, action: 'start', sessionId: gatewaySessionId,
      runId: clientTurnId, goalId: 'fixture-goal', status: 'started',
    });
    const accepted = vi.fn();
    const running = s.adapter.startSession(sessionId, '/goal start  Ship the synthetic release  ', {
      clientTurnId, dispatchChatSend: dispatch, onAccepted: accepted,
    });
    await vi.waitFor(() => expect(s.bindSessionRunRootRun).toHaveBeenCalled());

    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      { sessionKey, sessionId: gatewaySessionId, message: 'Ship the synthetic release', intent: { kind: 'session-goal-start', version: 1, issuedAtMs: startedAt }, deliver: false, justdoUserInitiated: true, idempotencyKey: clientTurnId },
      { sessionKey, gatewaySessionId },
    );
    expect(accepted).toHaveBeenCalledOnce();
    expect(s.request.mock.calls.some(([method]) => method === 'chat.send')).toBe(false);
    await s.finish(running);
  });

  it('rejects a mismatched Goal receipt before publishing Main admission', async () => {
    const s = setup();
    const dispatch = vi.fn<NonNullable<CoworkStartOptions['dispatchChatSend']>>().mockResolvedValue({
      operationId: clientTurnId, action: 'start', sessionId: 'wrong-native-session',
      runId: clientTurnId, goalId: 'fixture-goal', status: 'started',
    });
    const accepted = vi.fn();
    await expect(s.adapter.startSession(sessionId, '/goal Synthetic goal', {
      clientTurnId, dispatchChatSend: dispatch, onAccepted: accepted,
    })).rejects.toThrow('mismatched Goal start receipt');

    expect(dispatch).toHaveBeenCalledOnce();
    expect(accepted).not.toHaveBeenCalled();
    expect(s.request.mock.calls.some(([method]) => method === 'chat.send')).toBe(false);
    expect(s.internals.activeTurns.has(sessionId)).toBe(false);
  });

  it('keeps an uncertain Renderer admission fenced and never retries it through Main', async () => {
    const s = setup();
    const dispatch = vi.fn<NonNullable<CoworkStartOptions['dispatchChatSend']>>().mockRejectedValue(
      Object.assign(new Error('connection lost while dispatching initial chat turn'), { code: 'CLIENT_TIMEOUT', requestSent: true }),
    );
    const accepted = vi.fn();
    const running = s.adapter.startSession(sessionId, 'Synthetic scenario', {
      clientTurnId, dispatchChatSend: dispatch, onAccepted: accepted,
    });
    await vi.waitFor(() => expect(s.internals.unknownSessionRuns.has(sessionId)).toBe(true));

    expect(s.internals.unknownSessionRuns.get(sessionId)?.runId).toBe(clientTurnId);
    expect(accepted).not.toHaveBeenCalled();
    await expect(s.adapter.startSession(sessionId, 'Retry', { clientTurnId, dispatchChatSend: dispatch })).rejects.toThrow('awaiting confirmation');
    expect(dispatch).toHaveBeenCalledOnce();
    expect(s.request.mock.calls.some(([method]) => method === 'chat.send')).toBe(false);
    await s.finish(running);
  });

  it('treats a known pre-send Renderer rejection as unsubmitted without fallback', async () => {
    const s = setup();
    const dispatch = vi.fn<NonNullable<CoworkStartOptions['dispatchChatSend']>>().mockRejectedValue(
      Object.assign(new Error('Initial turn client/session unavailable'), { requestSent: false }),
    );
    const accepted = vi.fn();
    await expect(s.adapter.startSession(sessionId, 'Synthetic scenario', {
      clientTurnId, dispatchChatSend: dispatch, onAccepted: accepted,
    })).rejects.toThrow('client/session unavailable');

    expect(dispatch).toHaveBeenCalledOnce();
    expect(accepted).not.toHaveBeenCalled();
    expect(s.internals.unknownSessionRuns.has(sessionId)).toBe(false);
    expect(s.internals.activeTurns.has(sessionId)).toBe(false);
    expect(s.request.mock.calls.some(([method]) => method === 'chat.send')).toBe(false);
  });
});
