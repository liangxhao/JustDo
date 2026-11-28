import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd(), getPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: () => [] } }));

import { AutomaticErrorRetryPhase } from '../../../shared/cowork/automaticErrorRetry';
import { CoworkSessionSource } from '../../../shared/cowork/sessionSource';
import type { GatewayClientLike, NativeRunTerminalReceipt, SessionTurn } from '../gateway/types';
import { AutomaticErrorRetryCoordinator } from './automaticErrorRetry/coordinator';
import { AutomaticErrorRetryLifecycle } from './automaticErrorRetry/lifecycle';
import { REPEATED_TOOL_ERROR_CODE } from './automaticErrorRetry/rules';
import { OpenClawRuntimeAdapter } from './openclawRuntimeAdapter';

const source = { sessionId: 'app', sessionKey: 'agent:main:justdo:app', nativeSessionId: 'native',
  lifecycleRevision: 'revision', clientGeneration: 7, clientTurnId: 'input', runId: 'source-run', maxContinuations: 2 };
const rootReceipt: NativeRunTerminalReceipt = { runId: source.runId, sessionKey: source.sessionKey,
  sessionId: source.nativeSessionId, clientGeneration: 7, lifecycleGeneration: 'generation',
  executionSettled: true, status: 'failed', agentSeq: 1, endedAt: 1 };
const successfulWait = { status: 'ok', endedAt: 2 };
const yieldedWait = { ...successfulWait, yielded: true, livenessState: 'paused', stopReason: 'end_turn' };

async function fixture(
  result: Record<string, unknown>,
  sessionSource?: CoworkSessionSource,
  retry: 'successor' | 'root' | 'disabled' = 'successor',
) {
  let sequence = 0;
  const launch = vi.fn(async () => ({ status: 'unknown' as const }));
  const release = vi.fn();
  const reconcile = vi.fn(async () => {});
  const coordinator = new AutomaticErrorRetryCoordinator({
    retryDelayMs: 0,
    isCurrent: () => true, readFailureCode: async () => REPEATED_TOOL_ERROR_CODE,
    reserveSuccessor: () => true, releaseSuccessor: release, launchSuccessor: launch,
    onChanged() {}, onUnclaimedSettled() {}, createRunId: () => `technical-${++sequence}`,
  });
  const runId = retry === 'root' ? source.runId : retry === 'disabled' ? 'user-run' : 'technical-1';
  const turn: SessionTurn = {
    sessionId: 'app', sessionKey: source.sessionKey, runId, gatewaySessionId: 'native',
    lifecycleGeneration: 'generation', lastAgentSeq: 2, status: 'running', turnToken: 1,
    stopRequested: false, knownRunIds: new Set([runId]),
  };
  const request = vi.fn(async (method: string): Promise<Record<string, unknown>> => method === 'agent.wait'
    ? { runId, ...result }
    : { session: { key: source.sessionKey, sessionId: 'native', lifecycleRevision: 'revision', lastRunId: runId } });
  const activeTurns = new Map([['app', turn]]);
  const unknownSessionRuns = new Map<string, { runId: string; cancelled: boolean }>();
  const displayFinal = vi.fn(() => { activeTurns.delete('app'); });
  const client = { request } as unknown as GatewayClientLike;
  // Exercise the production recovery method with only its transport/owner boundaries substituted.
  const retiredRunBindings = new Map([[runId, { ...turn, clientGeneration: 7 }]]);
  const adapter = Object.assign(Object.create(OpenClawRuntimeAdapter.prototype), {
    gatewayClient: client, gatewayClientGeneration: 7, activeTurns, pendingTurnStarts: new Map(),
    disconnectedSessionIds: new Set(['app']), unknownSessionRuns, disconnectedRecoveryPromises: new Map(),
    retiredRunBindings,
    runTerminalReceipts: new Map(), stoppedSessions: new Set(),
    store: { getSession: () => ({ id: source.sessionId, source: sessionSource }) },
    automaticErrorRetryHost: { coordinator },
    goalContinuationCoordinator: { reconcileSettledRun: reconcile },
    confirmUnknownSessionRunAdmission: vi.fn(), handleChatEvent: displayFinal,
    cleanupSessionTurn: () => { activeTurns.delete('app'); }, resolveTurn: vi.fn(),
    scheduleGoalRecovery: vi.fn(),
  }) as {
    gatewayClientGeneration: number;
    disconnectedSessionIds: Set<string>;
    performDisconnectedTurnRecovery(sessionId: string, observedFinalRunId?: string): Promise<void>;
    reconcileDisconnectedTurn(sessionId: string): Promise<void>;
    isSessionActive(sessionId: string): boolean;
    registerUnknownSessionRun(sessionId: string, runId: string, options: { onConfirmed: () => void }): void;
    verifyRetryChatFailure(sessionId: string, event: { runId: string; sessionKey: string; errorMessage: string }): Promise<void>;
  };
  Object.assign(adapter, { automaticErrorRetryLifecycle: new AutomaticErrorRetryLifecycle({
    coordinator, resolveSessionId: () => 'app',
    isConnectionCurrent: connection => connection.client === client && connection.generation === adapter.gatewayClientGeneration,
    handleGoalLifecycle() {}, reconcileGoalTerminal: reconcile, emitError() {},
  }) });
  if (retry !== 'disabled') coordinator.arm(source);
  if (retry === 'successor') {
    coordinator.observeSettled(rootReceipt);
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
  }
  return { adapter, request, coordinator, release, launch, reconcile, displayFinal, turn, activeTurns, unknownSessionRuns, retiredRunBindings };
}

