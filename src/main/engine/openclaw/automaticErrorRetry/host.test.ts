import { afterEach, describe, expect, it, vi } from 'vitest';

const { broadcast, assertStorageAdmission } = vi.hoisted(() => ({
  broadcast: vi.fn(),
  assertStorageAdmission: vi.fn(),
}));
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: broadcast } }],
  },
}));
vi.mock('../../../storage/relocationGate', () => ({
  assertStorageExecutionAdmission: assertStorageAdmission,
}));

import { createDefaultAgentRuntimeSettings } from '../../../../shared/agents/agentRuntimeSettings';
import {
  AutomaticErrorRetryDisposition,
  AutomaticErrorRetryIpc,
  AutomaticErrorRetryPhase,
  type AutomaticErrorRetryRunMetadata,
} from '../../../../shared/cowork/automaticErrorRetry';
import type { BeginSessionRunInput, SessionRunState, SessionRunTiming } from '../../../../shared/cowork/sessionRun';
import type { CoworkStore } from '../../../data/coworkStore';
import type { GatewayClientLike, NativeRunTerminalReceipt } from '../../gateway/types';
import { ExecutionSuccessorClaims } from '../executionSuccessorClaims';
import { AutomaticErrorRetryHost } from './host';
import { AUTOMATIC_ERROR_RETRY_RULES, REPEATED_TOOL_ERROR_CODE } from './rules';

