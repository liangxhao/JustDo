import { describe, expect, test } from 'vitest';

import { recoveryFixture } from './main-session-recovery-fixture';

const runtime = process.env.JUSTDO_EXECUTION_PRISTINE_DIR;

describe.skipIf(!runtime)('native main-session restart recovery without a host-process boundary', () => {
  test('resumes an interrupted accepted turn through native reservation and exact dispatch admission', async () => {
    const fixture = await recoveryFixture(runtime!);
    expect(fixture.interrupted).toMatchObject({ status: 'interrupted', abortedLastRun: true,
      restartRecoveryDeliverySourceRunId: fixture.sourceRunId });

    expect(await fixture.run()).toEqual({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(fixture.dispatches).toHaveLength(1);
    const dispatched = fixture.dispatches[0];
    expect(dispatched).toMatchObject({ agentId: 'main', sessionKey: fixture.key,
      expectedExistingSessionId: fixture.interrupted.sessionId,
      internalRuntimeHandoffId: 'admitted-fixture-handoff', forceRestartSafeTools: true, lane: 'main' });
    expect(dispatched.idempotencyKey).not.toBe(fixture.sourceRunId);
    expect(fixture.entry()).toMatchObject({ sessionId: fixture.interrupted.sessionId,
      lifecycleRevision: fixture.interrupted.lifecycleRevision, abortedLastRun: false,
      restartRecoveryDeliverySourceRunId: fixture.sourceRunId,
      restartRecoveryDeliveryRunId: dispatched.idempotencyKey,
      lifecycleRunId: dispatched.idempotencyKey,
      restartRecoveryRuns: expect.arrayContaining([
        { runId: dispatched.idempotencyKey, lifecycleGeneration: 'current-gateway' },
      ]) });
    expect(fixture.entry().status).toBeUndefined();
    expect(fixture.commands).toEqual(['observe', 'prepare_attempt', 'admit_recovery']);

    await fixture.run();
    expect(fixture.dispatches).toHaveLength(1);
  });

  test('leaves a current process owner in charge without dispatching a duplicate recovery', async () => {
    const fixture = await recoveryFixture(runtime!, { liveOwner: true });
    expect(await fixture.run()).toEqual({ started: 0, settled: 0, failed: 0, skipped: 1 });
    expect(fixture.dispatches).toEqual([]);
    expect(fixture.entry()).toEqual(fixture.interrupted);
    expect(fixture.logs.some(line => line.includes('"reason":"live_owner"'))).toBe(true);
  });

  test('uses the latest native row after a physical session replacement instead of replaying the prior source', async () => {
    const fixture = await recoveryFixture(runtime!, { replaceBeforeObserve: true });
    expect(await fixture.run()).toEqual({ started: 0, settled: 0, failed: 0, skipped: 1 });
    expect(fixture.dispatches).toEqual([]);
    expect(fixture.entry()).toEqual({ sessionId: 'replacement-session', lifecycleRevision: 'replacement-revision', status: 'done' });
    expect(fixture.logs.some(line => line.includes('"reason":"inactive"'))).toBe(true);
  });

  test('reports explicit dispatch rejection without manufacturing an execution terminal', async () => {
    const fixture = await recoveryFixture(runtime!, { rejectDispatch: true });
    expect(await fixture.run()).toEqual({ started: 0, settled: 0, failed: 1, skipped: 0 });
    expect(fixture.dispatches).toHaveLength(1);
    expect(fixture.entry()).toMatchObject({ status: 'interrupted', abortedLastRun: true,
      restartRecoveryDeliverySourceRunId: fixture.sourceRunId,
      mainRestartRecovery: { chargedAttempts: 0 } });
    expect(fixture.entry().mainRestartRecovery.reservation).toBeUndefined();
    expect(fixture.commands).toEqual(['observe', 'prepare_attempt', 'cancel_reservation']);
  });

});