describe('exact agent.wait recovery through automatic error retry', () => {
  it.each([
    "Your request couldn't be completed: Context overflow: prompt too large for the model. Try /reset (or /new) to start a fresh session, or use a larger-context model.",
    'Auto-compaction failed before the next model request. Try again or run /compact. Completed tool actions were not replayed; verify their effects before retrying.',
  ])('uses the fixed native context failure only to read the exact terminal (%s)', async errorMessage => {
    const f = await fixture({}, undefined, 'root');
    f.request
      .mockResolvedValueOnce({ runId: source.runId, status: 'error', pendingError: true })
      .mockResolvedValueOnce({ runId: source.runId, status: 'error', endedAt: 2 })
      .mockResolvedValueOnce({ session: { key: source.sessionKey, sessionId: source.nativeSessionId,
        lifecycleRevision: source.lifecycleRevision, lastRunId: source.clientTurnId } });

    await f.adapter.verifyRetryChatFailure('app', {
      runId: source.runId,
      sessionKey: source.sessionKey,
      errorMessage,
    });

    expect(f.request.mock.calls.map(([method]) => method)).toEqual(['agent.wait', 'agent.wait', 'sessions.describe']);
    expect(f.coordinator.getSettledReceipt(source.runId)).toMatchObject({ source: 'agent.wait', endedAt: 2 });
  });

  it('looks again after chat final retires a turn whose first wait was only provisional', async () => {
    const f = await fixture(successfulWait);
    f.request.mockImplementationOnce(async () => {
      f.activeTurns.delete('app');
      return { runId: 'technical-1', status: 'error', pendingError: true };
    });

    await f.adapter.performDisconnectedTurnRecovery('app', 'technical-1');

    expect(f.request.mock.calls.map(([method]) => method)).toEqual(['agent.wait', 'agent.wait', 'sessions.describe']);
    expect(f.coordinator.getSettledReceipt('technical-1')).toMatchObject({ status: 'completed' });
    expect(f.launch).toHaveBeenCalledOnce();
  });

  it.each([false, true])('reconciles an accepted transport final on a connected session (chat final already delivered=%s)', async retired => {
    const f = await fixture({ ...successfulWait, stopReason: 'stop' });
    f.adapter.disconnectedSessionIds.clear();
    if (retired) f.activeTurns.delete('app');
    await f.adapter.performDisconnectedTurnRecovery('app', 'other-run');
    expect(f.request).not.toHaveBeenCalled();

    await f.adapter.performDisconnectedTurnRecovery('app', 'technical-1');

    expect(f.coordinator.getPresentation('app')?.phase).toBe(AutomaticErrorRetryPhase.Completed);
    expect(f.reconcile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      runId: 'technical-1', phase: 'end', executionSettled: true,
    }));
    if (retired) expect(f.displayFinal).not.toHaveBeenCalled();
  });

  it.each([
    { stage: 'agent.wait', connectionChanged: false },
    { stage: 'sessions.describe', connectionChanged: false },
    { stage: 'sessions.describe', connectionChanged: true },
  ])('checks the same retired run when chat final arrives during $stage (connection changed=$connectionChanged)', async ({ stage, connectionChanged }) => {
    const f = await fixture(successfulWait);
    f.adapter.disconnectedSessionIds.clear();
    const originalRequest = f.request.getMockImplementation()!;
    f.request.mockImplementation(async method => {
      if (method === stage && f.activeTurns.has('app')) {
        f.activeTurns.delete('app');
        if (connectionChanged) f.adapter.gatewayClientGeneration++;
      }
      return originalRequest(method);
    });

    await f.adapter.performDisconnectedTurnRecovery('app', 'technical-1');

    expect(f.launch).toHaveBeenCalledOnce();
    expect(f.displayFinal).not.toHaveBeenCalled();
    if (connectionChanged) {
      expect(f.reconcile).not.toHaveBeenCalled();
      expect(f.coordinator.getSettledReceipt('technical-1')).toBeNull();
    } else {
      expect(f.reconcile).toHaveBeenCalledOnce();
      expect(f.coordinator.getSettledReceipt('technical-1')).toMatchObject({ status: 'completed' });
    }
  });

  it('keeps the retirement race fenced after checking native identity', async () => {
    const f = await fixture(successfulWait);
    const originalRequest = f.request.getMockImplementation()!;
    f.request.mockImplementation(async method => {
      const result = await originalRequest(method);
      if (method !== 'sessions.describe' || !f.activeTurns.has('app')) return result;
      return { session: {
        ...result.session as Record<string, unknown>,
        get lifecycleRevision() {
          queueMicrotask(() => { f.activeTurns.delete('app'); });
          return source.lifecycleRevision;
        },
      } };
    });

    await f.adapter.performDisconnectedTurnRecovery('app', 'technical-1');

    expect(f.coordinator.getSettledReceipt('technical-1')).toMatchObject({ status: 'completed' });
    expect(f.displayFinal).not.toHaveBeenCalled();
    expect(f.reconcile).toHaveBeenCalledOnce();
  });

  it.each([undefined, CoworkSessionSource.ChromeExtension])('forwards retired paused yield without completing grouped logical turns (source %s)', async sessionSource => {
    const f = await fixture({ ...yieldedWait, stopReason: undefined }, sessionSource);
    f.activeTurns.delete('app');

    await f.adapter.performDisconnectedTurnRecovery('app', 'technical-1');

    expect(f.reconcile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      runId: 'technical-1', phase: 'end', executionSettled: true, yielded: true, livenessState: 'paused', stopReason: 'end_turn',
    }));
    expect(f.coordinator.getSettledReceipt('technical-1')?.status).toBe(sessionSource ? undefined : 'completed');
    expect(f.release).toHaveBeenCalledTimes(sessionSource ? 0 : 1);
    expect(f.launch).toHaveBeenCalledOnce();
    expect(f.displayFinal).not.toHaveBeenCalled();
  });

  it('keeps the retired claim when the wait yield conflicts with the paused outcome', async () => {
    const f = await fixture({ ...yieldedWait, stopReason: 'timeout' });
    f.activeTurns.delete('app');

    await f.adapter.performDisconnectedTurnRecovery('app', 'technical-1');

    expect(f.coordinator.getSettledReceipt('technical-1')).toBeNull();
    expect(f.reconcile).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
    expect(f.launch).toHaveBeenCalledOnce();
  });

  it('keeps cancelled unknown ownership when an exact retired execution only yielded', async () => {
    const f = await fixture(yieldedWait);
    f.activeTurns.delete('app');
    f.unknownSessionRuns.set('app', { runId: 'technical-1', cancelled: true });

    await f.adapter.performDisconnectedTurnRecovery('app');

    expect(f.unknownSessionRuns.get('app')).toEqual({ runId: 'technical-1', cancelled: true });
    expect(f.coordinator.getSettledReceipt('technical-1')).toBeNull();
    expect(f.reconcile).not.toHaveBeenCalled();
    expect(f.launch).toHaveBeenCalledOnce();
  });

  it.each([false, true])('keeps a display-retired lost ACK unknown until an exact native receipt (settled=%s)', async settled => {
    const f = await fixture({ ...successfulWait, pendingError: !settled });
    f.activeTurns.delete('app');
    f.adapter.disconnectedSessionIds.clear();
    const onConfirmed = vi.fn();

    f.adapter.registerUnknownSessionRun('app', 'technical-1', { onConfirmed });
    expect(onConfirmed).not.toHaveBeenCalled();
    expect(f.unknownSessionRuns.get('app')?.runId).toBe('technical-1');
    expect(f.adapter.isSessionActive('app')).toBe(true);
    await f.adapter.reconcileDisconnectedTurn('app');

    expect(f.unknownSessionRuns.get('app')?.runId).toBe(settled ? undefined : 'technical-1');
    expect(f.adapter.isSessionActive('app')).toBe(!settled);
    expect(onConfirmed).toHaveBeenCalledTimes(settled ? 1 : 0);
    expect(f.coordinator.getSettledReceipt('technical-1')?.status).toBe(settled ? 'completed' : undefined);
    expect(f.activeTurns.has('app')).toBe(false);
    expect(f.displayFinal).not.toHaveBeenCalled();
    expect(f.launch).toHaveBeenCalledOnce();
  });

  it.each(['revision', 'replacement', 'matching', 'expired', 'expires-during-wait'])(
    'checks a display-retired ordinary send independently of the retry candidate (%s)',
    async identity => {
      const f = await fixture(successfulWait, undefined, 'disabled');
      const { runId } = f.turn;
      if (identity === 'expired' || identity === 'expires-during-wait') {
        f.coordinator.arm({ ...source, runId, clientTurnId: runId });
      }
      if (identity === 'expired') {
        f.coordinator.expireUnsettledCandidate('app', runId);
        expect(f.coordinator.getPresentation('app')?.phase).toBe(AutomaticErrorRetryPhase.Failed);
      }
      const preparedIdentity = { lifecycleRevision: source.lifecycleRevision, clientGeneration: 7 };
      const original = { ...f.retiredRunBindings.get(runId)!, preparedIdentity };
      f.retiredRunBindings.set(runId, original);
      f.activeTurns.delete('app');
      f.adapter.disconnectedSessionIds.clear();
      const onConfirmed = vi.fn();
      f.request.mockImplementationOnce(async method => {
        expect(method).toBe('agent.wait');
        if (identity === 'expires-during-wait') f.coordinator.expireUnsettledCandidate('app', runId);
        f.retiredRunBindings.set(runId, { ...original, lastAgentSeq: original.lastAgentSeq + 1 });
        return { runId, ...successfulWait };
      }).mockResolvedValueOnce({ session: { key: source.sessionKey, sessionId: source.nativeSessionId,
        lifecycleRevision: identity === 'revision' ? 'new-revision' : source.lifecycleRevision,
        lastRunId: identity === 'replacement' ? 'new-run' : runId,
      } });

      f.adapter.registerUnknownSessionRun('app', runId, { onConfirmed });
      expect(f.adapter.isSessionActive('app')).toBe(true);
      expect(onConfirmed).not.toHaveBeenCalled();
      await f.adapter.reconcileDisconnectedTurn('app');

      const confirmed = identity !== 'revision' && identity !== 'replacement';
      expect(f.request.mock.calls.map(([method]) => method)).toEqual(['agent.wait', 'sessions.describe']);
      expect(f.adapter.isSessionActive('app')).toBe(!confirmed);
      expect(onConfirmed).toHaveBeenCalledTimes(confirmed ? 1 : 0);
      expect(f.reconcile).toHaveBeenCalledTimes(confirmed ? 1 : 0);
      expect(f.activeTurns.has('app')).toBe(false);
      expect(f.displayFinal).not.toHaveBeenCalled();
      expect(f.launch).not.toHaveBeenCalled();
    },
  );

  it('offers an exact failed unknown successor to generic policy before Goal can dispatch', async () => {
    const f = await fixture({ status: 'error', error: 'tool error', endedAt: 2 });
    await f.adapter.performDisconnectedTurnRecovery('app');
    await vi.waitFor(() => expect(f.launch).toHaveBeenCalledTimes(2));
    expect(f.reconcile).not.toHaveBeenCalled();
    expect(f.coordinator.holdsTerminal('technical-1')).toBe(true);
    expect(f.coordinator.getPresentation('app')?.attempt).toBe(2);
  });

  it('keeps the original identity when agent.wait reports a provisional error', async () => {
    const f = await fixture({ status: 'error', error: 'tool error', endedAt: 2, pendingError: true });
    await f.adapter.performDisconnectedTurnRecovery('app');
    expect(f.coordinator.getPresentation('app')?.phase).toBe(AutomaticErrorRetryPhase.Unknown);
    expect(f.launch).toHaveBeenCalledOnce();
    expect(f.displayFinal).not.toHaveBeenCalled();
  });

  it('preserves a settled native timeout on the wait receipt even without a stop reason', async () => {
    const f = await fixture({ status: 'timeout', error: 'tool error', endedAt: 2 });
    await f.adapter.performDisconnectedTurnRecovery('app');
    expect(f.coordinator.getSettledReceipt('technical-1')).toMatchObject({ stopReason: 'timeout' });
  });

  it('clears Unknown on exact success with the native end time', async () => {
    const f = await fixture(successfulWait);
    await f.adapter.performDisconnectedTurnRecovery('app');
    expect(f.coordinator.getPresentation('app')?.phase).toBe(AutomaticErrorRetryPhase.Completed);
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.launch).toHaveBeenCalledOnce();
    expect(f.reconcile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ runId: 'technical-1',
      phase: 'end', executionSettled: true }));
    const receipt = f.coordinator.getSettledReceipt('technical-1');
    expect(receipt).toMatchObject({ source: 'agent.wait', status: 'completed', endedAt: successfulWait.endedAt });
    expect(receipt).not.toHaveProperty('agentSeq');
  });

  it.each([
    { label: 'on the same connection', generation: 7, wait: yieldedWait },
    { label: 'after reconnecting', generation: 8, wait: yieldedWait },
    { label: 'after chat delivery omits the stop reason', generation: 7, wait: { ...yieldedWait, stopReason: undefined } },
  ])('releases the yielded retry run while preserving descendants $label', async ({ generation, wait }) => {
    const f = await fixture(wait);
    if (generation !== source.clientGeneration) {
      f.coordinator.clear();
      f.adapter.gatewayClientGeneration = generation;
    }
    await f.adapter.performDisconnectedTurnRecovery('app');
    expect(f.coordinator.getPresentation('app')?.phase).toBe(AutomaticErrorRetryPhase.Completed);
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.launch).toHaveBeenCalledOnce();
    expect(f.coordinator.getTurn('app', source.clientTurnId)?.outstandingLaunch).toBe(false);
    expect(f.reconcile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ runId: 'technical-1',
      executionSettled: true, yielded: true, livenessState: 'paused', stopReason: 'end_turn' }));
    expect(f.displayFinal).not.toHaveBeenCalled();
    expect(f.request.mock.calls.map(([method]) => method)).toEqual(['agent.wait', 'sessions.describe']);
  });

  it.each([
    { label: 'success without an end time', wait: { status: 'ok' } },
    { label: 'yield without an end time', wait: { ...yieldedWait, endedAt: undefined } },
    { label: 'yield with a conflicting stop reason', wait: { ...yieldedWait, stopReason: 'timeout' } },
  ])('retains the active retry for $label', async ({ wait }) => {
    const f = await fixture(wait);
    await f.adapter.performDisconnectedTurnRecovery('app');
    expect(f.activeTurns.get('app')).toBe(f.turn);
    expect(f.coordinator.getPresentation('app')?.phase).toBe(AutomaticErrorRetryPhase.Unknown);
    expect(f.release).not.toHaveBeenCalled();
    expect(f.launch).toHaveBeenCalledOnce();
    expect(f.reconcile).not.toHaveBeenCalled();
    expect(f.displayFinal).not.toHaveBeenCalled();
  });

  it('keeps the browser logical turn open on a yielded execution', async () => {
    const f = await fixture(yieldedWait, CoworkSessionSource.ChromeExtension);
    await f.adapter.performDisconnectedTurnRecovery('app');
    expect(f.coordinator.getTurn('app', source.clientTurnId)?.outstandingLaunch).toBe(true);
    expect(f.coordinator.getSettledReceipt('technical-1')).toBeNull();
    expect(f.reconcile).toHaveBeenCalledOnce();
    expect(f.displayFinal).not.toHaveBeenCalled();
  });

  it('retires an old connection claim from fresh exact wait proof without another automatic send', async () => {
    const f = await fixture(successfulWait);
    f.coordinator.clear();
    f.adapter.gatewayClientGeneration = 8;
    await f.adapter.performDisconnectedTurnRecovery('app');
    expect(f.coordinator.getPresentation('app')?.phase).toBe(AutomaticErrorRetryPhase.Completed);
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.launch).toHaveBeenCalledOnce();
    expect(f.reconcile).toHaveBeenCalledOnce();
    expect(f.coordinator.arm({ ...source, clientTurnId: 'new-user', runId: 'new-user-run', clientGeneration: 8 })).toBe(true);
    const g = await fixture(successfulWait);
    g.coordinator.clear();
    g.adapter.gatewayClientGeneration = 8;
    g.request.mockImplementation(async method => method === 'agent.wait' ? { runId: 'technical-1', ...successfulWait }
      : { session: { key: source.sessionKey, sessionId: 'replacement', lifecycleRevision: 'revision' } });
    await g.adapter.performDisconnectedTurnRecovery('app');
    expect(g.request).toHaveBeenNthCalledWith(2, 'sessions.describe', { key: source.sessionKey });
    expect(g.release).not.toHaveBeenCalled();
    expect(g.launch).toHaveBeenCalledOnce();
  });

  it('refuses a changed Gateway generation or session revision during reconciliation', async () => {
    const f = await fixture(successfulWait);
    f.request.mockImplementation(async () => {
      f.adapter.gatewayClientGeneration++;
      return { runId: 'technical-1', ...successfulWait };
    });
    await f.adapter.performDisconnectedTurnRecovery('app');
    expect(f.coordinator.getPresentation('app')?.phase).toBe(AutomaticErrorRetryPhase.Unknown);
    expect(f.reconcile).not.toHaveBeenCalled();
    expect(f.request).toHaveBeenCalledOnce();
    const g = await fixture(successfulWait);
    g.request.mockImplementation(async method => method === 'agent.wait'
      ? { runId: 'technical-1', ...successfulWait }
      : { session: { key: source.sessionKey, sessionId: 'native', lifecycleRevision: 'replacement' } });
    await g.adapter.performDisconnectedTurnRecovery('app');
    expect(g.request).toHaveBeenNthCalledWith(2, 'sessions.describe', { key: source.sessionKey });
    expect(g.coordinator.getPresentation('app')?.phase).toBe(AutomaticErrorRetryPhase.Unknown);
    expect(g.reconcile).not.toHaveBeenCalled();
    const h = await fixture(successfulWait);
    h.request.mockImplementation(async method => {
      if (method === 'agent.wait') return { runId: 'technical-1', ...successfulWait };
      h.turn.runId = 'replacement-run';
      return { session: { key: source.sessionKey, sessionId: 'native', lifecycleRevision: 'revision' } };
    });
    await h.adapter.performDisconnectedTurnRecovery('app');
    expect(h.request).toHaveBeenNthCalledWith(2, 'sessions.describe', { key: source.sessionKey });
    expect(h.coordinator.getPresentation('app')?.phase).toBe(AutomaticErrorRetryPhase.Unknown);
    expect(h.reconcile).not.toHaveBeenCalled();
  });
});
