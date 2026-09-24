import { expect, test, vi } from 'vitest';

const { sendToRenderer } = vi.hoisted(() => ({ sendToRenderer: vi.fn() }));

vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
    getVersion: () => 'test-version',
  },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: sendToRenderer } }],
  },
}));

vi.mock('../../cowork/coworkLogger', () => ({
  coworkLog: vi.fn(),
}));

import { createDefaultAgentRuntimeSettings } from '../../../shared/openclaw/agentRuntimeSettings';
import {
  ApprovalDecision,
  ApprovalKind,
  ExecApprovalDecision,
  OpenClawApprovalIpc,
} from '../../../shared/openclaw/approvals';
import type { GatewayClientLike, SessionTurn } from '../gateway/types';
import { OpenClawRuntimeAdapter } from './openclawRuntimeAdapter';

function createEmptyStore() {
  const session = {
    id: 'session-1',
    title: 'Test Session',
    status: 'completed',
    pinned: false,
    cwd: process.cwd(),
    executionMode: 'local',
    permissionMode: 'full' as const,
    activeSkillIds: [],
    agentId: 'main',
    modelRef: 'openai/gpt-5',
    messages: [] as Array<Record<string, unknown>>,
    createdAt: 1,
    updatedAt: 1,
  };
  let persistedGoalExecution: Record<string, unknown> | null = null;
  const planHandoffs = new Map<string, Record<string, unknown>>();
  return {
    session,
    planHandoffs,
    store: {
      getAgentRuntimeSettings: () => createDefaultAgentRuntimeSettings(),
      getSession: (sessionId: string) => (sessionId === session.id ? session : null),
      getAgent: () => null,
      updateSession: () => {},
      getSessionRunByClientTurnId: () => undefined,
      listSessions: () => [
        {
          id: session.id,
          title: session.title,
          status: session.status,
          pinned: false,
          groupId: null,
          agentId: 'main',
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        },
      ],
      getGoalExecutionSnapshot: () => persistedGoalExecution,
      setGoalExecutionSnapshot: (snapshot: Record<string, unknown>) => {
        persistedGoalExecution = snapshot;
      },
      clearGoalExecutionSnapshot: () => {
        persistedGoalExecution = null;
      },
      createPlanHandoff: (input: Record<string, unknown>) => {
        const existing = planHandoffs.get(input.planId as string);
        if (existing) return existing;
        const handoff = {
          ...input,
          state: 'presented',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        planHandoffs.set(input.planId as string, handoff);
        return handoff;
      },
      migratePlanHandoffArtifact: (planId: string, artifact: Record<string, unknown>) => {
        const existing = planHandoffs.get(planId);
        if (!existing) throw new Error('Plan handoff not found.');
        const migrated = { ...existing, artifact, updatedAt: Date.now() };
        planHandoffs.set(planId, migrated);
        return migrated;
      },
      getPlanHandoff: (planId: string) => planHandoffs.get(planId),
      listRecoverablePlanHandoffs: () =>
        [...planHandoffs.values()].filter(handoff => handoff.state !== 'resolved'),
      transitionPlanHandoff: (input: Record<string, unknown>) => {
        const existing = planHandoffs.get(input.planId as string);
        if (!existing) throw new Error('Plan handoff not found.');
        const updated = {
          ...existing,
          state: input.nextState,
          ...(input.implementationSessionKey
            ? { implementationSessionKey: input.implementationSessionKey }
            : {}),
          ...(input.implementationGatewaySessionId
            ? { implementationGatewaySessionId: input.implementationGatewaySessionId }
            : {}),
          ...(input.implementationRunId ? { implementationRunId: input.implementationRunId } : {}),
          updatedAt: Date.now(),
        };
        planHandoffs.set(input.planId as string, updated);
        return updated;
      },
    },
  };
}

const createSessionTurn = (overrides: Partial<SessionTurn> = {}): SessionTurn => ({
  sessionId: 'session-1',
  sessionKey: 'agent:main:justdo:session-1',
  runId: 'run-1',
  turnToken: 1,
  stopRequested: false,
  knownRunIds: new Set(['run-1']),
  ...overrides,
});

type SessionPreparationInternals = {
  gatewayClient: GatewayClientLike | null;
  ensureGatewayClientReady: () => Promise<void>;
};

const getSessionPreparationInternals = (
  adapter: OpenClawRuntimeAdapter,
): SessionPreparationInternals => adapter as unknown as SessionPreparationInternals;

type StopTestAdapter = {
  activeTurns: Map<string, SessionTurn>;
  gatewayClient: GatewayClientLike | null;
  goalContinuationCoordinator: { rollbackStop: (sessionId: string) => void };
  ensureGatewayClientReady: () => Promise<void>;
  reconcilePendingApprovals: () => Promise<void>;
  approvalReconciliation: { events: unknown[] } | null;
};

test('prepares the native OpenClaw session root and permission mode', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const workspace = process.cwd();
  const request = vi.fn(async (method: string) => {
    if (method === 'automationPermission.info') {
      return { loaded: true, policyId: 'native-session-automation-permission' };
    }
    return {
      key: 'agent:main:justdo:session-1',
      sessionId: 'gateway-session-1',
      entry: {
        sessionId: 'gateway-session-1',
        permissionMode: 'workspace',
        sessionRoot: workspace,
      },
    };
  });
  const internals = getSessionPreparationInternals(adapter);
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);

  await expect(
    adapter.prepareSession('session-1', {
      permissionMode: 'auto',
      workspaceRoot: workspace,
      agentId: 'main',
    }),
  ).resolves.toEqual({
    sessionKey: 'agent:main:justdo:session-1',
    gatewaySessionId: 'gateway-session-1',
  });

  expect(request).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledWith('sessions.create', {
    key: 'agent:main:justdo:session-1',
    cwd: workspace,
    permissionMode: 'workspace',
  });
});

