import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), getPath: () => os.tmpdir(), getVersion: () => 'test' },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../cowork/coworkLogger', () => ({ coworkLog: vi.fn() }));

import { CoworkStore } from '../../data/coworkStore';
import { SqliteStore } from '../../data/sqliteStore';
import { SessionPermissionModeCoordinator } from '../../openclaw/permissions/sessionPermissionModeCoordinator';
import type { GatewayClientLike } from '../gateway/types';
import { OpenClawRuntimeAdapter } from './openclawRuntimeAdapter';

function createHarness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-dispatch-'));
  const database = SqliteStore.create(directory);
  const store = new CoworkStore(database.getDatabase());
  const session = store.createSession('Recover goal dispatch', process.cwd());
  const key = `agent:main:justdo:${session.id}`;
  const identity = { sessionKey: key, sessionId: 'native-1', runId: 'parent-run', lifecycleGeneration: 'generation-1' };
  const goal = { schemaVersion: 1, id: 'goal-1', objective: 'Finish the task', status: 'active',
    createdAt: 1, updatedAt: 1, tokenStart: 0, tokensUsed: 0, continuationTurns: 0 };
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'sessions.describe') return {
      session: { key, sessionId: identity.sessionId, lifecycleRevision: 'revision-1', goal },
    };
    if (method === 'agent') {
      goal.continuationTurns += 1;
      return { runId: params!.idempotencyKey, status: 'accepted', goalContinuation: {
        goalId: goal.id, predecessorRunId: identity.runId,
        continuationTurns: goal.continuationTurns, acceptedAt: Date.now(),
      } };
    }
    throw new Error(`Unexpected method ${method}`);
  });
  adapter.gatewayClient = { request } as unknown as GatewayClientLike;
  const permissions = new SessionPermissionModeCoordinator({
    getCoworkStore: () => store,
    isSessionActive: sessionId => adapter.isSessionActive(sessionId),
    prepareSession: async () => {},
  });
  adapter.setContinuationPermissionPreparer(async sessionId => {
    const result = await permissions.prepareSessionForRun(sessionId);
    if (!result.success) throw new Error(result.error);
  });
  adapter.rememberSessionKey(session.id, key);
  store.beginSessionRun({ sessionId: session.id, clientTurnId: identity.runId, startedAt: Date.now() });
  const startAndSettle = () => {
    adapter.ensureActiveTurn(session.id, key, identity.runId);
    adapter.handleAgentEvent('agent', { ...identity, seq: 1, stream: 'lifecycle', data: { phase: 'start' } });
    adapter.handleAgentEvent('agent', { ...identity, seq: 2, stream: 'lifecycle', data: { phase: 'end', executionSettled: true } });
  };
  return { store, session, adapter, request, identity, startAndSettle, agentCalls: () => request.mock.calls.filter(([method]) => method === 'agent'),
    close() {
      adapter.goalContinuationCoordinator.clear();
      adapter.cancelGoalRecovery();
      adapter.cleanupSessionTurn(session.id);
      database.close();
      const resolved = path.resolve(directory);
      if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('goal-dispatch-')) {
        throw new Error('Unexpected goal dispatch test directory');
      }
      fs.rmSync(resolved, { recursive: true, force: true });
    },
  };
}

