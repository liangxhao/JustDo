import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GoalExecutionPhase } from '../../../shared/cowork/sessionGoal';
import type { CoworkSession } from '../../data/coworkStore';
import {
  getSessionRuntimeStatus,
  invalidateRuntimeSessionSnapshot,
  invalidateTargetedSessionStatusChecks,
  type RuntimeSessionStatusContext,
} from './runtimeSessionStatus';

const productId = 'e7d0c7d7-ef00-40b0-b7ed-645479f97739';
const key = `agent:main:justdo:${productId}`;
const idle = { known: true, mainRunning: false, subagentRunning: false, running: false };
const unknown = { ...idle, known: false };

beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

function fixture() {
  let source: CoworkSession | null = {
    id: productId, agentId: 'main', cwd: '/workspace', permissionMode: 'ask', status: 'idle',
  } as CoworkSession;
  const native = { key, sessionId: 'native-id', lifecycleRevision: 'native-revision', hasActiveRun: false };
  const request = vi.fn().mockResolvedValue({ session: native });
  const state = { active: false, goalPhase: undefined as string | undefined };
  const context = {
    store: { getSession: () => source, getSessionRuns: vi.fn(() => []) },
    ensureGatewayClientReady: vi.fn(async (): Promise<void> => {}),
    gatewayClient: { request }, gatewayClientGeneration: 1,
    targetedSessionStatusChecks: new Map(), unknownSessionRuns: new Map(),
    disconnectedSessionIds: new Set(), disconnectedRecoveryPromises: new Map(),
    compactionInFlightSessionIds: new Set(), isSessionActive: () => state.active,
    goalContinuationCoordinator: { getSnapshot: () => ({ phase: state.goalPhase }) },
    getRuntimeSessionSnapshot: vi.fn(() => { throw new Error('Targeted reads must not scan the roster'); }),
    runtimeSessionSnapshotGeneration: 0,
  } as unknown as RuntimeSessionStatusContext;
  const read = (expectedSessionId?: string, expectedLifecycleRevision?: string | null) =>
    getSessionRuntimeStatus.call(context, productId, {
      targeted: true, includeSubagents: true, expectedSessionId, expectedLifecycleRevision,
    });
  return { context, request, state, native, read,
    source: () => source!, setSource: (value: CoworkSession | null) => { source = value; } };
}