test('rejects a session response that did not persist the permission mode', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn(async (method: string) => {
    if (method === 'automationPermission.info') {
      return { loaded: true, policyId: 'native-session-automation-permission' };
    }
    return {
      sessionId: 'gateway-session-1',
      entry: {
        sessionId: 'gateway-session-1',
        permissionMode: 'guarded',
        sessionRoot: process.cwd(),
      },
    };
  });
  const internals = getSessionPreparationInternals(adapter);
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);

  await expect(adapter.prepareSession('session-1', { permissionMode: 'full' })).rejects.toThrow(
    'did not persist the requested session permission mode',
  );
});

test('refuses to prepare a turn when the automation permission policy is unavailable', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn().mockRejectedValue(new Error('method not found'));
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    ensureAutomationPermissionPolicyReady: () => Promise<void>;
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };

  await expect(internals.ensureAutomationPermissionPolicyReady()).rejects.toThrow(
    'method not found',
  );
  expect(request).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledWith('automationPermission.info');
});

test.each([
  ['exec.approval.resolved', OpenClawApprovalIpc.Resolved, ApprovalKind.Exec],
  ['plugin.approval.requested', OpenClawApprovalIpc.Requested, ApprovalKind.Plugin],
  ['plugin.approval.resolved', OpenClawApprovalIpc.Resolved, ApprovalKind.Plugin],
] as const)('forwards %s to the typed renderer approval channel', (event, channel, kind) => {
  sendToRenderer.mockClear();
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});

  adapter.handleGatewayEvent({ event, payload: { id: 'approval-1' } });

  return vi.waitFor(() =>
    expect(sendToRenderer).toHaveBeenCalledWith(channel, { id: 'approval-1', kind }),
  );
});

test('forwards unmatched exec approval requests to the renderer', async () => {
  sendToRenderer.mockClear();
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});

  adapter.handleGatewayEvent({
    event: 'exec.approval.requested',
    payload: { id: 'approval-1', request: { command: 'git status' } },
  });

  await vi.waitFor(() =>
    expect(sendToRenderer).toHaveBeenCalledWith(OpenClawApprovalIpc.Requested, {
      id: 'approval-1',
      kind: ApprovalKind.Exec,
      request: { command: 'git status' },
    }),
  );
});

test('does not auto-approve cron-shaped exec or plugin approval requests', async () => {
  sendToRenderer.mockClear();
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn(() => Promise.resolve({}));
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request,
  };

  adapter.handleGatewayEvent({
    event: 'exec.approval.requested',
    payload: {
      id: 'approval-cron-exec',
      request: {
        command: 'npm test',
        agentId: 'main',
        sessionKey: 'agent:main:cron:job-1:run:run-1',
      },
    },
  });
  adapter.handleGatewayEvent({
    event: 'plugin.approval.requested',
    payload: {
      id: 'approval-third-party',
      request: {
        pluginId: 'third-party-plugin',
        title: 'Publish',
        description: 'external side effect',
        agentId: 'main',
        sessionKey: 'agent:main:cron:job-1:run:run-1',
      },
    },
  });

  await vi.waitFor(() => {
    expect(sendToRenderer).toHaveBeenCalledWith(
      OpenClawApprovalIpc.Requested,
      expect.objectContaining({ id: 'approval-cron-exec', kind: ApprovalKind.Exec }),
    );
    expect(sendToRenderer).toHaveBeenCalledWith(
      OpenClawApprovalIpc.Requested,
      expect.objectContaining({ id: 'approval-third-party', kind: ApprovalKind.Plugin }),
    );
  });
  expect(request).not.toHaveBeenCalledWith(
    expect.stringMatching(/approval\.resolve$/),
    expect.anything(),
  );
});