test.each(['before-record', 'after-record', 'cleanup-failure'] as const)(
  'automatically recovers one unsent Goal registration failure (%s)', async stage => {
    vi.useFakeTimers();
    const h = createHarness();
    const begin = h.store.beginSessionRun.bind(h.store);
    const candidateStarts = vi.spyOn(h.store, 'beginSessionRun').mockImplementationOnce(input => {
      if (stage !== 'before-record') begin(input);
      throw new Error('One transient registration failure');
    });
    const finish = h.store.finishSessionRun.bind(h.store);
    let cleanupFailed = false;
    const finishCalls = vi.spyOn(h.store, 'finishSessionRun').mockImplementation((id, state, endedAt) => {
      if (stage === 'cleanup-failure' && !cleanupFailed && state === 'failed') {
        cleanupFailed = true;
        throw new Error('One transient cleanup failure');
      }
      return finish(id, state, endedAt);
    });
    try {
      h.startAndSettle();
      await vi.advanceTimersByTimeAsync(1_600);
      const rejectedId = candidateStarts.mock.calls[0][0].clientTurnId;
      expect(h.agentCalls()).toHaveLength(0);
      expect(h.adapter.isSessionActive(h.session.id)).toBe(false);
      expect(h.adapter.unknownSessionRuns.has(h.session.id)).toBe(false);
      expect(h.adapter.goalContinuationCoordinator.getSnapshot(h.session.id)?.phase).toBe('retrying');

      await vi.advanceTimersByTimeAsync(2_000);
      expect(h.agentCalls()).toHaveLength(1);
      const acceptedId = h.agentCalls()[0][1]!.idempotencyKey as string;
      expect(acceptedId).not.toBe(rejectedId);
      expect(h.agentCalls()[0][1]).toMatchObject({ goalContinuation: { predecessorRunId: h.identity.runId } });
      expect(h.store.getSessionRunByClientTurnId(h.identity.runId)?.state).toBe('completed');
      if (stage !== 'before-record') expect(h.store.getSessionRunByClientTurnId(rejectedId)?.state).toBe('failed');
      expect(h.store.getActiveSessionRun(h.session.id)).toMatchObject({
        clientTurnId: acceptedId, rootRunId: acceptedId, acceptedAt: expect.any(Number),
      });
      expect(h.adapter.getRunTerminalReceipt(rejectedId)).toBeNull();
      expect(h.request.mock.calls.filter(([method]) => method === 'agent.wait')).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
      expect(h.agentCalls()).toHaveLength(1);
    } finally {
      candidateStarts.mockRestore();
      finishCalls.mockRestore();
      h.close();
      vi.useRealTimers();
    }
  },
);

test('closes only a definitively rejected Goal candidate receipt', async () => {
  vi.useFakeTimers();
  const h = createHarness();
  const normal = h.request.getMockImplementation()!;
  h.request.mockImplementation(async (method, params) => {
    if (method === 'agent') throw Object.assign(new Error('Admission deferred'), {
      gatewayCode: 'INVALID_REQUEST', details: { code: 'GOAL_CONTINUATION_DEFERRED', reason: 'native-handoff' },
    });
    return normal(method, params);
  });
  try {
    const other = h.store.createSession('Other conversation', process.cwd());
    const unrelated = h.store.beginSessionRun({ sessionId: other.id, clientTurnId: 'unrelated-run', startedAt: Date.now() });
    h.startAndSettle();
    await vi.advanceTimersByTimeAsync(1_600);
    const rejectedId = h.agentCalls()[0][1]!.idempotencyKey as string;
    expect(h.store.getSessionRunByClientTurnId(rejectedId)?.state).toBe('failed');
    expect(h.store.getSessionRun(unrelated.id)?.state).toBe('running');
    expect(h.adapter.isSessionActive(h.session.id)).toBe(false);
    expect(h.adapter.unknownSessionRuns.has(h.session.id)).toBe(false);
    expect(h.adapter.getRunTerminalReceipt(rejectedId)).toBeNull();
  } finally {
    h.close();
    vi.useRealTimers();
  }
});

test('preserves a sent Goal candidate and its receipt when the ACK is lost', async () => {
  vi.useFakeTimers();
  const h = createHarness();
  const normal = h.request.getMockImplementation()!;
  h.request.mockImplementation(async (method, params) => {
    if (method === 'agent') throw Object.assign(new Error('ACK lost'), { requestSent: true });
    if (method === 'agent.wait') return { runId: params!.runId, status: 'timeout' };
    return normal(method, params);
  });
  try {
    h.startAndSettle();
    await vi.advanceTimersByTimeAsync(1_600);
    const uncertainId = h.agentCalls()[0][1]!.idempotencyKey as string;
    expect(h.adapter.unknownSessionRuns.get(h.session.id)?.runId).toBe(uncertainId);
    const receipt = h.store.getActiveSessionRun(h.session.id);
    expect(receipt?.clientTurnId).toBe(uncertainId);
    expect(receipt?.acceptedAt).toBeUndefined();
    expect(h.adapter.goalContinuationCoordinator.getSnapshot(h.session.id)).toMatchObject({
      phase: 'running', identityPending: true, runId: uncertainId,
    });
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
    expect(h.agentCalls()).toHaveLength(1);
    expect(h.store.getSessionRunByClientTurnId(uncertainId)?.state).toBe('running');
  } finally {
    h.close();
    vi.useRealTimers();
  }
});