describe('current conversation runtime activity', () => {
  it('uses native activity and inactive-descendant omission without any global roster query', async () => {
    const f = fixture();
    await expect(f.read()).resolves.toEqual(idle);
    expect(f.request).toHaveBeenCalledExactlyOnceWith('sessions.describe', { key, agentId: 'main' });
    expect(f.context.targetedSessionStatusChecks.size).toBe(0);
  });

  it('reobserves an existing unbound conversation once after a delayed create publication retires its read', async () => {
    const f = fixture();
    f.context.store.getSessionRuns = vi.fn().mockReturnValue([{ state: 'completed' }]);
    f.request.mockImplementationOnce(async () => {
      invalidateTargetedSessionStatusChecks(f.context.targetedSessionStatusChecks, {
        reason: 'create', session: { key, sessionId: f.native.sessionId, controlOwnerSessionKey: null },
      });
      return { session: f.native };
    });
    await expect(f.read()).resolves.toEqual(idle);
    expect(f.request).toHaveBeenCalledTimes(2);
    for (const call of f.request.mock.calls)
      expect(call).toEqual(['sessions.describe', { key, agentId: 'main' }]);
    expect(f.context.targetedSessionStatusChecks.size).toBe(0);
    expect(console.warn).toHaveBeenCalledWith('[OpenClawRuntime] Targeted session status observation', {
      reason: 'event-reobserve', sessionId: productId, key, expectedSessionId: f.native.sessionId, attempt: 1,
    });
  });

  it.each(['child', 'catalog'])('rechecks current activity after an ambiguous %s publication without ignoring it', async kind => {
    const f = fixture();
    f.request.mockImplementationOnce(async () => {
      invalidateTargetedSessionStatusChecks(f.context.targetedSessionStatusChecks,
        kind === 'catalog' ? { reason: 'update', agentId: 'main', catalogChanged: true }
          : { session: { key: 'grandchild', controlOwnerSessionKey: 'child' } });
      return { session: f.native };
    }).mockResolvedValue({ session: { ...f.native, hasActiveSubagentRun: true } });
    await expect(f.read()).resolves.toMatchObject({ known: true, subagentRunning: true, running: true });
    expect(f.request).toHaveBeenCalledTimes(2);
  });

  it('does not retry more than once when change publications keep retiring the exact read', async () => {
    const f = fixture();
    f.request.mockImplementation(async () => {
      invalidateTargetedSessionStatusChecks(f.context.targetedSessionStatusChecks, { key, controlOwnerSessionKey: null });
      return { session: f.native };
    });
    await expect(f.read()).resolves.toEqual(unknown);
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.context.targetedSessionStatusChecks.size).toBe(0);
    expect(console.warn).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ reason: 'event-retired', attempt: 2 }));
  });

  it.each(['session', 'revision', 'missing-revision', 'absent'])('retains the first native incarnation if the reobservation changes %s', async kind => {
    const f = fixture();
    f.request.mockImplementationOnce(async () => {
      invalidateTargetedSessionStatusChecks(f.context.targetedSessionStatusChecks, { key, controlOwnerSessionKey: null });
      return { session: f.native };
    }).mockResolvedValue({ session: kind === 'absent' ? null : { ...f.native,
      ...(kind === 'session' ? { sessionId: 'new-native-incarnation' } : {}),
      ...(kind === 'revision' ? { lifecycleRevision: 'new-revision' } : {}),
      ...(kind === 'missing-revision' ? { lifecycleRevision: undefined } : {}),
    } });
    await expect(f.read()).resolves.toEqual(unknown);
    expect(f.request).toHaveBeenCalledTimes(2);
  });

  it('retains an explicit null lifecycle revision across the reobservation', async () => {
    const f = fixture();
    const native = { ...f.native, lifecycleRevision: null };
    f.request.mockImplementationOnce(async () => {
      invalidateTargetedSessionStatusChecks(f.context.targetedSessionStatusChecks, { key, controlOwnerSessionKey: null });
      return { session: native };
    }).mockResolvedValue({ session: native });
    await expect(f.read('native-id', null)).resolves.toEqual(idle);
    expect(f.request).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, null, 'native-revision'])('preserves the first %s revision without coalescing native omission', async first => {
    const f = fixture();
    const row = { ...f.native, lifecycleRevision: first };
    f.request.mockImplementationOnce(async () => {
      invalidateTargetedSessionStatusChecks(f.context.targetedSessionStatusChecks, { key, controlOwnerSessionKey: null });
      return { session: row };
    }).mockResolvedValue({ session: row });
    await expect(f.read()).resolves.toEqual(idle);
    expect(f.request).toHaveBeenCalledTimes(2);
  });

  it.each([
    [undefined, null], [undefined, 'native-revision'], [null, undefined],
    [null, 'native-revision'], ['native-revision', undefined], ['native-revision', null],
  ])('rejects a reobservation changing revision from %s to %s', async (first, second) => {
    const f = fixture();
    f.request.mockImplementationOnce(async () => {
      invalidateTargetedSessionStatusChecks(f.context.targetedSessionStatusChecks, { key, controlOwnerSessionKey: null });
      return { session: { ...f.native, lifecycleRevision: first } };
    }).mockResolvedValue({ session: { ...f.native, lifecycleRevision: second } });
    await expect(f.read()).resolves.toEqual(unknown);
    expect(f.request).toHaveBeenCalledTimes(2);
  });

  it.each(['error', 'absent', 'invalid', 'wrong-session', 'wrong-agent', 'wrong-revision', 'invalid-revision'])(
    'does not retry an event-retired %s response without a valid first native identity', async kind => {
      const f = fixture();
      f.request.mockImplementationOnce(async () => {
        invalidateTargetedSessionStatusChecks(f.context.targetedSessionStatusChecks, { key, controlOwnerSessionKey: null });
        if (kind === 'error') throw new Error('Native read failed');
        return { session: kind === 'absent' ? null : { ...f.native,
          ...(kind === 'invalid' ? { hasActiveRun: undefined } : {}),
          ...(kind === 'wrong-session' ? { sessionId: 'foreign' } : {}),
          ...(kind === 'wrong-agent' ? { agentId: 'foreign' } : {}),
          ...(kind === 'wrong-revision' ? { lifecycleRevision: 'foreign' } : {}),
          ...(kind === 'invalid-revision' ? { lifecycleRevision: '' } : {}),
        } };
      });
      await expect(f.read('native-id', kind === 'invalid-revision' ? undefined : 'native-revision')).resolves.toEqual(unknown);
      expect(f.request).toHaveBeenCalledOnce();
    },
  );

  it.each(['source', 'external', 'connection', 'generation', 'custody', 'local-active'])(
    'does not obtain a new idle observation after %s changes with the first event', async kind => {
      const f = fixture();
      f.request.mockImplementationOnce(async () => {
        invalidateTargetedSessionStatusChecks(f.context.targetedSessionStatusChecks, { key, controlOwnerSessionKey: null });
        if (kind === 'source') f.source().cwd = '/replaced';
        if (kind === 'external') f.source().external = {} as CoworkSession['external'];
        if (kind === 'connection') f.context.gatewayClient = { request: vi.fn() } as RuntimeSessionStatusContext['gatewayClient'];
        if (kind === 'generation') f.context.gatewayClientGeneration += 1;
        if (kind === 'custody') (f.context.unknownSessionRuns as Map<string, unknown>).set(productId, {});
        if (kind === 'local-active') f.state.active = true;
        return { session: f.native };
      });
      await expect(f.read()).resolves.toEqual(kind === 'local-active'
        ? { known: true, mainRunning: true, subagentRunning: false, running: true } : unknown);
      expect(f.request).toHaveBeenCalledOnce();
    },
  );

  it('uses the exact custom agent and key for both reads', async () => {
    const f = fixture();
    const customKey = `agent:research:justdo:${productId}`;
    f.source().agentId = 'research';
    const native = { ...f.native, key: customKey, agentId: 'research' };
    f.request.mockImplementationOnce(async () => {
      invalidateTargetedSessionStatusChecks(f.context.targetedSessionStatusChecks, { key: customKey, controlOwnerSessionKey: null });
      return { session: native };
    }).mockResolvedValue({ session: native });
    await expect(f.read()).resolves.toEqual(idle);
    expect(f.request.mock.calls).toEqual([
      ['sessions.describe', { key: customKey, agentId: 'research' }],
      ['sessions.describe', { key: customKey, agentId: 'research' }],
    ]);
  });

  it.each(['hasActiveRun', 'hasActiveSubagentRun'])('blocks native running or queued activity: %s', async field => {
    const f = fixture();
    f.request.mockResolvedValue({ session: { ...f.native, [field]: true } });
    await expect(f.read()).resolves.toMatchObject({ known: true, running: true,
      mainRunning: field === 'hasActiveRun', subagentRunning: field === 'hasActiveSubagentRun' });
  });

  it.each([
    undefined, {}, { session: undefined }, { session: { sessionId: 'native-id', hasActiveRun: false } },
    { session: { key, sessionId: 'native-id' } },
    { session: { key, sessionId: 'native-id', hasActiveRun: 'false' } },
    { session: { key, sessionId: 'native-id', hasActiveRun: false, hasActiveSubagentRun: 'false' } },
    { session: { key: 'foreign', sessionId: 'native-id', hasActiveRun: false } },
    { session: { key, agentId: 'foreign', sessionId: 'native-id', hasActiveRun: false } },
  ])('cannot turn a malformed or foreign response into idle: %j', async result => {
    const f = fixture(); f.request.mockResolvedValue(result);
    await expect(f.read()).resolves.toEqual(unknown);
  });

  it('admits only explicit native absence for an unbound new product identity', async () => {
    const f = fixture(); f.request.mockResolvedValue({ session: null });
    await expect(f.read()).resolves.toEqual(idle);
    await expect(f.read('expected-native')).resolves.toEqual(unknown);
    f.source().nativeSessionKey = key;
    await expect(f.read()).resolves.toEqual(unknown);
    delete f.source().nativeSessionKey;
    f.source().historyBinding = { nativeSessionId: 'historical' } as CoworkSession['historyBinding'];
    await expect(f.read()).resolves.toEqual(unknown);
  });

  it('keeps errors and connection-readiness failure unknown without retry', async () => {
    const f = fixture(); f.request.mockRejectedValue(new Error('UNAVAILABLE'));
    await expect(f.read()).resolves.toEqual(unknown);
    expect(f.request).toHaveBeenCalledOnce();
    f.context.ensureGatewayClientReady = vi.fn().mockRejectedValue(new Error('connection unavailable'));
    await expect(f.read()).resolves.toEqual(unknown);
    expect(f.request).toHaveBeenCalledOnce();
  });

  it.each(['receipt', 'fork', 'handoff', 'parent', 'branch', 'running', 'failed'])(
    'does not treat an absent historical %s source as a fresh reservation', async kind => {
      const f = fixture(); f.request.mockResolvedValue({ session: null });
      if (kind === 'receipt') f.context.store.getSessionRuns = vi.fn().mockReturnValue([{ state: 'failed' }]);
      if (kind === 'fork') f.source().forkSource = { entryId: 'entry', title: 'fork' };
      if (kind === 'handoff') f.source().handoffSource = {} as CoworkSession['handoffSource'];
      if (kind === 'parent') f.source().nativeParentSessionId = 'parent';
      if (kind === 'branch') f.source().branchCreationPending = true;
      if (kind === 'running') f.source().status = 'running';
      if (kind === 'failed') f.source().status = 'error';
      await expect(f.read()).resolves.toEqual(unknown);
    },
  );

  it.each(['unknown', 'disconnected', 'recovery'])('retains local unconfirmed custody: %s', async kind => {
    const f = fixture();
    if (kind === 'unknown') (f.context.unknownSessionRuns as Map<string, unknown>).set(productId, {});
    if (kind === 'disconnected') f.context.disconnectedSessionIds.add(productId);
    if (kind === 'recovery') f.context.disconnectedRecoveryPromises.set(productId, Promise.resolve());
    await expect(f.read()).resolves.toEqual(unknown);
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each(['active', 'compaction', 'goal'])('retains local active admission: %s', async kind => {
    const f = fixture();
    if (kind === 'active') f.state.active = true;
    if (kind === 'compaction') f.context.compactionInFlightSessionIds.add(productId);
    if (kind === 'goal') f.state.goalPhase = GoalExecutionPhase.Continuing;
    await expect(f.read()).resolves.toMatchObject({ known: true, running: true });
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each(['connection', 'generation', 'source', 'deleted'])('rejects a late result after %s changes', async kind => {
    const f = fixture(); let finish!: (value: unknown) => void;
    f.request.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const reading = f.read('native-id', 'native-revision');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    if (kind === 'connection') f.context.gatewayClient = { request: vi.fn() } as RuntimeSessionStatusContext['gatewayClient'];
    if (kind === 'generation') f.context.gatewayClientGeneration += 1;
    if (kind === 'source') f.source().cwd = '/changed';
    if (kind === 'deleted') f.setSource(null);
    finish({ session: f.native });
    await expect(reading).resolves.toEqual(unknown);
  });

  it('does not let unrelated global publication retire a current scoped response', async () => {
    const f = fixture(); let finish!: (value: unknown) => void;
    f.request.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const reading = f.read('native-id', 'native-revision');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    invalidateRuntimeSessionSnapshot.call(f.context);
    invalidateTargetedSessionStatusChecks(f.context.targetedSessionStatusChecks, { key: 'agent:other:unrelated', controlOwnerSessionKey: null });
    finish({ session: f.native });
    await expect(reading).resolves.toEqual(idle);
  });

  it('keeps exact expected native identity and lifecycle revision', async () => {
    const f = fixture();
    await expect(f.read('rotated-native')).resolves.toEqual(unknown);
    await expect(f.read('native-id', 'rotated-revision')).resolves.toEqual(unknown);
    await expect(f.read('native-id', 'native-revision')).resolves.toEqual(idle);
    await expect(f.read('native-id', null)).resolves.toEqual(unknown);
    f.request.mockResolvedValue({ session: { ...f.native, lifecycleRevision: null } });
    await expect(f.read('native-id', null)).resolves.toEqual(idle);
    for (const lifecycleRevision of [undefined, 0, '']) {
      f.request.mockResolvedValue({ session: { ...f.native, lifecycleRevision } });
      await expect(f.read('native-id', null)).resolves.toEqual(unknown);
    }
  });

  it.each([
    { session: { key: 'grandchild', controlOwnerSessionKey: 'child' } },
    { key: 'grandchild', parentSessionKey: 'child' },
    { session: { key: 'grandchild' }, controlOwnerSessionKey: key },
    { key: 'unknown-lineage' },
    {},
  ])('does not let an unnamed ancestor retain a stale idle response: %j', async event => {
    const f = fixture();
    f.request.mockImplementation(async () => {
      invalidateTargetedSessionStatusChecks(f.context.targetedSessionStatusChecks, event);
      return { session: f.native };
    });
    await expect(f.read('native-id')).resolves.toEqual(unknown);
    expect(f.request).toHaveBeenCalledTimes(2);
  });
});