test('reuses an exact command grant only in the approved session', async () => {
  sendToRenderer.mockClear();
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const approvedRequest = {
    id: 'approval-1',
    request: {
      command: 'git status',
      commandArgv: ['git', 'status'],
      cwd: 'E:/workspace/project',
      host: 'gateway',
      agentId: 'main',
      sessionKey: 'agent:main:justdo:session-1',
      security: 'allowlist',
      ask: 'on-miss',
    },
    createdAtMs: 1,
    expiresAtMs: Date.now() + 60_000,
  };
  const request = vi.fn((method: string) => {
    if (method === 'exec.approval.list') return Promise.resolve([approvedRequest]);
    return Promise.resolve({});
  });
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request,
  };
  (
    adapter as unknown as { ensureGatewayClientReady: () => Promise<void> }
  ).ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);

  await adapter.resolveApproval(
    approvedRequest.id,
    ApprovalDecision.AllowForSession,
    ApprovalKind.Exec,
  );
  const repeatedRequest = { ...approvedRequest, id: 'approval-2' };
  adapter.handleGatewayEvent({ event: 'exec.approval.requested', payload: repeatedRequest });

  await vi.waitFor(() =>
    expect(request).toHaveBeenCalledWith('exec.approval.resolve', {
      id: 'approval-2',
      decision: ExecApprovalDecision.AllowOnce,
    }),
  );
  expect(request).not.toHaveBeenCalledWith('exec.approval.resolve', {
    id: expect.any(String),
    decision: ExecApprovalDecision.AllowAlways,
  });
  expect(sendToRenderer).not.toHaveBeenCalled();

  adapter.handleGatewayEvent({
    event: 'exec.approval.requested',
    payload: {
      ...repeatedRequest,
      id: 'approval-3',
      request: {
        ...repeatedRequest.request,
        sessionKey: 'agent:main:justdo:session-2',
      },
    },
  });

  await vi.waitFor(() =>
    expect(sendToRenderer).toHaveBeenCalledWith(
      OpenClawApprovalIpc.Requested,
      expect.objectContaining({ id: 'approval-3', kind: ApprovalKind.Exec }),
    ),
  );

  sendToRenderer.mockClear();
  adapter.handleGatewayEvent({
    event: 'sessions.changed',
    payload: { sessionKey: approvedRequest.request.sessionKey, reason: 'reset' },
  });
  adapter.handleGatewayEvent({
    event: 'exec.approval.requested',
    payload: { ...approvedRequest, id: 'approval-4' },
  });
  await vi.waitFor(() =>
    expect(sendToRenderer).toHaveBeenCalledWith(
      OpenClawApprovalIpc.Requested,
      expect.objectContaining({ id: 'approval-4', kind: ApprovalKind.Exec }),
    ),
  );
});

test('commits a session grant only after Gateway confirms the current request', async () => {
  sendToRenderer.mockClear();
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const approvedRequest = {
    id: 'approval-race-1',
    request: {
      command: 'git status',
      commandArgv: ['git', 'status'],
      sessionKey: 'agent:main:justdo:session-race',
    },
    createdAtMs: 1,
    expiresAtMs: Date.now() + 60_000,
  };
  let confirmResolve: (() => void) | undefined;
  const resolving = new Promise<void>(resolve => {
    confirmResolve = resolve;
  });
  const request = vi.fn((method: string, params?: unknown) => {
    if (method === 'exec.approval.list') return Promise.resolve([approvedRequest]);
    if (
      method === 'exec.approval.resolve' &&
      (params as { id?: string } | undefined)?.id === approvedRequest.id
    ) {
      return resolving;
    }
    return Promise.resolve({});
  });
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request,
  };
  (
    adapter as unknown as { ensureGatewayClientReady: () => Promise<void> }
  ).ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);

  const approving = adapter.resolveApproval(
    approvedRequest.id,
    ApprovalDecision.AllowForSession,
    ApprovalKind.Exec,
  );
  await vi.waitFor(() =>
    expect(request).toHaveBeenCalledWith('exec.approval.resolve', {
      id: approvedRequest.id,
      decision: ExecApprovalDecision.AllowOnce,
    }),
  );
  adapter.handleGatewayEvent({
    event: 'exec.approval.requested',
    payload: { ...approvedRequest, id: 'approval-race-2' },
  });
  await vi.waitFor(() =>
    expect(sendToRenderer).toHaveBeenCalledWith(
      OpenClawApprovalIpc.Requested,
      expect.objectContaining({ id: 'approval-race-2' }),
    ),
  );

  confirmResolve?.();
  await approving;
  sendToRenderer.mockClear();
  adapter.handleGatewayEvent({
    event: 'exec.approval.requested',
    payload: { ...approvedRequest, id: 'approval-race-3' },
  });
  await vi.waitFor(() =>
    expect(request).toHaveBeenCalledWith('exec.approval.resolve', {
      id: 'approval-race-3',
      decision: ExecApprovalDecision.AllowOnce,
    }),
  );
  expect(sendToRenderer).not.toHaveBeenCalled();
});