const sessionId = 'desktop-session';
const sessionKey = `agent:main:justdo:${sessionId}`;
const nativeSessionId = 'native-session';
const lifecycleRevision = 'revision-one';
const rootRunId = 'desktop-input';
const hosts: AutomaticErrorRetryHost[] = [];
const terminal = (runId = rootRunId, status: NativeRunTerminalReceipt['status'] = 'failed'): NativeRunTerminalReceipt => ({
  runId, sessionKey, sessionId: nativeSessionId, lifecycleGeneration: null,
  clientGeneration: 1, agentSeq: 10, executionSettled: true, status, endedAt: 100,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

function fixture() {
  // Ordinary prepared desktop sessions need not have an imported history binding.
  const session = {
    id: sessionId, agentId: 'main', cwd: 'E:/workspace/task', permissionMode: 'full',
    activeSkillIds: [] as string[],
  };
  const rows = new Map<string, SessionRunTiming>([[rootRunId, {
    id: 'receipt-root', sessionId, clientTurnId: rootRunId, startedAt: 1, state: 'running',
  }]]);
  const native = { key: sessionKey, sessionId: nativeSessionId, lifecycleRevision, activeRunIds: [] as string[] };
  const getSession = vi.fn(() => session);
  const beginSessionRun = vi.fn((input: BeginSessionRunInput) => {
    if ([...rows.values()].some(row => row.state === 'running')) throw new Error('A run is already open');
    const timing: SessionRunTiming = { ...input, id: `receipt-${input.clientTurnId}`, state: 'running' };
    rows.set(input.clientTurnId, timing);
    return timing;
  });
  const finishSessionRun = vi.fn((id: string, state: SessionRunState, endedAt: number) => {
    for (const [key, row] of rows) {
      if (row.id === id) rows.set(key, { ...row, state, endedAt });
    }
  });
  const setSessionRunAutomaticErrorRetry = vi.fn((clientTurnId: string, metadata: AutomaticErrorRetryRunMetadata) => {
    const row = rows.get(clientTurnId);
    if (row) rows.set(clientTurnId, { ...row, automaticErrorRetry: metadata });
  });
  const store = {
    getSession,
    getAgentRuntimeSettings: () => createDefaultAgentRuntimeSettings(),
    getLatestSessionRun: () => [...rows.values()].at(-1),
    getSessionRunByClientTurnId: (clientTurnId: string) => rows.get(clientTurnId),
    beginSessionRun, finishSessionRun, setSessionRunAutomaticErrorRetry,
  };
  const request = vi.fn(async (method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (method === 'sessions.describe') return { session: native };
    if (method === 'runtimeServices.executionFailure') return {
      sessionKey, sessionId: nativeSessionId, lifecycleRevision, runId: params?.runId,
      errorCode: REPEATED_TOOL_ERROR_CODE,
    };
    if (method === 'agent') return { runId: params?.idempotencyKey, status: 'accepted' };
    throw new Error(`Unexpected method ${method}`);
  });
  let client = { request } as unknown as GatewayClientLike;
  let generation = 1;
  let blocked = false;
  const prepare = vi.fn(async () => {});
  const beforeSuccessor = vi.fn();
  const beginRun = vi.fn();
  const confirmed = vi.fn();
  const rejected = vi.fn();
  const unknown = vi.fn();
  const adoptTechnicalRun = vi.fn(() => true);
  const unclaimed = vi.fn();
  const onPresentation = vi.fn();
  const claims = new ExecutionSuccessorClaims();
  const host = new AutomaticErrorRetryHost({
    store: store as unknown as CoworkStore,
    successorClaims: claims,
    getClient: () => client,
    getGeneration: () => generation,
    sessionKey: () => sessionKey,
    isBlocked: () => blocked,
    prepare, beforeSuccessor, beginRun, confirmed, rejected, unknown,
    adoptTechnicalRun, unclaimed, onPresentation,
    isResponseError: error => Boolean(error && typeof error === 'object' && 'gatewayCode' in error),
  });
  hosts.push(host);
  return {
    host, claims, session, rows, native, request, prepare, beforeSuccessor, beginRun,
    confirmed, rejected, unknown, adoptTechnicalRun, unclaimed, onPresentation,
    beginSessionRun, finishSessionRun, setSessionRunAutomaticErrorRetry,
    replaceClient: () => { client = { request } as unknown as GatewayClientLike; },
    nextGeneration: () => { generation += 1; },
    block: () => { blocked = true; },
    arm: () => host.arm(sessionId, rootRunId, nativeSessionId),
    agentCalls: () => request.mock.calls.filter(([method]) => method === 'agent'),
  };
}

afterEach(() => {
  for (const host of hosts.splice(0)) host.clear();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('automatic error retry host transport', () => {
  it('shares the injected predecessor claim with an independent execution policy', async () => {
    const f = fixture();
    f.claims.claim(rootRunId, 'goal-successor');
    await f.arm();
    expect(f.host.coordinator.observeSettled(terminal())).toBe(false);
    expect(f.claims.isCurrent(rootRunId, 'goal-successor')).toBe(true);
    expect(f.agentCalls()).toHaveLength(0);
  });

  it('arms an ordinary prepared session without an imported history binding before native dispatch', async () => {
    const f = fixture();
    await f.arm();

    expect(f.host.coordinator.getPresentation(sessionId)).toMatchObject({
      phase: AutomaticErrorRetryPhase.Eligible, attempt: 0, maxContinuations: 1,
      runs: [expect.objectContaining({ runId: rootRunId, nativeSessionId, lifecycleRevision })],
    });
    expect(f.rows.get(rootRunId)?.automaticErrorRetry?.disposition).toBe(AutomaticErrorRetryDisposition.Candidate);
    expect(broadcast).toHaveBeenCalledWith(AutomaticErrorRetryIpc.Changed, expect.objectContaining({ sessionId }));
    expect(f.agentCalls()).toHaveLength(0);
  });

  it('sends only fixed internal feedback with the same native identity and one idempotency key', async () => {
    const f = fixture();
    await f.arm();
    f.host.coordinator.observeSettled(terminal());
    await vi.waitFor(() => expect(f.confirmed).toHaveBeenCalledOnce());

    const params = f.agentCalls()[0]![1]!;
    expect(params).toEqual({
      sessionKey,
      expectedExistingSessionId: nativeSessionId,
      expectedExistingSessionLifecycleRevision: lifecycleRevision,
      agentId: 'main',
      message: AUTOMATIC_ERROR_RETRY_RULES[0]!.fixedPrompt,
      inputProvenance: { kind: 'internal_system', sourceTool: 'execution-error-retry' },
      deliver: false, suppressPromptPersistence: true, idempotencyKey: expect.any(String),
    });
    expect(params.idempotencyKey).not.toBe(rootRunId);
    expect(f.beginRun).toHaveBeenCalledWith(sessionId, expect.objectContaining({
      nativeSessionId, lifecycleRevision,
    }), params.idempotencyKey);
    expect(f.rows.get(rootRunId)?.state).toBe('failed');
    expect(f.rows.get(params.idempotencyKey as string)?.automaticErrorRetry).toMatchObject({
      predecessorRunId: rootRunId, attempt: 1,
    });
    expect(f.host.coordinator.observeSettled(terminal())).toBe(true);
    expect(f.agentCalls()).toHaveLength(1);
  });

  it('does not send when the business owner refuses technical adoption', async () => {
    const f = fixture();
    await f.arm();
    f.adoptTechnicalRun.mockReturnValue(false);

    f.host.coordinator.observeSettled(terminal());
    await vi.waitFor(() => expect(f.unclaimed).toHaveBeenCalledExactlyOnceWith(terminal()));

    expect(f.agentCalls()).toHaveLength(0);
    expect(f.beginRun).not.toHaveBeenCalled();
    expect(f.rejected).toHaveBeenCalledWith(sessionId, expect.any(String), rootRunId);
    expect([...f.rows.values()].every(row => row.state === 'failed')).toBe(true);
  });

  it('returns a structured preaccept rejection to the original native terminal without another send', async () => {
    const f = fixture();
    await f.arm();
    const normalRequest = f.request.getMockImplementation()!;
    f.request.mockImplementation((method, params) => method === 'agent'
      ? Promise.reject(Object.assign(new Error('native admission refused'), { gatewayCode: 'INVALID_REQUEST' }))
      : normalRequest(method, params));

    f.host.coordinator.observeSettled(terminal());
    await vi.waitFor(() => expect(f.unclaimed).toHaveBeenCalledOnce());

    expect(f.rejected).toHaveBeenCalledWith(sessionId, f.agentCalls()[0]![1]!.idempotencyKey, rootRunId);
    expect(f.unknown).not.toHaveBeenCalled();
    expect(f.host.coordinator.getPresentation(sessionId)).toMatchObject({ phase: AutomaticErrorRetryPhase.Failed, attempt: 1 });
    expect(f.claims.isCurrent(rootRunId, sessionId)).toBe(false);
    expect(f.agentCalls()).toHaveLength(1);
  });

  it.each([
    Object.assign(new Error('service unavailable after send'), { gatewayCode: 'UNAVAILABLE' }),
    Object.assign(new Error('request timeout after send'), { requestSent: true }),
  ])('keeps %s unknown and never resends the same predecessor', async error => {
    const f = fixture();
    await f.arm();
    const normalRequest = f.request.getMockImplementation()!;
    f.request.mockImplementation((method, params) => method === 'agent'
      ? Promise.reject(error) : normalRequest(method, params));

    f.host.coordinator.observeSettled(terminal());
    await vi.waitFor(() => expect(f.unknown).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(f.host.coordinator.getPresentation(sessionId)?.phase).toBe(AutomaticErrorRetryPhase.Unknown));
    f.host.coordinator.observeSettled(terminal());

    expect(f.rejected).not.toHaveBeenCalled();
    expect(f.unclaimed).not.toHaveBeenCalled();
    expect(f.claims.isCurrent(rootRunId, sessionId)).toBe(true);
    expect(f.agentCalls()).toHaveLength(1);
    expect(f.host.coordinator.getPresentation(sessionId)?.attempt).toBe(1);
  });

  it.each(['stop', 'workspace', 'client', 'generation'] as const)(
    'does not send when %s changes during asynchronous permission preparation', async boundary => {
      const f = fixture();
      await f.arm();
      const preparation = deferred<void>();
      f.prepare.mockReturnValue(preparation.promise);
      f.host.coordinator.observeSettled(terminal());
      await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledOnce());
      if (boundary === 'stop') f.host.cancel(sessionId);
      else if (boundary === 'workspace') f.session.cwd = 'E:/workspace/new-task';
      else if (boundary === 'client') f.replaceClient();
      else f.nextGeneration();
      preparation.resolve();
      await vi.waitFor(() => expect(f.rejected).toHaveBeenCalledOnce());

      expect(f.agentCalls()).toHaveLength(0);
      expect(f.beforeSuccessor).not.toHaveBeenCalled();
      expect(f.host.coordinator.getPresentation(sessionId)?.phase).toBe(AutomaticErrorRetryPhase.Cancelled);
    },
  );

  it.each(['toolsAllow', 'inheritedToolDeny'] as const)(
    'refuses a fresh delegated %s scope that appears after arming', async capability => {
      const f = fixture();
      await f.arm();
      Object.assign(f.native, { [capability]: ['exec'] });

      f.host.coordinator.observeSettled(terminal());
      await vi.waitFor(() => expect(f.unclaimed).toHaveBeenCalledExactlyOnceWith(terminal()));

      expect(f.agentCalls()).toHaveLength(0);
      expect(f.beforeSuccessor).not.toHaveBeenCalled();
      expect(f.beginRun).not.toHaveBeenCalled();
      expect(f.host.coordinator.getPresentation(sessionId)?.phase).toBe(AutomaticErrorRetryPhase.Failed);
    },
  );

  it.each(['client', 'generation', 'workspace'] as const)(
    'does not reopen ownership when an accepted ACK arrives after %s changes', async boundary => {
      const f = fixture();
      await f.arm();
      const ack = deferred<Record<string, unknown>>();
      const normalRequest = f.request.getMockImplementation()!;
      f.request.mockImplementation((method, params) => method === 'agent'
        ? ack.promise : normalRequest(method, params));
      f.host.coordinator.observeSettled(terminal());
      await vi.waitFor(() => expect(f.agentCalls()).toHaveLength(1));
      const retryRunId = f.agentCalls()[0]![1]!.idempotencyKey as string;
      if (boundary === 'client') f.replaceClient();
      else if (boundary === 'generation') f.nextGeneration();
      else f.session.cwd = 'E:/workspace/replacement';

      ack.resolve({ runId: retryRunId, status: 'accepted' });
      await vi.waitFor(() => expect(f.host.coordinator.getPresentation(sessionId)?.phase)
        .toBe(AutomaticErrorRetryPhase.Cancelled));

      expect(f.confirmed).not.toHaveBeenCalled();
      expect(f.unknown).not.toHaveBeenCalled();
      expect(f.rejected).not.toHaveBeenCalled();
      expect(f.unclaimed).not.toHaveBeenCalled();
      expect(f.beginRun).toHaveBeenCalledOnce();
      expect(f.rows.get(retryRunId)?.state).toBe('running');
      expect(f.claims.isCurrent(rootRunId, sessionId)).toBe(true);
      expect(f.agentCalls()).toHaveLength(1);
    },
  );

  it('preserves a real fast successor terminal that arrives before the native acknowledgement', async () => {
    const f = fixture();
    await f.arm();
    const ack = deferred<Record<string, unknown>>();
    const normalRequest = f.request.getMockImplementation()!;
    f.request.mockImplementation((method, params) => method === 'agent'
      ? ack.promise : normalRequest(method, params));
    f.host.coordinator.observeSettled(terminal());
    await vi.waitFor(() => expect(f.agentCalls()).toHaveLength(1));
    const retryRunId = f.agentCalls()[0]![1]!.idempotencyKey as string;
    f.finishSessionRun(f.rows.get(retryRunId)!.id, 'completed', 200);

    expect(f.host.coordinator.observeSettled(terminal(retryRunId, 'completed'))).toBe(false);
    ack.resolve({ runId: retryRunId, status: 'accepted' });
    await vi.waitFor(() => expect(f.confirmed).toHaveBeenCalledWith(sessionId, retryRunId));

    expect(f.host.coordinator.getPresentation(sessionId)?.phase).toBe(AutomaticErrorRetryPhase.Completed);
    expect(f.rows.get(retryRunId)?.state).toBe('completed');
    expect(f.beginSessionRun).toHaveBeenCalledOnce();
    expect(f.agentCalls()).toHaveLength(1);
    expect(f.claims.isCurrent(rootRunId, sessionId)).toBe(false);
  });
});
