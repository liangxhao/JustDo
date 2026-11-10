import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AutomaticErrorRetryDisposition,
  AutomaticErrorRetryPhase,
  type AutomaticErrorRetryPresentation,
} from '../../../../shared/cowork/automaticErrorRetry';
import type { GoalLifecycleEvent } from '../../../openclaw/goals/goalContinuationCoordinator';
import type { GatewayClientLike, NativeRunTerminalReceipt } from '../../gateway/types';
import { AutomaticErrorRetryCoordinator, type AutomaticErrorRetryLaunchResult,
  type AutomaticErrorRetryWaitReceipt } from './coordinator';
import { AutomaticErrorRetryLifecycle } from './lifecycle';
import { REPEATED_TOOL_ERROR_CODE } from './rules';

const event: GoalLifecycleEvent & { phase: 'error'; executionSettled: true } = {
  sessionKey: 'agent:main:justdo:app', sessionId: 'native', lifecycleGeneration: 'generation',
  runId: 'run', phase: 'error', executionSettled: true, error: 'tool failure',
};
const receipt: AutomaticErrorRetryWaitReceipt = {
  source: 'agent.wait', runId: event.runId, sessionKey: event.sessionKey, sessionId: 'native',
  lifecycleGeneration: 'generation', clientGeneration: 7, status: 'failed', executionSettled: true,
  error: 'tool failure',
};

function fixture() {
  const presentation: AutomaticErrorRetryPresentation = {
    sessionId: 'app', chainId: 'input', revision: 1, phase: AutomaticErrorRetryPhase.Eligible,
    attempt: 0, maxContinuations: 1, runs: [{
      runId: 'run', clientTurnId: 'input', chainId: 'input', attempt: 0, maxContinuations: 1,
      sessionKey: event.sessionKey, nativeSessionId: 'native', lifecycleRevision: 'revision',
      disposition: AutomaticErrorRetryDisposition.Candidate,
    }],
  };
  const coordinator = {
    getRunMetadata: vi.fn((runId: string) => presentation.runs.find(run => run.runId === runId) ?? null),
    getPresentation: vi.fn(() => presentation), holdsTerminal: vi.fn(() => true),
    retireWaitSettled: vi.fn((_receipt: AutomaticErrorRetryWaitReceipt, _identity: unknown) => false),
    observeWaitSettled: vi.fn((_receipt: AutomaticErrorRetryWaitReceipt) => true),
  };
  const handle = vi.fn();
  const reconcile = vi.fn(async () => {});
  const emit = vi.fn();
  let current = true;
  const lifecycle = new AutomaticErrorRetryLifecycle({
    coordinator, resolveSessionId: key => key === event.sessionKey ? 'app' : 'other',
    isConnectionCurrent: () => current, handleGoalLifecycle: handle,
    reconcileGoalTerminal: reconcile, emitError: emit,
  });
  return { lifecycle, coordinator, presentation, handle, reconcile, emit,
    connection: { client: {} as GatewayClientLike, generation: 7 }, stale: () => { current = false; } };
}

afterEach(() => { vi.useRealTimers(); });