test.each(['unavailable', 'unresponsive'])(
  'confirms native Stop without waiting for %s task or approval inventories',
  async inventoryState => {
    const { store } = createEmptyStore();
    const adapter = new OpenClawRuntimeAdapter(store, {});
    const internals = adapter as unknown as StopTestAdapter;
    const turn = createSessionTurn();
    internals.activeTurns.set(turn.sessionId, turn);
    const request = vi.fn((method: string) => {
      if (method === 'sessions.abort') return Promise.resolve({ ok: true, status: 'aborted' });
      return inventoryState === 'unavailable'
        ? Promise.reject(new Error('inventory unavailable'))
        : new Promise(() => {});
    });
    internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
    const stopped = vi.fn();
    adapter.on('sessionStopped', stopped);

    const stopping = adapter.stopSession(turn.sessionId);
    expect(request).toHaveBeenCalledWith('sessions.abort', {
      key: turn.sessionKey,
      clearQueued: true,
    });
    await stopping;

    expect(request.mock.calls.filter(([method]) => method === 'sessions.abort')).toHaveLength(1);
    expect(
      request.mock.calls.some(([method]) =>
        ['tasks.list', 'sessions.list', 'exec.approval.list', 'plugin.approval.list'].includes(
          method,
        ),
      ),
    ).toBe(false);
    expect(stopped).toHaveBeenCalledWith(turn.sessionId);
    expect(internals.activeTurns.has(turn.sessionId)).toBe(false);
  },
);

test('broadcasts an authoritative pending approval snapshot during reconciliation', async () => {
  sendToRenderer.mockClear();
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const internals = adapter as unknown as StopTestAdapter;
  const approval = {
    id: 'approval-snapshot',
    request: { command: 'git status', sessionKey: 'agent:main:justdo:session-1' },
    createdAtMs: 1,
    expiresAtMs: Number.MAX_SAFE_INTEGER,
  };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  internals.gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request: vi.fn((method: string) => {
      if (method === 'exec.approval.list') return Promise.resolve([approval]);
      if (method === 'plugin.approval.list') return Promise.resolve([]);
      return Promise.resolve({});
    }),
  };

  await internals.reconcilePendingApprovals();

  expect(sendToRenderer).toHaveBeenCalledWith(OpenClawApprovalIpc.Snapshot, [
    { ...approval, kind: ApprovalKind.Exec },
  ]);
  expect(sendToRenderer).not.toHaveBeenCalledWith(OpenClawApprovalIpc.Requested, expect.anything());
});

test('replays an approval requested during reconciliation after the snapshot', async () => {
  sendToRenderer.mockClear();
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const internals = adapter as unknown as StopTestAdapter;
  let resolveExecList: ((requests: unknown[]) => void) | undefined;
  const execList = new Promise<unknown[]>(resolve => {
    resolveExecList = resolve;
  });
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  internals.gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request: vi.fn((method: string) => {
      if (method === 'exec.approval.list') return execList;
      if (method === 'plugin.approval.list') return Promise.resolve([]);
      return Promise.resolve({});
    }),
  };

  const reconciling = internals.reconcilePendingApprovals();
  adapter.handleGatewayEvent({
    event: 'exec.approval.requested',
    payload: {
      id: 'approval-during-list',
      request: { command: 'git status' },
      createdAtMs: 2,
      expiresAtMs: Number.MAX_SAFE_INTEGER,
    },
  });
  await vi.waitFor(() => expect(internals.approvalReconciliation?.events).toHaveLength(1));
  resolveExecList?.([]);
  await reconciling;

  expect(sendToRenderer.mock.calls).toEqual([
    [OpenClawApprovalIpc.Snapshot, []],
    [
      OpenClawApprovalIpc.Requested,
      expect.objectContaining({ id: 'approval-during-list', kind: ApprovalKind.Exec }),
    ],
  ]);
});
