import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd(), getPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: () => [] } }));

import { AutomaticErrorRetryPhase } from '../../../shared/cowork/automaticErrorRetry';
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

async function fixture(result: Record<string, unknown>) {
  let sequence = 0;
  const launch = vi.fn(async () => ({ status: 'unknown' as const }));
  const release = vi.fn();
  const reconcile = vi.fn(async () => {});
  const coordinator = new AutomaticErrorRetryCoordinator({
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
  return { adapter, request, coordinator, release, launch, reconcile, displayFinal, turn };
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

  it('clears Unknown on exact success without inventing a native sequence or terminal timestamp', async () => {
    const f = await fixture({ status: 'ok' });
    await f.adapter.performDisconnectedTurnRecovery('app');
    expect(f.coordinator.getPresentation('app')?.phase).toBe(AutomaticErrorRetryPhase.Completed);
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.launch).toHaveBeenCalledOnce();
    expect(f.reconcile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ runId: 'technical-1',
      phase: 'end', executionSettled: true }));
    expect(f.reconcile.mock.calls[0][0]).not.toHaveProperty('agentSeq');
    expect(f.reconcile.mock.calls[0][0]).not.toHaveProperty('endedAt');
  });

  it('preserves yielded descendant custody while clearing the completed retry run', async () => {
    const f = await fixture({ status: 'ok', yielded: true });
    await f.adapter.performDisconnectedTurnRecovery('app');
    expect(f.coordinator.getPresentation('app')?.phase).toBe(AutomaticErrorRetryPhase.Completed);
    expect(f.reconcile).toHaveBeenCalledWith(expect.objectContaining({ yielded: true, livenessState: 'paused', stopReason: 'end_turn' }));
    expect(f.displayFinal).not.toHaveBeenCalled();
  });

  it('retires an old connection claim from fresh exact wait proof without another automatic send', async () => {
    const f = await fixture({ status: 'ok' });
    f.coordinator.clear();
    f.adapter.gatewayClientGeneration = 8;
    await f.adapter.performDisconnectedTurnRecovery('app');
    expect(f.coordinator.getPresentation('app')?.phase).toBe(AutomaticErrorRetryPhase.Completed);
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.launch).toHaveBeenCalledOnce();
    expect(f.reconcile).toHaveBeenCalledOnce();
    expect(f.coordinator.arm({ ...source, clientTurnId: 'new-user', runId: 'new-user-run', clientGeneration: 8 })).toBe(true);
    const g = await fixture({ status: 'ok' });
    g.coordinator.clear();
    g.adapter.gatewayClientGeneration = 8;
    g.request.mockImplementation(async method => method === 'agent.wait' ? { runId: 'technical-1', status: 'ok' }
      : { session: { key: source.sessionKey, sessionId: 'replacement', lifecycleRevision: 'revision' } });
    await g.adapter.performDisconnectedTurnRecovery('app');
    expect(g.release).not.toHaveBeenCalled();
    expect(g.launch).toHaveBeenCalledOnce();
  });

  it('refuses a changed Gateway generation or session revision during reconciliation', async () => {
    const f = await fixture({ status: 'ok' });
    f.request.mockImplementation(async () => {
      f.adapter.gatewayClientGeneration++;
      return { runId: 'technical-1', status: 'ok' };
    });
    await f.adapter.performDisconnectedTurnRecovery('app');
    expect(f.coordinator.getPresentation('app')?.phase).toBe(AutomaticErrorRetryPhase.Unknown);
    expect(f.reconcile).not.toHaveBeenCalled();
    const g = await fixture({ status: 'ok' });
    g.request.mockImplementation(async method => method === 'agent.wait'
      ? { runId: 'technical-1', status: 'ok' }
      : { session: { key: source.sessionKey, sessionId: 'native', lifecycleRevision: 'replacement' } });
    await g.adapter.performDisconnectedTurnRecovery('app');
    expect(g.coordinator.getPresentation('app')?.phase).toBe(AutomaticErrorRetryPhase.Unknown);
    expect(g.reconcile).not.toHaveBeenCalled();
    const h = await fixture({ status: 'ok' });
    h.request.mockImplementation(async method => {
      if (method === 'agent.wait') return { runId: 'technical-1', status: 'ok' };
      h.turn.runId = 'replacement-run';
      return { session: { key: source.sessionKey, sessionId: 'native', lifecycleRevision: 'revision' } };
    });
    await h.adapter.performDisconnectedTurnRecovery('app');
    expect(h.coordinator.getPresentation('app')?.phase).toBe(AutomaticErrorRetryPhase.Unknown);
    expect(h.reconcile).not.toHaveBeenCalled();
  });
});
