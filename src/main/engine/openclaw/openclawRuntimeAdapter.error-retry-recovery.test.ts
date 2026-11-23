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

async function fixture(result: Record<string, unknown>, sessionSource?: CoworkSessionSource) {
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
  const turn: SessionTurn = {
    sessionId: 'app', sessionKey: source.sessionKey, runId: 'technical-1', gatewaySessionId: 'native',
    lifecycleGeneration: 'generation', lastAgentSeq: 2, status: 'running', turnToken: 1,
    stopRequested: false, knownRunIds: new Set(['technical-1']),
  };
  const request = vi.fn(async (method: string) => method === 'agent.wait'
    ? { runId: 'technical-1', ...result }
    : { session: { key: source.sessionKey, sessionId: 'native', lifecycleRevision: 'revision' } });
  const activeTurns = new Map([['app', turn]]);
  const displayFinal = vi.fn(() => { activeTurns.delete('app'); });
  const client = { request } as unknown as GatewayClientLike;
  // Exercise the production recovery method with only its transport/owner boundaries substituted.
  const adapter = Object.assign(Object.create(OpenClawRuntimeAdapter.prototype), {
    gatewayClient: client, gatewayClientGeneration: 7, activeTurns,
    disconnectedSessionIds: new Set(['app']), unknownSessionRuns: new Map(),
    store: { getSession: () => ({ id: source.sessionId, source: sessionSource }) },
    automaticErrorRetryHost: { coordinator },
    goalContinuationCoordinator: { reconcileSettledRun: reconcile },
    confirmUnknownSessionRunAdmission: vi.fn(), handleChatEvent: displayFinal,
    cleanupSessionTurn: () => { activeTurns.delete('app'); }, resolveTurn: vi.fn(),
    scheduleGoalRecovery: vi.fn(),
  }) as {
    gatewayClientGeneration: number;
    performDisconnectedTurnRecovery(sessionId: string): Promise<void>;
  };
  Object.assign(adapter, { automaticErrorRetryLifecycle: new AutomaticErrorRetryLifecycle({
    coordinator, resolveSessionId: () => 'app',
    isConnectionCurrent: connection => connection.client === client && connection.generation === adapter.gatewayClientGeneration,
    handleGoalLifecycle() {}, reconcileGoalTerminal: reconcile, emitError() {},
  }) });
  coordinator.arm(source);
  coordinator.observeSettled(rootReceipt);
  await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
  return { adapter, request, coordinator, release, launch, reconcile, displayFinal, turn, activeTurns };
}

describe('exact agent.wait recovery through automatic error retry', () => {
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