describe('automatic error retry lifecycle', () => {
  it('bounds a candidate error delay and stops hiding unknown or finalized errors', () => {
    vi.useFakeTimers();
    const f = fixture();
    expect(f.lifecycle.deferError('app', 'run', 'tool failure')).toBe(true);
    expect(f.lifecycle.deferError('app', 'run', 'duplicate')).toBe(true);
    vi.advanceTimersByTime(4_999);
    expect(f.emit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(f.emit).toHaveBeenCalledExactlyOnceWith('app', 'tool failure');
    f.presentation.phase = AutomaticErrorRetryPhase.Unknown;
    expect(f.lifecycle.deferError('app', 'run', 'unknown')).toBe(false);
    f.presentation.phase = AutomaticErrorRetryPhase.Failed;
    f.presentation.runs[0].disposition = AutomaticErrorRetryDisposition.Final;
    expect(f.lifecycle.deferError('app', 'run', 'final')).toBe(false);
  });

  it('holds a pending error until a final decision and reveals it once', () => {
    vi.useFakeTimers();
    const f = fixture();
    f.lifecycle.deferError('app', 'run', 'tool failure');
    f.presentation.phase = AutomaticErrorRetryPhase.Checking;
    f.presentation.runs[0].disposition = AutomaticErrorRetryDisposition.Pending;
    f.lifecycle.onPresentation(f.presentation);
    vi.advanceTimersByTime(10_000);
    expect(f.emit).not.toHaveBeenCalled();
    f.presentation.phase = AutomaticErrorRetryPhase.Failed;
    f.presentation.runs[0].disposition = AutomaticErrorRetryDisposition.Final;
    f.lifecycle.onPresentation(f.presentation);
    f.lifecycle.onPresentation(f.presentation);
    expect(f.emit).toHaveBeenCalledExactlyOnceWith('app', 'tool failure');
  });

  it('hands the original held native terminal back once when retry declines', () => {
    const f = fixture();
    f.lifecycle.forwardGoalLifecycle(event);
    expect(f.handle).not.toHaveBeenCalled();
    f.lifecycle.onUnclaimedSettled(receipt);
    f.lifecycle.onUnclaimedSettled(receipt);
    expect(f.handle).toHaveBeenCalledExactlyOnceWith(event);
    f.coordinator.holdsTerminal.mockReturnValue(false);
    f.lifecycle.forwardGoalLifecycle({ ...event, runId: 'next' });
    expect(f.handle).toHaveBeenLastCalledWith({ ...event, runId: 'next' });
  });

  it('routes verified wait proof before Goal and keeps its native fields unchanged', async () => {
    const f = fixture();
    const identity = { sessionKey: event.sessionKey, nativeSessionId: 'native', lifecycleRevision: 'revision' };
    await f.lifecycle.reconcileVerifiedWaitTerminal(event, f.connection, 'failed', undefined, identity);
    expect(f.coordinator.retireWaitSettled).toHaveBeenCalledExactlyOnceWith(receipt, identity);
    expect(f.coordinator.observeWaitSettled).toHaveBeenCalledExactlyOnceWith(receipt);
    expect(f.coordinator.retireWaitSettled.mock.invocationCallOrder[0])
      .toBeLessThan(f.coordinator.observeWaitSettled.mock.invocationCallOrder[0]);
    expect(f.reconcile).not.toHaveBeenCalled();
    const observed = f.coordinator.observeWaitSettled.mock.calls[0][0];
    expect(observed).not.toHaveProperty('agentSeq');
    expect(observed).not.toHaveProperty('endedAt');
    f.lifecycle.onUnclaimedSettled(receipt);
    f.lifecycle.onUnclaimedSettled(receipt);
    expect(f.reconcile).toHaveBeenCalledExactlyOnceWith(event);
  });

  it('does not forward a held wait terminal after its connection changes', async () => {
    const f = fixture();
    await f.lifecycle.reconcileVerifiedWaitTerminal(event, f.connection, 'failed');
    f.stale();
    f.lifecycle.onUnclaimedSettled(receipt);
    expect(f.reconcile).not.toHaveBeenCalled();
  });

  it('discards superseded errors and both held terminal sources', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.lifecycle.deferError('app', 'run', 'tool failure');
    f.lifecycle.forwardGoalLifecycle(event);
    await f.lifecycle.reconcileVerifiedWaitTerminal(event, f.connection, 'failed');
    f.presentation.phase = AutomaticErrorRetryPhase.Running;
    f.presentation.runs[0].disposition = AutomaticErrorRetryDisposition.Superseded;
    f.lifecycle.onPresentation(f.presentation);
    vi.advanceTimersByTime(10_000);
    f.lifecycle.onUnclaimedSettled(receipt);
    expect(f.emit).not.toHaveBeenCalled();
    expect(f.handle).not.toHaveBeenCalled();
    expect(f.reconcile).not.toHaveBeenCalled();
  });

  it.each(['native', 'wait'] as const)('returns the real %s predecessor once after a deferred launch is rejected', async source => {
    let resolveLaunch!: (result: AutomaticErrorRetryLaunchResult) => void;
    const result = new Promise<AutomaticErrorRetryLaunchResult>(resolve => { resolveLaunch = resolve; });
    const launch = vi.fn(() => result);
    const handle = vi.fn();
    const reconcile = vi.fn(async () => {});
    let lifecycle!: AutomaticErrorRetryLifecycle;
    const coordinator = new AutomaticErrorRetryCoordinator({
      isCurrent: () => true, readFailureCode: async () => REPEATED_TOOL_ERROR_CODE,
      reserveSuccessor: () => true, releaseSuccessor() {}, launchSuccessor: launch,
      onChanged: presentation => lifecycle.onPresentation(presentation),
      onUnclaimedSettled: terminal => lifecycle.onUnclaimedSettled(terminal),
      createRunId: () => 'successor',
    });
    const connection = { client: {} as GatewayClientLike, generation: 7 };
    lifecycle = new AutomaticErrorRetryLifecycle({
      coordinator, resolveSessionId: () => 'app', isConnectionCurrent: () => true,
      handleGoalLifecycle: handle, reconcileGoalTerminal: reconcile, emitError() {},
    });
    coordinator.arm({
      sessionId: 'app', sessionKey: event.sessionKey, nativeSessionId: 'native', lifecycleRevision: 'revision',
      clientGeneration: 7, clientTurnId: 'input', runId: event.runId, maxContinuations: 1,
    });
    const native: NativeRunTerminalReceipt = {
      runId: event.runId, sessionKey: event.sessionKey, sessionId: 'native', lifecycleGeneration: 'generation',
      clientGeneration: 7, agentSeq: 1, endedAt: 1, status: 'failed', executionSettled: true,
    };
    if (source === 'native') {
      expect(coordinator.observeSettled(native)).toBe(true);
      lifecycle.forwardGoalLifecycle(event);
    } else {
      await lifecycle.reconcileVerifiedWaitTerminal(event, connection, 'failed');
    }
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
    expect(coordinator.getPresentation('app')?.phase).toBe(AutomaticErrorRetryPhase.Preparing);
    expect(coordinator.getRunMetadata(event.runId)?.disposition).toBe(AutomaticErrorRetryDisposition.Pending);
    expect(handle).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();

    resolveLaunch({ status: 'rejected' });
    const owner = source === 'native' ? handle : reconcile;
    await vi.waitFor(() => expect(owner).toHaveBeenCalledExactlyOnceWith(event));
    expect(coordinator.getPresentation('app')?.phase).toBe(AutomaticErrorRetryPhase.Failed);
    expect(coordinator.getRunMetadata(event.runId)?.disposition).toBe(AutomaticErrorRetryDisposition.Final);
    expect(source === 'native' ? coordinator.observeSettled(native) : coordinator.observeWaitSettled(receipt)).toBe(false);
    lifecycle.onUnclaimedSettled(receipt);
    expect(owner).toHaveBeenCalledOnce();
    expect(source === 'native' ? reconcile : handle).not.toHaveBeenCalled();
  });

  it('cancels only the selected session and clears timers on teardown', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.lifecycle.forwardGoalLifecycle(event);
    await f.lifecycle.reconcileVerifiedWaitTerminal(event, f.connection, 'failed');
    f.lifecycle.cancel('other');
    f.lifecycle.onUnclaimedSettled(receipt);
    expect(f.reconcile).toHaveBeenCalledOnce();
    f.lifecycle.cancel('app');
    f.lifecycle.onUnclaimedSettled(receipt);
    expect(f.handle).not.toHaveBeenCalled();
    f.lifecycle.deferError('app', 'run', 'tool failure');
    f.lifecycle.clear();
    vi.advanceTimersByTime(10_000);
    expect(f.emit).not.toHaveBeenCalled();
  });
});
