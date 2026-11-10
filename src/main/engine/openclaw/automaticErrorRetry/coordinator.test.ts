import { describe, expect, it, vi } from 'vitest';

import { AutomaticErrorRetryDisposition, AutomaticErrorRetryPhase } from '../../../../shared/cowork/automaticErrorRetry';
import type { NativeRunTerminalReceipt } from '../../gateway/types';
import {
  type AutomaticErrorRetryArm,
  AutomaticErrorRetryCoordinator,
  type AutomaticErrorRetryLaunchRequest,
  type AutomaticErrorRetryLaunchResult,
  type AutomaticErrorRetryWaitReceipt,
} from './coordinator';
import { createAutomaticErrorRetryRuleIndex, REPEATED_TOOL_ERROR_CODE } from './rules';

const arm: AutomaticErrorRetryArm = {
  sessionId: 'product-session', sessionKey: 'agent:main:justdo:product-session',
  nativeSessionId: 'native-session', lifecycleRevision: 'revision-one', clientGeneration: 1,
  clientTurnId: 'user-input', runId: 'root-run', maxContinuations: 2,
};
const receipt = (runId = arm.runId, status: NativeRunTerminalReceipt['status'] = 'failed'): NativeRunTerminalReceipt => ({
  runId, sessionKey: arm.sessionKey, sessionId: arm.nativeSessionId, lifecycleGeneration: 'native-generation',
  clientGeneration: 1, agentSeq: 10, executionSettled: true, status, endedAt: 1,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(value => { resolve = value; });
  return { promise, resolve };
}
function fixture(maxContinuations = 2) {
  let current = true;
  let sequence = 0;
  const read = vi.fn(async () => REPEATED_TOOL_ERROR_CODE as string | null);
  const reserve = vi.fn(() => true);
  const release = vi.fn();
  const launch = vi.fn(async (_request: AutomaticErrorRetryLaunchRequest): Promise<AutomaticErrorRetryLaunchResult> => ({ status: 'accepted' }));
  const changed = vi.fn();
  const unclaimed = vi.fn();
  const coordinator = new AutomaticErrorRetryCoordinator({
    readFailureCode: read, isCurrent: () => current, reserveSuccessor: reserve,
    releaseSuccessor: release, launchSuccessor: launch, onChanged: changed,
    onUnclaimedSettled: unclaimed, createRunId: () => `technical-${++sequence}`,
  });
  coordinator.arm({ ...arm, maxContinuations });
  return { coordinator, read, reserve, release, launch, changed, unclaimed,
    stale: () => { current = false; } };
}

describe('automatic error retry coordinator', () => {
  it('claims the exact predecessor before waiting and deduplicates its terminal', async () => {
    const f = fixture();
    const code = deferred<string | null>();
    f.read.mockReturnValue(code.promise);
    const terminal = receipt();
    expect(f.coordinator.observeSettled(terminal)).toBe(true);
    expect(f.reserve).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ runId: arm.runId }), arm.runId);
    expect(f.coordinator.holdsTerminal(arm.runId)).toBe(true);
    expect(f.coordinator.observeSettled(terminal)).toBe(true);
    expect(f.read).toHaveBeenCalledOnce();
    code.resolve(REPEATED_TOOL_ERROR_CODE);
    await vi.waitFor(() => expect(f.launch).toHaveBeenCalledOnce());
    expect(f.launch.mock.calls[0][0]).toMatchObject({ attempt: 1, predecessorRunId: arm.runId, runId: 'technical-1' });
    expect(f.coordinator.getRunMetadata(arm.runId)?.disposition).toBe(AutomaticErrorRetryDisposition.Superseded);
    expect(f.coordinator.isTechnicalRun('technical-1')).toBe(true);
    expect(f.coordinator.getPresentation(arm.sessionId)?.phase).toBe(AutomaticErrorRetryPhase.Running);
  });

  it('shares n across successor run IDs and hands back the exhausted final receipt once', async () => {
    const f = fixture(2);
    f.coordinator.observeSettled(receipt());
    await vi.waitFor(() => expect(f.launch).toHaveBeenCalledTimes(1));
    f.coordinator.observeSettled(receipt('technical-1'));
    await vi.waitFor(() => expect(f.launch).toHaveBeenCalledTimes(2));
    const final = receipt('technical-2');
    expect(f.coordinator.observeSettled(final)).toBe(true);
    await vi.waitFor(() => expect(f.unclaimed).toHaveBeenCalledExactlyOnceWith(final));
    expect(f.launch).toHaveBeenCalledTimes(2);
    expect(f.coordinator.getPresentation(arm.sessionId)).toMatchObject({ attempt: 2, phase: AutomaticErrorRetryPhase.Failed });
    expect(f.coordinator.observeSettled(final)).toBe(false);
    expect(f.unclaimed).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledTimes(3);
  });

  it('uses a common counter when registered error A is followed by error B', async () => {
    const launches: AutomaticErrorRetryLaunchRequest[] = [];
    const unclaimed = vi.fn();
    let sequence = 0;
    const coordinator = new AutomaticErrorRetryCoordinator({
      readFailureCode: async (_binding, value) => value.runId === arm.runId ? 'error_a' : 'error_b',
      isCurrent: () => true, reserveSuccessor: () => true, releaseSuccessor() {},
      launchSuccessor: async request => { launches.push(request); return { status: 'accepted' }; },
      onChanged() {}, onUnclaimedSettled: unclaimed, createRunId: () => `retry-${++sequence}`,
      rules: [{ id: 'a', errorCodes: ['error_a'], fixedPrompt: 'A' }, { id: 'b', errorCodes: ['error_b'], fixedPrompt: 'B' }],
    });
    coordinator.arm(arm);
    coordinator.observeSettled(receipt());
    await vi.waitFor(() => expect(launches).toHaveLength(1));
    coordinator.observeSettled(receipt('retry-1'));
    await vi.waitFor(() => expect(launches).toHaveLength(2));
    coordinator.observeSettled(receipt('retry-2'));
    await vi.waitFor(() => expect(unclaimed).toHaveBeenCalledOnce());
    expect(launches.map(value => [value.attempt, value.fixedPrompt, value.chainId])).toEqual([[1, 'A', arm.clientTurnId], [2, 'B', arm.clientTurnId]]);
  });

  it('does not match error text or resume after an unregistered structured code', async () => {
    const f = fixture();
    f.read.mockResolvedValue(null);
    const final = { ...receipt(), error: REPEATED_TOOL_ERROR_CODE };
    expect(f.coordinator.observeSettled(final)).toBe(true);
    await vi.waitFor(() => expect(f.unclaimed).toHaveBeenCalledExactlyOnceWith(final));
    expect(f.launch).not.toHaveBeenCalled();
  });

  it('ignores foreign run, session and client identities and disabled configuration', () => {
    const f = fixture();
    for (const foreign of [receipt('foreign'), { ...receipt(), sessionId: 'replacement' },
      { ...receipt(), sessionKey: 'agent:other:justdo:product-session' }, { ...receipt(), clientGeneration: 2 }])
      expect(f.coordinator.observeSettled(foreign)).toBe(false);
    expect(f.reserve).not.toHaveBeenCalled();
    const disabled = fixture(0);
    expect(disabled.coordinator.observeSettled(receipt())).toBe(false);
  });

  it('cancels pending evidence and releases its reservation without a late send', async () => {
    const f = fixture();
    const code = deferred<string | null>();
    f.read.mockReturnValue(code.promise);
    f.coordinator.observeSettled(receipt());
    f.coordinator.cancel(arm.sessionId);
    code.resolve(REPEATED_TOOL_ERROR_CODE);
    await Promise.resolve();
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.coordinator.getPresentation(arm.sessionId)?.phase).toBe(AutomaticErrorRetryPhase.Cancelled);
  });

  it('does not send when source ownership changes while reading evidence', async () => {
    const f = fixture();
    const code = deferred<string | null>();
    f.read.mockReturnValue(code.promise);
    f.coordinator.observeSettled(receipt());
    f.stale();
    code.resolve(REPEATED_TOOL_ERROR_CODE);
    await Promise.resolve();
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it('keeps an uncertain send spent and reserved, without resending duplicate terminals', async () => {
    const f = fixture();
    f.launch.mockRejectedValue(new Error('ACK lost'));
    const terminal = receipt();
    f.coordinator.observeSettled(terminal);
    await vi.waitFor(() => expect(f.coordinator.getPresentation(arm.sessionId)?.phase).toBe(AutomaticErrorRetryPhase.Unknown));
    expect(f.coordinator.observeSettled(terminal)).toBe(true);
    expect(f.launch).toHaveBeenCalledOnce();
    expect(f.release).not.toHaveBeenCalled();
    expect(f.coordinator.getPresentation(arm.sessionId)?.attempt).toBe(1);
    expect(f.unclaimed).not.toHaveBeenCalled();
    expect(f.coordinator.getRunMetadata(arm.runId)?.disposition).toBe(AutomaticErrorRetryDisposition.Pending);
  });

  it('only supersedes a predecessor after an accepted ACK or exact successor terminal', async () => {
    const f = fixture();
    const ack = deferred<AutomaticErrorRetryLaunchResult>();
    f.launch.mockReturnValue(ack.promise);
    f.coordinator.observeSettled(receipt());
    await vi.waitFor(() => expect(f.launch).toHaveBeenCalledOnce());
    expect(f.coordinator.getPresentation(arm.sessionId)?.phase).toBe(AutomaticErrorRetryPhase.Preparing);
    expect(f.coordinator.getRunMetadata(arm.runId)?.disposition).toBe(AutomaticErrorRetryDisposition.Pending);
    f.coordinator.observeSettled(receipt('technical-1', 'completed'));
    expect(f.coordinator.getRunMetadata(arm.runId)?.disposition).toBe(AutomaticErrorRetryDisposition.Superseded);
    ack.resolve({ status: 'accepted' });
    await Promise.resolve();
    expect(f.coordinator.getPresentation(arm.sessionId)?.phase).toBe(AutomaticErrorRetryPhase.Completed);
  });

  it('retains an uncertain successor claim through cancellation until its exact terminal', async () => {
    const f = fixture();
    f.launch.mockResolvedValue({ status: 'unknown' });
    f.coordinator.observeSettled(receipt());
    await vi.waitFor(() => expect(f.coordinator.getPresentation(arm.sessionId)?.phase).toBe(AutomaticErrorRetryPhase.Unknown));
    f.coordinator.cancel(arm.sessionId);
    f.coordinator.clear();
    expect(f.coordinator.getRunMetadata(arm.runId)?.disposition).toBe(AutomaticErrorRetryDisposition.Final);
    expect(f.release).not.toHaveBeenCalled();
    expect(f.coordinator.holdsTerminal(arm.runId)).toBe(true);
    expect(f.coordinator.arm({ ...arm, clientTurnId: 'new-input', runId: 'new-run' })).toBe(false);
    expect(f.coordinator.observeSettled(receipt('technical-1', 'completed'))).toBe(false);
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.launch).toHaveBeenCalledOnce();
  });

  it('releases a cancelled in-flight claim only when dispatch proves it never sent', async () => {
    const f = fixture();
    const result = deferred<AutomaticErrorRetryLaunchResult>();
    f.launch.mockReturnValue(result.promise);
    f.coordinator.observeSettled(receipt());
    await vi.waitFor(() => expect(f.launch).toHaveBeenCalledOnce());
    f.coordinator.cancel(arm.sessionId);
    expect(f.release).not.toHaveBeenCalled();
    result.resolve({ status: 'rejected' });
    await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce());
    expect(f.coordinator.getPresentation(arm.sessionId)?.phase).toBe(AutomaticErrorRetryPhase.Cancelled);
    expect(f.unclaimed).not.toHaveBeenCalled();
  });

  it('retires cross-generation uncertainty without reviving the old retry chain', async () => {
    const f = fixture(2);
    f.launch.mockResolvedValue({ status: 'unknown' });
    f.coordinator.observeSettled(receipt());
    await vi.waitFor(() => expect(f.coordinator.getPresentation(arm.sessionId)?.phase).toBe(AutomaticErrorRetryPhase.Unknown));
    f.coordinator.clear();
    const settled: AutomaticErrorRetryWaitReceipt = {
      source: 'agent.wait', runId: 'technical-1', sessionKey: arm.sessionKey, sessionId: arm.nativeSessionId,
      lifecycleGeneration: 'generation', clientGeneration: 2, executionSettled: true, status: 'failed',
    };
    expect(f.coordinator.observeWaitSettled(settled)).toBe(false);
    expect(f.coordinator.retireWaitSettled(settled, arm)).toBe(true);
    expect(f.coordinator.getSettledReceipt(settled.runId)).toEqual(settled);
    const exposed = f.coordinator.getSettledReceipt(settled.runId)!;
    exposed.clientGeneration = 99;
    expect(f.coordinator.getSettledReceipt(settled.runId)).toEqual(settled);
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.coordinator.getPresentation(arm.sessionId)).toMatchObject({ phase: AutomaticErrorRetryPhase.Failed, attempt: 1 });
    expect(f.launch).toHaveBeenCalledOnce();
    expect(f.read).toHaveBeenCalledOnce();
    expect(f.unclaimed).not.toHaveBeenCalled();
    expect(f.coordinator.arm({ ...arm, clientTurnId: 'new-human-input', runId: 'new-human-run', clientGeneration: 2 })).toBe(true);
    expect(f.coordinator.getPresentation(arm.sessionId)?.attempt).toBe(0);
    expect(f.launch).toHaveBeenCalledOnce();
  });

  it('does not retire a stale claim from a different SID, revision or old connection', async () => {
    const f = fixture();
    f.launch.mockResolvedValue({ status: 'unknown' });
    f.coordinator.observeSettled(receipt());
    await vi.waitFor(() => expect(f.coordinator.getPresentation(arm.sessionId)?.phase).toBe(AutomaticErrorRetryPhase.Unknown));
    f.coordinator.clear();
    const settled: AutomaticErrorRetryWaitReceipt = { source: 'agent.wait', runId: 'technical-1', sessionKey: arm.sessionKey,
      sessionId: arm.nativeSessionId, lifecycleGeneration: null, clientGeneration: 2, executionSettled: true, status: 'completed' };
    expect(f.coordinator.retireWaitSettled({ ...settled, sessionId: 'replacement' }, arm)).toBe(false);
    expect(f.coordinator.retireWaitSettled(settled, { ...arm, lifecycleRevision: 'replacement' })).toBe(false);
    expect(f.coordinator.retireWaitSettled({ ...settled, clientGeneration: 1 }, arm)).toBe(false);
    expect(f.release).not.toHaveBeenCalled();
  });

  it('hands back a definite rejected send and never refunds its occupied count', async () => {
    const f = fixture();
    f.launch.mockResolvedValue({ status: 'rejected' });
    const terminal = receipt();
    f.coordinator.observeSettled(terminal);
    await vi.waitFor(() => expect(f.unclaimed).toHaveBeenCalledExactlyOnceWith(terminal));
    expect(f.coordinator.getPresentation(arm.sessionId)?.attempt).toBe(1);
    expect(f.coordinator.getRunMetadata(arm.runId)?.disposition).toBe(AutomaticErrorRetryDisposition.Final);
    expect(f.coordinator.arm(arm)).toBe(false);
  });

  it('preserves a fast successor terminal arriving before its ACK', async () => {
    const f = fixture();
    const accepted = deferred<AutomaticErrorRetryLaunchResult>();
    f.launch.mockReturnValue(accepted.promise);
    f.coordinator.observeSettled(receipt());
    await vi.waitFor(() => expect(f.launch).toHaveBeenCalledOnce());
    expect(f.coordinator.observeSettled(receipt('technical-1', 'completed'))).toBe(false);
    accepted.resolve({ status: 'accepted' });
    await Promise.resolve();
    expect(f.coordinator.getPresentation(arm.sessionId)?.phase).toBe(AutomaticErrorRetryPhase.Completed);
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.unclaimed).not.toHaveBeenCalled();
  });

  it('finishes interrupted successors without another retry and exposes immutable snapshots', async () => {
    const f = fixture();
    f.coordinator.observeSettled(receipt());
    await vi.waitFor(() => expect(f.launch).toHaveBeenCalledOnce());
    expect(f.coordinator.observeSettled(receipt('technical-1', 'interrupted'))).toBe(false);
    const snapshot = f.coordinator.getPresentation(arm.sessionId)!;
    expect(snapshot.phase).toBe(AutomaticErrorRetryPhase.Cancelled);
    snapshot.runs[0].disposition = AutomaticErrorRetryDisposition.Final;
    expect(f.coordinator.getPresentation(arm.sessionId)?.runs[0].disposition).toBe(AutomaticErrorRetryDisposition.Superseded);
    expect(f.changed.mock.calls.map(([value]) => value.revision)).toEqual([...f.changed.mock.calls.map(([value]) => value.revision)].sort((a, b) => a - b));
  });

  it('keeps the same business retry allowance spent without classifying it as a technical run', async () => {
    const f = fixture(1);
    f.coordinator.observeSettled(receipt());
    await vi.waitFor(() => expect(f.launch).toHaveBeenCalledOnce());
    f.coordinator.observeSettled(receipt('technical-1'));
    await vi.waitFor(() => expect(f.unclaimed).toHaveBeenCalledOnce());
    expect(f.coordinator.adoptBusinessRun({ ...arm, runId: 'business-retry', clientTurnId: 'business-retry',
      predecessorRunId: 'technical-1', businessRetry: true })).toBe(true);
    expect(f.coordinator.isTechnicalRun('business-retry')).toBe(false);
    expect(f.coordinator.getPresentation(arm.sessionId)).toMatchObject({ attempt: 1, maxContinuations: 1, chainId: arm.clientTurnId });
    f.coordinator.observeSettled(receipt('business-retry'));
    await vi.waitFor(() => expect(f.unclaimed).toHaveBeenCalledTimes(2));
    expect(f.launch).toHaveBeenCalledOnce();
    expect(() => f.launch.mock.calls[0][0].assertCurrent()).toThrow();
  });
});

describe('automatic retry rule registry', () => {
  it('ships only the structured repeated-tool rule and rejects duplicate codes and IDs', () => {
    expect([...createAutomaticErrorRetryRuleIndex().keys()]).toEqual([REPEATED_TOOL_ERROR_CODE]);
    expect(() => createAutomaticErrorRetryRuleIndex([
      { id: 'a', errorCodes: ['same'], fixedPrompt: 'a' }, { id: 'b', errorCodes: ['same'], fixedPrompt: 'b' },
    ])).toThrow();
    expect(() => createAutomaticErrorRetryRuleIndex([
      { id: 'a', errorCodes: ['a'], fixedPrompt: 'a' }, { id: 'a', errorCodes: ['b'], fixedPrompt: 'b' },
    ])).toThrow();
  });
});
