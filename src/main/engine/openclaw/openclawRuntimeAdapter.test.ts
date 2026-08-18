import { expect, test, vi } from 'vitest';

const { sendToRenderer } = vi.hoisted(() => ({ sendToRenderer: vi.fn() }));

vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
    getVersion: () => 'test-version',
  },
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send: sendToRenderer } },
    ],
  },
}));

vi.mock('../../cowork/coworkLogger', () => ({
  coworkLog: vi.fn(),
}));

import {
  ApprovalDecision,
  ApprovalKind,
  ExecApprovalDecision,
  OpenClawApprovalIpc,
} from '../../../shared/openclaw/approvals';
import type { GatewayClientCtor, GatewayClientLike, SessionTurn } from '../gateway/types';
import { ensureSlashCommandSession, OpenClawRuntimeAdapter } from './openclawRuntimeAdapter';

function createEmptyStore() {
  const session = {
    id: 'session-1',
    title: 'Test Session',
    status: 'completed',
    pinned: false,
    cwd: '',
    executionMode: 'local',
    activeSkillIds: [],
    messages: [] as Array<Record<string, unknown>>,
    createdAt: 1,
    updatedAt: 1,
  };
  let nextId = 1;
  let persistedGoalExecution: Record<string, unknown> | null = null;

  return {
    session,
    store: {
      getSession: (sessionId: string) => (sessionId === session.id ? session : null),
      getAgent: () => null,
      addMessage: (sessionId: string, message: Record<string, unknown>) => {
        expect(sessionId).toBe(session.id);
        const created = {
          id: `msg-${nextId++}`,
          timestamp: nextId,
          metadata: {},
          ...message,
        };
        session.messages.push(created);
        return created;
      },
      updateMessage: (sessionId: string, messageId: string, updates: Record<string, unknown>) => {
        expect(sessionId).toBe(session.id);
        const index = session.messages.findIndex(m => m.id === messageId);
        if (index !== -1) {
          session.messages[index] = {
            ...session.messages[index],
            ...updates,
            metadata: {
              ...((session.messages[index].metadata as Record<string, unknown>) ?? {}),
              ...((updates.metadata as Record<string, unknown>) ?? {}),
            },
          };
        }
        return index !== -1;
      },
      updateSession: () => {},
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
      deleteMessage: () => true,
      replaceConversationMessages: () => {},
      getGoalExecutionSnapshot: () => persistedGoalExecution,
      setGoalExecutionSnapshot: (snapshot: Record<string, unknown>) => {
        persistedGoalExecution = snapshot;
      },
      clearGoalExecutionSnapshot: () => {
        persistedGoalExecution = null;
      },
    },
  };
}

const createSessionTurn = (overrides: Partial<SessionTurn> = {}): SessionTurn => ({
  sessionId: 'session-1',
  sessionKey: 'agent:main:justdo:session-1',
  runId: 'run-1',
  turnToken: 1,
  chatStream: '',
  agentAssistantStreamSeen: false,
  committedAssistantSegments: [],
  toolStreamById: new Map(),
  toolStreamOrder: [],
  chatToolMessages: [],
  chatStreamSegments: [],
  thinkingContent: '',
  thinkingMessageId: null,
  stopRequested: false,
  assistantMessageId: null,
  modelName: 'test-model',
  knownRunIds: new Set(['run-1']),
  ...overrides,
});

test('keeps a managed parent turn alive during an incremental-join refill gap', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const turn = createSessionTurn();
  const collectRunningSubagentSessionKeys = vi
    .fn()
    .mockResolvedValue([]);
  const startTurnTimeoutWatchdog = vi.fn();
  const internals = adapter as unknown as {
    activeTurns: Map<string, SessionTurn>;
    gatewayClient: GatewayClientLike | null;
    collectRunningSubagentSessionKeys: typeof collectRunningSubagentSessionKeys;
    startTurnTimeoutWatchdog: typeof startTurnTimeoutWatchdog;
    handleTurnTimeoutWatchdog: (sessionId: string, turn: SessionTurn) => Promise<void>;
  };
  internals.activeTurns.set(turn.sessionId, turn);
  internals.gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request: vi.fn(),
  };
  internals.collectRunningSubagentSessionKeys = collectRunningSubagentSessionKeys;
  internals.startTurnTimeoutWatchdog = startTurnTimeoutWatchdog;

  await internals.handleTurnTimeoutWatchdog(turn.sessionId, turn);

  expect(collectRunningSubagentSessionKeys).toHaveBeenCalledWith(internals.gatewayClient, [
    turn.sessionKey,
  ]);
  expect(startTurnTimeoutWatchdog).toHaveBeenCalledWith(turn.sessionId);
  expect(internals.activeTurns.get(turn.sessionId)).toBe(turn);
});

test('keeps a managed parent turn alive when watchdog subagent inspection fails', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const turn = createSessionTurn();
  const collectRunningSubagentSessionKeys = vi.fn().mockRejectedValue(new Error('offline'));
  const startTurnTimeoutWatchdog = vi.fn();
  const internals = adapter as unknown as {
    activeTurns: Map<string, SessionTurn>;
    gatewayClient: GatewayClientLike | null;
    collectRunningSubagentSessionKeys: typeof collectRunningSubagentSessionKeys;
    startTurnTimeoutWatchdog: typeof startTurnTimeoutWatchdog;
    handleTurnTimeoutWatchdog: (sessionId: string, turn: SessionTurn) => Promise<void>;
  };
  internals.activeTurns.set(turn.sessionId, turn);
  internals.gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request: vi.fn(),
  };
  internals.collectRunningSubagentSessionKeys = collectRunningSubagentSessionKeys;
  internals.startTurnTimeoutWatchdog = startTurnTimeoutWatchdog;

  await internals.handleTurnTimeoutWatchdog(turn.sessionId, turn);

  expect(startTurnTimeoutWatchdog).toHaveBeenCalledWith(turn.sessionId);
  expect(internals.activeTurns.get(turn.sessionId)).toBe(turn);
});

test('resolves the Gateway session ID used by title generation', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn().mockResolvedValue({
    sessions: [
      {
        key: 'agent:main:justdo:session-1',
        sessionId: 'gateway-session-123',
      },
    ],
  });
  const internals = adapter as unknown as {
    ensureGatewayClientReady: () => Promise<void>;
    gatewayClient: GatewayClientLike | null;
    resolveGatewaySessionIdForTitle: (sessionId: string) => Promise<string | undefined>;
  };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  internals.gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request,
  };

  await expect(internals.resolveGatewaySessionIdForTitle('session-1')).resolves.toBe(
    'gateway-session-123',
  );
  expect(request).toHaveBeenCalledWith('sessions.list', { limit: 500 });
});

test('continues a goal with the canonical key that actually owns it', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const canonicalKey = 'agent:legacy:justdo:session-1';
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    expect(method).toBe('sessions.describe');
    if (params.key !== canonicalKey) return { session: null };
    return {
      session: {
        key: canonicalKey,
        goal: {
          schemaVersion: 1,
          id: 'goal-1',
          objective: 'Ship the release',
          status: 'active',
          createdAt: 1,
          updatedAt: 1,
          tokenStart: 0,
          tokensUsed: 0,
          continuationTurns: 0,
        },
      },
    };
  });
  const continueGoal = vi.fn().mockResolvedValue({
    sessionId: 'session-1',
    goalId: 'goal-1',
    phase: 'running',
    continuationCount: 1,
    updatedAt: 1,
  });
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    sessionIdBySessionKey: Map<string, string>;
    goalContinuationCoordinator: { continue: typeof continueGoal };
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.sessionIdBySessionKey.set(canonicalKey, 'session-1');
  internals.goalContinuationCoordinator.continue = continueGoal;

  await adapter.continueGoal('session-1');

  expect(continueGoal).toHaveBeenCalledWith('session-1', canonicalKey);
});

test('returns raw gateway history without projecting message fields', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const messages = [
    {
      role: 'assistant',
      model: 'hdp/MiniMax-M2.7',
      content: [
        { type: 'thinking', thinking: 'Inspect first.' },
        { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'result.txt' } },
      ],
      futureGatewayField: { retained: true },
    },
  ];
  const request = vi.fn().mockResolvedValue({ messages });
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request,
  };

  await expect(
    adapter.fetchSessionHistoryByKey('agent:main:cron:job-1:run:1'),
  ).resolves.toEqual({
    sessionKey: 'agent:main:cron:job-1:run:1',
    messages,
  });
});

test('resolves a persisted session by gateway session ID when its run key has no history', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn((method: string, params: Record<string, unknown>) => {
    if (method === 'chat.history' && params.sessionKey === 'agent:main:cron:job-1:run:1') {
      return Promise.resolve({ messages: [] });
    }
    if (method === 'sessions.resolve') {
      return Promise.resolve({ ok: true, key: 'agent:main:cron:job-1:run:canonical' });
    }
    if (method === 'chat.history') {
      return Promise.resolve({
        messages: [{ role: 'assistant', content: 'completed result' }],
      });
    }
    return Promise.resolve({});
  });
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request,
  };

  const session = await adapter.fetchSessionByKey(
    'agent:main:cron:job-1:run:1',
    'gateway-session-1',
  );

  expect(request).toHaveBeenCalledWith('sessions.resolve', {
    sessionId: 'gateway-session-1',
    allowMissing: true,
    includeUnknown: true,
  });
  expect(session?.messages).toEqual([
    expect.objectContaining({ type: 'assistant', content: 'completed result' }),
  ]);
  expect(session?.permissionMode).toBe('full');
});

test('falls back to raw persisted messages when display history is empty', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn((method: string) => {
    if (method === 'chat.history') return Promise.resolve({ messages: [] });
    if (method === 'sessions.get') {
      return Promise.resolve({
        messages: [
          {
            role: 'assistant',
            model: 'hdp/MiniMax-M2.7',
            content: [
              { type: 'thinking', thinking: 'stored thinking' },
              {
                type: 'toolCall',
                id: 'call-1',
                name: 'read',
                arguments: { path: 'result.txt' },
              },
            ],
          },
          {
            role: 'toolResult',
            toolCallId: 'call-1',
            toolName: 'read',
            content: 'stored result',
          },
          {
            role: 'assistant',
            model: 'hdp/MiniMax-M2.7',
            content: [{ type: 'text', text: 'final answer' }],
          },
        ],
      });
    }
    return Promise.resolve({});
  });
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request,
  };

  const session = await adapter.fetchSessionByKey('agent:main:cron:job-1:run:1');

  expect(request).toHaveBeenCalledWith('sessions.get', {
    key: 'agent:main:cron:job-1:run:1',
    limit: expect.any(Number),
  });
  expect(session?.messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'assistant',
        thinkingContent: 'stored thinking',
        modelName: 'hdp/MiniMax-M2.7',
      }),
      expect.objectContaining({
        type: 'tool_use',
        metadata: expect.objectContaining({
          toolName: 'read',
          toolInput: { path: 'result.txt' },
          toolUseId: 'call-1',
        }),
      }),
      expect.objectContaining({
        type: 'tool_result',
        metadata: expect.objectContaining({
          toolName: 'read',
          toolUseId: 'call-1',
          toolResult: 'stored result',
        }),
      }),
      expect.objectContaining({
        type: 'assistant',
        content: 'final answer',
        modelName: 'hdp/MiniMax-M2.7',
      }),
    ]),
  );
});

type StopTestAdapter = {
  activeTurns: Map<string, SessionTurn>;
  gatewayClient: GatewayClientLike | null;
  goalContinuationCoordinator: { rollbackStop: (sessionId: string) => void };
  ensureGatewayClientReady: () => Promise<void>;
  reconcilePendingApprovals: () => Promise<void>;
  approvalReconciliation: { events: unknown[] } | null;
};

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

test('waits for Gateway confirmation before clearing a stopped session', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const internals = adapter as unknown as StopTestAdapter;
  const turn = createSessionTurn();
  internals.activeTurns.set(turn.sessionId, turn);

  let confirmAbort: ((value: Record<string, unknown>) => void) | undefined;
  const abortResponse = new Promise<Record<string, unknown>>(resolve => {
    confirmAbort = resolve;
  });
  const request = vi.fn((method: string) => {
    if (method === 'sessions.list') return Promise.resolve({ sessions: [] });
    if (method === 'sessions.abort') return abortResponse;
    return Promise.resolve({});
  });
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };

  const stopping = adapter.stopSession(turn.sessionId);
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith('sessions.abort', {
    key: turn.sessionKey,
    runId: turn.runId,
  }));
  expect(internals.activeTurns.get(turn.sessionId)).toBe(turn);

  confirmAbort?.({ ok: true, status: 'aborted', abortedRunId: turn.runId });
  await stopping;

  expect(internals.activeTurns.has(turn.sessionId)).toBe(false);
});

test('denies only approvals belonging to a stopped session after abort confirmation', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const internals = adapter as unknown as StopTestAdapter;
  const turn = createSessionTurn();
  internals.activeTurns.set(turn.sessionId, turn);
  let execTargetPending = true;
  let pluginTargetPending = true;
  const request = vi.fn((method: string) => {
    if (method === 'sessions.list') return Promise.resolve({ sessions: [] });
    if (method === 'sessions.abort') return Promise.resolve({ ok: true, status: 'aborted' });
    if (method === 'exec.approval.list') {
      return Promise.resolve([
        ...(execTargetPending
          ? [{
              id: 'exec-target',
              request: { command: 'npm test', sessionKey: turn.sessionKey },
              createdAtMs: 1,
              expiresAtMs: Number.MAX_SAFE_INTEGER,
            }]
          : []),
        {
          id: 'exec-other',
          request: { command: 'npm run build', sessionKey: 'agent:main:justdo:session-2' },
          createdAtMs: 2,
          expiresAtMs: Number.MAX_SAFE_INTEGER,
        },
      ]);
    }
    if (method === 'plugin.approval.list') {
      return Promise.resolve(pluginTargetPending ? [
        {
          id: 'plugin-target',
          request: {
            title: 'Write',
            description: 'write a file',
            sessionKey: turn.sessionKey,
          },
          createdAtMs: 3,
          expiresAtMs: Number.MAX_SAFE_INTEGER,
        },
      ] : []);
    }
    if (method === 'exec.approval.resolve') {
      execTargetPending = false;
      return Promise.reject(new Error('approval already resolved'));
    }
    if (method === 'plugin.approval.resolve') pluginTargetPending = false;
    return Promise.resolve({});
  });
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };

  await adapter.stopSession(turn.sessionId);

  expect(request).toHaveBeenCalledWith('exec.approval.resolve', {
    id: 'exec-target',
    decision: 'deny-justdo-stop',
  });
  expect(request).toHaveBeenCalledWith('plugin.approval.resolve', {
    id: 'plugin-target',
    decision: ExecApprovalDecision.Deny,
  });
  expect(request).not.toHaveBeenCalledWith(
    'exec.approval.resolve',
    expect.objectContaining({ id: 'exec-other' }),
  );
  const methods = request.mock.calls.map(([method]) => method);
  expect(methods.indexOf('sessions.abort')).toBeLessThan(methods.indexOf('exec.approval.list'));
});

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
  expect(sendToRenderer).not.toHaveBeenCalledWith(
    OpenClawApprovalIpc.Requested,
    expect.anything(),
  );
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

test('preserves local running state when Gateway does not confirm the stop', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const internals = adapter as unknown as StopTestAdapter;
  const turn = createSessionTurn();
  internals.activeTurns.set(turn.sessionId, turn);
  internals.gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request: vi.fn((method: string) => {
      if (method === 'sessions.list') return Promise.resolve({ sessions: [] });
      return Promise.reject(new Error('abort unavailable'));
    }),
  };
  const stopped = vi.fn();
  const rollbackStop = vi.spyOn(internals.goalContinuationCoordinator, 'rollbackStop');
  adapter.on('sessionStopped', stopped);

  await expect(adapter.stopSession(turn.sessionId)).rejects.toThrow('abort unavailable');

  expect(internals.activeTurns.get(turn.sessionId)).toBe(turn);
  expect(turn.stopRequested).toBe(false);
  expect(rollbackStop).toHaveBeenCalledWith(turn.sessionId);
  expect(stopped).not.toHaveBeenCalled();
});

test('stops a recovered active descendant through an idle child session', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const internals = adapter as unknown as StopTestAdapter;
  const parentKey = 'agent:main:justdo:session-1';
  const childKey = `${parentKey}:subagent:child`;
  const grandchildKey = `${childKey}:subagent:grandchild`;
  const request = vi.fn((method: string, params?: unknown) => {
    const input = params as { spawnedBy?: string };
    if (method === 'sessions.list') {
      if (input.spawnedBy === parentKey) {
        return Promise.resolve({
          sessions: [{ key: childKey, status: 'done', hasActiveRun: false }],
        });
      }
      if (input.spawnedBy === childKey) {
        return Promise.resolve({
          sessions: [{ key: grandchildKey, status: 'done', hasActiveRun: true }],
        });
      }
      return Promise.resolve({ sessions: [] });
    }
    if (method === 'sessions.abort') {
      return Promise.resolve({ ok: true, status: 'aborted', abortedRunId: 'remote-run' });
    }
    return Promise.resolve({});
  });
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };

  await adapter.stopSession('session-1');

  const abortedKeys = request.mock.calls
    .filter(([method]) => method === 'sessions.abort')
    .map(([, params]) => (params as { key: string }).key);
  expect(abortedKeys).toEqual([parentKey, grandchildKey]);
});

test('creates or reuses the OpenClaw session before a goal command', async () => {
  const request = vi.fn().mockResolvedValue({
    sessionId: ' backing-session-1 ',
  });
  const client = {
    start: vi.fn(),
    stop: vi.fn(),
    request,
  } as GatewayClientLike;

  await expect(
    ensureSlashCommandSession(
      client,
      'agent:main:justdo:session-1',
      '/goal build a release dashboard',
    ),
  ).resolves.toBe('backing-session-1');
  expect(request).toHaveBeenCalledWith('sessions.create', {
    key: 'agent:main:justdo:session-1',
  });
});

test('does not prepare an OpenClaw session for an ordinary prompt', async () => {
  const request = vi.fn();
  const client = {
    start: vi.fn(),
    stop: vi.fn(),
    request,
  } as GatewayClientLike;

  await expect(
    ensureSlashCommandSession(client, 'agent:main:justdo:session-1', 'hello'),
  ).resolves.toBeUndefined();
  expect(request).not.toHaveBeenCalled();
});

test('an intentionally stopped gateway client cannot reclaim the active connection', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const stop = vi.fn();
  let clientOptions: Record<string, unknown> | null = null;

  class FakeGatewayClient {
    constructor(options: Record<string, unknown>) {
      clientOptions = options;
    }

    start() {}

    stop() {
      stop();
    }

    async request() {
      return {};
    }
  }

  const connectionAdapter = adapter as unknown as {
    createGatewayClient(connection: {
      url: string;
      token: string;
      version: string;
      clientEntryPath: string;
    }): Promise<void>;
    disconnectGatewayClient(): void;
    gatewayClient: GatewayClientLike | null;
    pendingGatewayClient: GatewayClientLike | null;
    loadGatewayClientCtor: ReturnType<typeof vi.fn>;
  };
  connectionAdapter.loadGatewayClientCtor = vi
    .fn()
    .mockResolvedValue(FakeGatewayClient as unknown as GatewayClientCtor);

  await connectionAdapter.createGatewayClient({
    url: 'ws://127.0.0.1:12345',
    token: 'token',
    version: 'runtime-version',
    clientEntryPath: 'gateway-client.js',
  });

  const onHelloOk = clientOptions?.onHelloOk;
  expect(typeof onHelloOk).toBe('function');
  expect(clientOptions?.deviceIdentity).toBeNull();
  (onHelloOk as () => void)();
  expect(connectionAdapter.gatewayClient).not.toBeNull();
  expect(connectionAdapter.pendingGatewayClient).toBeNull();

  connectionAdapter.disconnectGatewayClient();
  expect(connectionAdapter.gatewayClient).toBeNull();

  (onHelloOk as () => void)();
  expect(connectionAdapter.gatewayClient).toBeNull();
  expect(stop).toHaveBeenCalledTimes(2);
});

test('getSessionKeysForSession prefers channel keys before managed fallback', () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});

  adapter.rememberSessionKey(
    'session-1',
    'agent:main:openai-user:telegram:__default__:2459325231940374',
  );
  adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');

  expect(adapter.getSessionKeysForSession('session-1')).toEqual([
    'agent:main:openai-user:telegram:__default__:2459325231940374',
    'agent:main:justdo:session-1',
  ]);
});

test('getSessionRuntimeStatus only treats the main session as running', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn().mockResolvedValue({
    sessions: [
      {
        key: 'agent:main:justdo:session-1',
        hasActiveRun: false,
        status: 'completed',
        runState: 'idle',
      },
      {
        key: 'agent:main:subagent:child-run',
        hasActiveRun: true,
        status: 'running',
        runState: 'active',
      },
    ],
  });

  adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    request,
  } as unknown as GatewayClientLike;

  await expect(adapter.getSessionRuntimeStatus('session-1')).resolves.toEqual({
    known: true,
    mainRunning: false,
    subagentRunning: false,
    running: false,
  });
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith('sessions.list', {
    limit: 500,
  });
});

test('getSessionRuntimeStatus can include subagent running state on request', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn().mockResolvedValue({
    sessions: [
      {
        key: 'agent:main:justdo:session-1',
        hasActiveRun: false,
        status: 'completed',
        runState: 'idle',
      },
      {
        key: 'agent:main:subagent:child-run',
        spawnedBy: 'agent:main:justdo:session-1',
        hasActiveSubagentRun: true,
        status: 'running',
        subagentRunState: 'active',
      },
    ],
  });

  adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    request,
  } as unknown as GatewayClientLike;

  await expect(
    adapter.getSessionRuntimeStatus('session-1', { includeSubagents: true }),
  ).resolves.toEqual({
    known: true,
    mainRunning: false,
    subagentRunning: true,
    running: true,
  });
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith('sessions.list', { limit: 500 });
});

test('getSessionRuntimeStatuses shares one Gateway snapshot across concurrent callers', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  let resolveRequest: ((value: { sessions: [] }) => void) | undefined;
  const request = vi.fn(
    () =>
      new Promise<{ sessions: [] }>(resolve => {
        resolveRequest = resolve;
      }),
  );
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    request,
  } as unknown as GatewayClientLike;

  const first = adapter.getSessionRuntimeStatus('session-1', { includeSubagents: true });
  const second = adapter.getSessionRuntimeStatus('session-2', { includeSubagents: true });
  expect(request).toHaveBeenCalledTimes(1);
  resolveRequest?.({ sessions: [] });

  await expect(Promise.all([first, second])).resolves.toEqual([
    { known: true, mainRunning: false, subagentRunning: false, running: false },
    { known: true, mainRunning: false, subagentRunning: false, running: false },
  ]);
});

test('getSessionRuntimeStatus can bypass a cached running snapshot after completion', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');
  const request = vi
    .fn()
    .mockResolvedValueOnce({
      sessions: [
        {
          key: 'agent:main:justdo:session-1',
          hasActiveRun: true,
          status: 'running',
        },
      ],
    })
    .mockResolvedValueOnce({
      sessions: [
        {
          key: 'agent:main:justdo:session-1',
          hasActiveRun: false,
          status: 'completed',
        },
      ],
    });
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    request,
  } as unknown as GatewayClientLike;

  await expect(adapter.getSessionRuntimeStatus('session-1')).resolves.toMatchObject({
    running: true,
  });
  await expect(adapter.getSessionRuntimeStatus('session-1')).resolves.toMatchObject({
    running: true,
  });
  await expect(
    adapter.getSessionRuntimeStatus('session-1', { forceRefresh: true }),
  ).resolves.toEqual({
    known: true,
    mainRunning: false,
    subagentRunning: false,
    running: false,
  });
  expect(request).toHaveBeenCalledTimes(2);
});

test('getSessionRuntimeStatus reports unknown when the Gateway snapshot fails', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn().mockRejectedValue(new Error('request timeout'));
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    request,
  } as unknown as GatewayClientLike;

  await expect(adapter.getSessionRuntimeStatus('session-1')).resolves.toEqual({
    known: false,
    mainRunning: false,
    subagentRunning: false,
    running: false,
  });
  expect(request).toHaveBeenCalledTimes(1);
});

test('getSessionRuntimeStatus treats a visible announce stream as locally running', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const visibleRunStreams = (
    adapter as unknown as {
      visibleRunStreams: Map<string, { sessionId: string }>;
    }
  ).visibleRunStreams;
  visibleRunStreams.set('announce:v1:child-run', { sessionId: 'session-1' });

  await expect(adapter.getSessionRuntimeStatus('session-1')).resolves.toEqual({
    known: true,
    mainRunning: true,
    subagentRunning: false,
    running: true,
  });
});

test('resumes a blocked goal through a control run before user input', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  let resumed = false;
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.describe') {
      return {
        session: {
          key: 'agent:main:justdo:session-1',
          goal: {
            schemaVersion: 1,
            id: 'goal-1',
            objective: 'Ship the release',
            status: resumed ? 'active' : 'blocked',
          },
        },
      };
    }
    if (method === 'chat.send') {
      resumed = true;
      return { runId: 'resume-run', status: 'ok' };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const registerControlRun = vi.fn();
  const unregisterControlRun = vi.fn();
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    goalContinuationCoordinator: {
      registerControlRun: typeof registerControlRun;
      unregisterControlRun: (runId: string) => void;
    };
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.goalContinuationCoordinator.registerControlRun = registerControlRun;
  internals.goalContinuationCoordinator.unregisterControlRun = unregisterControlRun;

  await adapter.resumeGoalForUserInput('session-1');

  expect(request).toHaveBeenCalledWith(
    'chat.send',
    expect.objectContaining({ message: '/goal resume', justdoUserInitiated: true }),
  );
  expect(registerControlRun).toHaveBeenCalled();
  expect(request.mock.calls.at(-1)?.[0]).toBe('sessions.describe');
});

test('clears a completed goal before returning its objective for combined feedback', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const goal = (id: string, status: 'complete' | 'active') => ({
    schemaVersion: 1,
    id,
    objective: 'Ship the release',
    status,
    createdAt: 1,
    updatedAt: 1,
    tokenStart: 0,
    tokensUsed: 0,
    continuationTurns: 0,
  });
  let currentGoal: ReturnType<typeof goal> | null = goal('goal-1', 'complete');
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.describe') {
      return {
        session: {
          key: 'agent:main:justdo:session-1',
          goal: currentGoal,
        },
      };
    }
    if (method === 'sessions.goal.clear') {
      currentGoal = null;
      return { ok: true, cleared: true, key: 'agent:main:justdo:session-1' };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const internals = adapter as unknown as { gatewayClient: GatewayClientLike | null };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };

  const [first, concurrent] = await Promise.all([
    adapter.restartCompletedGoalForFeedback('session-1', 'goal-1'),
    adapter.restartCompletedGoalForFeedback('session-1', 'goal-1'),
  ]);

  expect(request).toHaveBeenCalledWith(
    'sessions.goal.clear',
    { key: 'agent:main:justdo:session-1' },
  );
  expect(request.mock.calls.some(([method]) => method === 'chat.send')).toBe(false);
  expect(first).toEqual({ objective: 'Ship the release' });
  expect(concurrent).toEqual(first);
});

test('accepts active metadata while completion is already latched', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  let describeCount = 0;
  let cleared = false;
  const makeGoal = (id: string, status: 'complete' | 'active') => ({
    schemaVersion: 1,
    id,
    objective: 'Ship the release',
    status,
  });
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.describe') {
      describeCount += 1;
      return {
        session: {
          key: 'agent:main:justdo:session-1',
          goal: cleared ? null : makeGoal('goal-1', 'active'),
        },
      };
    }
    if (method === 'sessions.goal.clear') {
      cleared = true;
      return { ok: true, cleared: true, key: 'agent:main:justdo:session-1' };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    goalContinuationCoordinator: { getSnapshot: (sessionId: string) => unknown };
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  vi.spyOn(internals.goalContinuationCoordinator, 'getSnapshot').mockReturnValue({
    sessionId: 'session-1',
    phase: 'awaiting_confirmation',
    continuationCount: 1,
    updatedAt: 2,
  });

  await expect(
    adapter.restartCompletedGoalForFeedback('session-1', 'goal-1'),
  ).resolves.toEqual({ objective: 'Ship the release' });
  expect(describeCount).toBe(2);
});

test('prepares a goal when completion is latched but metadata was reverted to active', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const makeGoal = (id: string) => ({
    schemaVersion: 1,
    id,
    objective: 'Ship the release',
    status: 'active',
  });
  let currentGoal: ReturnType<typeof makeGoal> | null = makeGoal('goal-1');
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.describe') {
      return {
        session: { key: 'agent:main:justdo:session-1', goal: currentGoal },
      };
    }
    if (method === 'sessions.goal.clear') {
      currentGoal = null;
      return { ok: true, cleared: true, key: 'agent:main:justdo:session-1' };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    goalContinuationCoordinator: {
      getSnapshot: (sessionId: string) => {
        sessionId: string;
        goalId?: string;
        phase: string;
        continuationCount: number;
        updatedAt: number;
      };
    };
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  vi.spyOn(internals.goalContinuationCoordinator, 'getSnapshot').mockReturnValue({
    sessionId: 'session-1',
    phase: 'awaiting_confirmation',
    continuationCount: 1,
    updatedAt: 2,
  });

  await expect(
    adapter.restartCompletedGoalForFeedback('session-1', 'goal-1'),
  ).resolves.toEqual({ objective: 'Ship the release' });
  expect(request).toHaveBeenCalledWith(
    'sessions.goal.clear',
    { key: 'agent:main:justdo:session-1' },
  );
});

test('treats an already-cleared completed goal as prepared when the objective was persisted', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn().mockResolvedValue({
    session: { key: 'agent:main:justdo:session-1', goal: null },
  });
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request,
  };

  await expect(
    adapter.restartCompletedGoalForFeedback('session-1', 'goal-1', 'Ship the release'),
  ).resolves.toEqual({ objective: 'Ship the release' });
  expect(request.mock.calls.some(([method]) => method === 'sessions.goal.clear')).toBe(false);
});

test('rejects completion feedback replacement when the completed goal changed', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn().mockResolvedValue({
    session: {
      key: 'agent:main:justdo:session-1',
      goal: {
        schemaVersion: 1,
        id: 'different-goal',
        objective: 'Different goal',
        status: 'complete',
      },
    },
  });
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request,
  };

  await expect(
    adapter.restartCompletedGoalForFeedback('session-1', 'goal-1'),
  ).rejects.toThrow('completed goal changed');
  expect(request.mock.calls.some(([method]) => method === 'chat.send')).toBe(false);
});

test('recovers an idle active goal after a Gateway reconnect', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.list') {
      return {
        sessions: [{
          key: 'agent:main:justdo:session-1',
          goal: { id: 'goal-1', status: 'active' },
        }],
      };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const continueGoal = vi.fn().mockResolvedValue(undefined);
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    gatewayClientGeneration: number;
    recoverActiveGoals: (generation: number) => Promise<void>;
    goalContinuationCoordinator: { continue: typeof continueGoal };
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.gatewayClientGeneration = 3;
  internals.goalContinuationCoordinator.continue = continueGoal;

  await internals.recoverActiveGoals(3);
  await internals.recoverActiveGoals(3);

  expect(continueGoal).toHaveBeenCalledWith('session-1', 'agent:main:justdo:session-1');
  expect(continueGoal).toHaveBeenCalledTimes(1);
  expect(request.mock.calls.some(([method]) => method === 'sessions.describe')).toBe(false);
});

test('falls back to sessions.describe when the recovery session list is truncated', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.list') return { sessions: [], hasMore: true };
    if (method === 'sessions.describe') {
      return {
        session: {
          key: 'agent:main:justdo:session-1',
          goal: { id: 'goal-1', status: 'active' },
        },
      };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const continueGoal = vi.fn().mockResolvedValue(undefined);
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    gatewayClientGeneration: number;
    recoverActiveGoals: (generation: number) => Promise<void>;
    goalContinuationCoordinator: { continue: typeof continueGoal };
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.gatewayClientGeneration = 4;
  internals.goalContinuationCoordinator.continue = continueGoal;

  await internals.recoverActiveGoals(4);

  expect(request).toHaveBeenCalledWith('sessions.describe', {
    key: 'agent:main:justdo:session-1',
  });
  expect(continueGoal).toHaveBeenCalledOnce();
});

test('restores a persisted completed execution instead of auto-running stale active metadata', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  store.setGoalExecutionSnapshot({
    sessionId: 'session-1',
    phase: 'awaiting_confirmation',
    continuationCount: 1,
    updatedAt: 10,
    identityPending: true,
  });
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.list') {
      return {
        sessions: [{
          key: 'agent:main:justdo:session-1',
          goal: { id: 'goal-1', objective: 'Ship the release', status: 'active' },
        }],
      };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const continueGoal = vi.fn();
  const restoreSnapshot = vi.fn();
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    gatewayClientGeneration: number;
    recoverActiveGoals: (generation: number) => Promise<void>;
    goalContinuationCoordinator: {
      continue: typeof continueGoal;
      restoreSnapshot: typeof restoreSnapshot;
    };
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.gatewayClientGeneration = 8;
  internals.goalContinuationCoordinator.continue = continueGoal;
  internals.goalContinuationCoordinator.restoreSnapshot = restoreSnapshot;

  await internals.recoverActiveGoals(8);

  expect(restoreSnapshot).toHaveBeenCalledWith(
    expect.objectContaining({ phase: 'awaiting_confirmation' }),
  );
  expect(continueGoal).not.toHaveBeenCalled();
});

test('persists a provisional terminal latch immediately and canonicalizes a replacement goal id', async () => {
  vi.useFakeTimers();
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn().mockResolvedValue({
    session: {
      key: 'agent:main:justdo:session-1',
      goal: {
        schemaVersion: 1,
        id: 'goal-2',
        objective: 'Improved release',
        status: 'complete',
        createdAt: 1,
        updatedAt: 2,
        tokenStart: 0,
        tokensUsed: 0,
        continuationTurns: 1,
      },
    },
  });
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    goalContinuationCoordinator: {
      restoreSnapshot: (snapshot: Record<string, unknown>) => void;
    };
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };

  internals.goalContinuationCoordinator.restoreSnapshot({
    sessionId: 'session-1',
    goalId: 'goal-1',
    phase: 'awaiting_confirmation',
    runId: 'replacement-run',
    continuationCount: 1,
    updatedAt: 10,
  });

  expect(store.getGoalExecutionSnapshot('session-1')).toMatchObject({
    goalId: 'goal-1',
    identityPending: true,
  });

  await vi.runAllTimersAsync();
  expect(store.getGoalExecutionSnapshot('session-1')).toMatchObject({
    goalId: 'goal-2',
    identityPending: false,
  });
  expect(adapter.getGoalExecution('session-1')).toMatchObject({
    goalId: 'goal-2',
    identityPending: false,
  });
});

test('restores but does not duplicate a goal run already active after reconnect', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.list') {
      return {
        sessions: [
          {
            key: 'agent:main:justdo:session-1',
            runId: 'active-run',
            hasActiveRun: true,
            goal: { id: 'goal-1', status: 'active' },
          },
        ],
      };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const restoreRunning = vi.fn();
  const continueGoal = vi.fn();
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    gatewayClientGeneration: number;
    recoverActiveGoals: (generation: number) => Promise<void>;
    goalContinuationCoordinator: {
      restoreRunning: typeof restoreRunning;
      continue: typeof continueGoal;
    };
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.gatewayClientGeneration = 4;
  internals.goalContinuationCoordinator.restoreRunning = restoreRunning;
  internals.goalContinuationCoordinator.continue = continueGoal;

  await internals.recoverActiveGoals(4);

  expect(restoreRunning).toHaveBeenCalledWith('session-1', 'goal-1', 'active-run');
  expect(continueGoal).not.toHaveBeenCalled();
});

test('does not recover a resumed blocked goal before user input is accepted', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.list') {
      return {
        sessions: [{
          key: 'agent:main:justdo:session-1',
          goal: { id: 'goal-1', status: 'active' },
        }],
      };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const continueGoal = vi.fn();
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    gatewayClientGeneration: number;
    recoverActiveGoals: (generation: number) => Promise<void>;
    goalsAwaitingResumeInput: Map<string, string>;
    goalContinuationCoordinator: { continue: typeof continueGoal };
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.gatewayClientGeneration = 6;
  internals.goalsAwaitingResumeInput.set('session-1', 'goal-1');
  internals.goalContinuationCoordinator.continue = continueGoal;

  await internals.recoverActiveGoals(6);

  expect(continueGoal).not.toHaveBeenCalled();
});

test('clears pending goal-input markers on the first direct renderer user run', () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const internals = adapter as unknown as {
    goalsAwaitingResumeInput: Map<string, string>;
  };
  internals.goalsAwaitingResumeInput.set('session-1', 'goal-2');
  adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');

  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId: 'child-run',
      sessionKey: 'agent:main:justdo:session-1',
      spawnedBy: 'parent-run',
      stream: 'lifecycle',
      data: { phase: 'start' },
    },
  });
  expect(internals.goalsAwaitingResumeInput.has('session-1')).toBe(true);

  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId: 'renderer-user-run',
      sessionKey: 'agent:main:justdo:session-1',
      stream: 'lifecycle',
      data: { phase: 'start' },
    },
  });

  expect(internals.goalsAwaitingResumeInput.has('session-1')).toBe(false);
});

test.each(['paused', 'blocked', 'complete'])('does not recover a %s goal after reconnect', async status => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.list') {
      return {
        sessions: [{
          key: 'agent:main:justdo:session-1',
          goal: { id: 'goal-1', status },
        }],
      };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const continueGoal = vi.fn();
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    gatewayClientGeneration: number;
    recoverActiveGoals: (generation: number) => Promise<void>;
    goalContinuationCoordinator: { continue: typeof continueGoal };
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.gatewayClientGeneration = 5;
  internals.goalContinuationCoordinator.continue = continueGoal;

  await internals.recoverActiveGoals(5);

  expect(continueGoal).not.toHaveBeenCalled();
});

test('keeps scheduling Gateway reconnects after the former attempt limit', async () => {
  vi.useFakeTimers();
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const attemptGatewayReconnect = vi.fn().mockResolvedValue(undefined);
  const internals = adapter as unknown as {
    gatewayReconnectAttempt: number;
    scheduleGatewayReconnect: () => void;
    attemptGatewayReconnect: typeof attemptGatewayReconnect;
  };
  internals.gatewayReconnectAttempt = 20;
  internals.attemptGatewayReconnect = attemptGatewayReconnect;

  internals.scheduleGatewayReconnect();
  await vi.advanceTimersByTimeAsync(30_000);

  expect(attemptGatewayReconnect).toHaveBeenCalledOnce();
  vi.useRealTimers();
});

test('getSessionRuntimeStatus treats a pending subagent as active', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn().mockResolvedValue({
    sessions: [
      {
        key: 'agent:main:justdo:session-1',
        status: 'completed',
      },
      {
        key: 'agent:main:subagent:queued-child',
        spawnedBy: 'agent:main:justdo:session-1',
        status: 'pending',
        subagentRunState: 'pending',
        hasActiveSubagentRun: true,
      },
    ],
  });

  adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    request,
  } as unknown as GatewayClientLike;

  await expect(
    adapter.getSessionRuntimeStatus('session-1', { includeSubagents: true }),
  ).resolves.toEqual({
    known: true,
    mainRunning: false,
    subagentRunning: true,
    running: true,
  });
});

test('getSessionRuntimeStatus treats manual context compaction as locally running', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const sessionKey = 'agent:main:justdo:session-1';
  const request = vi.fn().mockResolvedValue({
    sessions: [
      {
        key: sessionKey,
        hasActiveRun: false,
        status: 'completed',
        runState: 'idle',
      },
    ],
  });
  adapter.rememberSessionKey('session-1', sessionKey);
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    request,
  } as unknown as GatewayClientLike;

  adapter.handleGatewayEvent({
    event: 'session.operation',
    payload: { operation: 'compact', phase: 'start', sessionKey },
  });

  await expect(adapter.getSessionRuntimeStatus('session-1')).resolves.toEqual({
    known: true,
    mainRunning: true,
    subagentRunning: false,
    running: true,
  });
  expect(request).not.toHaveBeenCalled();

  adapter.handleGatewayEvent({
    event: 'session.operation',
    payload: { operation: 'compact', phase: 'end', sessionKey },
  });

  await expect(
    adapter.getSessionRuntimeStatus('session-1', { forceRefresh: true }),
  ).resolves.toEqual({
    known: true,
    mainRunning: false,
    subagentRunning: false,
    running: false,
  });
  expect(request).toHaveBeenCalledOnce();
});

test.each(['error', 'failed'])('clears manual context compaction on %s', async phase => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const sessionKey = 'agent:main:justdo:session-1';
  const request = vi.fn().mockResolvedValue({ sessions: [] });
  adapter.rememberSessionKey('session-1', sessionKey);
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    request,
  } as unknown as GatewayClientLike;

  adapter.handleGatewayEvent({
    event: 'session.operation',
    payload: { operation: 'compact', phase: 'start', sessionKey },
  });
  adapter.handleGatewayEvent({
    event: 'session.operation',
    payload: { operation: 'compact', phase, sessionKey },
  });

  await expect(
    adapter.getSessionRuntimeStatus('session-1', { forceRefresh: true }),
  ).resolves.toMatchObject({ mainRunning: false, running: false });
});

test('expires manual context compaction when its terminal event is lost', async () => {
  vi.useFakeTimers();
  try {
    const { store } = createEmptyStore();
    const adapter = new OpenClawRuntimeAdapter(store, {});
    const sessionKey = 'agent:main:justdo:session-1';
    const request = vi.fn().mockResolvedValue({ sessions: [] });
    adapter.rememberSessionKey('session-1', sessionKey);
    (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
      request,
    } as unknown as GatewayClientLike;

    adapter.handleGatewayEvent({
      event: 'session.operation',
      payload: { operation: 'compact', phase: 'start', sessionKey },
    });
    await vi.advanceTimersByTimeAsync(10 * 60 * 1_000);

    await expect(
      adapter.getSessionRuntimeStatus('session-1', { forceRefresh: true }),
    ).resolves.toMatchObject({ mainRunning: false, running: false });
    expect(request).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

test('clears manual context compaction when Gateway state is cleaned up', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const sessionKey = 'agent:main:justdo:session-1';
  const request = vi.fn().mockResolvedValue({ sessions: [] });
  adapter.rememberSessionKey('session-1', sessionKey);
  (adapter as unknown as { gatewayClient: GatewayClientLike | null }).gatewayClient = {
    request,
  } as unknown as GatewayClientLike;

  adapter.handleGatewayEvent({
    event: 'session.operation',
    payload: { operation: 'compact', phase: 'start', sessionKey },
  });
  (
    adapter as unknown as { cleanupGatewayClientState: () => void }
  ).cleanupGatewayClientState();

  await expect(
    adapter.getSessionRuntimeStatus('session-1', { forceRefresh: true }),
  ).resolves.toMatchObject({ mainRunning: false, running: false });
});

test('announce run events follow webchat chat-final and tool-stream split', () => {
  const session = {
    id: 'session-1',
    title: 'Announce Session',
    status: 'running',
    pinned: false,
    cwd: '',
    executionMode: 'local',
    activeSkillIds: [],
    messages: [] as Array<Record<string, unknown>>,
    createdAt: 1,
    updatedAt: 1,
  };
  let nextId = 1;
  const store = {
    getSession: (sessionId: string) => (sessionId === session.id ? session : null),
    getAgent: () => null,
    addMessage: (sessionId: string, message: Record<string, unknown>) => {
      expect(sessionId).toBe(session.id);
      const created = {
        id: `msg-${nextId++}`,
        timestamp: nextId,
        metadata: {},
        ...message,
      };
      session.messages.push(created);
      return created;
    },
    updateMessage: (sessionId: string, messageId: string, updates: Record<string, unknown>) => {
      expect(sessionId).toBe(session.id);
      const index = session.messages.findIndex(m => m.id === messageId);
      if (index !== -1) {
        session.messages[index] = {
          ...session.messages[index],
          ...updates,
          metadata: {
            ...((session.messages[index].metadata as Record<string, unknown>) ?? {}),
            ...((updates.metadata as Record<string, unknown>) ?? {}),
          },
        };
      }
      return index !== -1;
    },
    updateSession: (_sessionId: string, updates: Record<string, unknown>) => {
      Object.assign(session, updates);
    },
    deleteMessage: () => true,
    replaceConversationMessages: () => {},
  };
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const mainMessages: Array<Record<string, unknown>> = [];
  adapter.on('message', (_sessionId, message) => mainMessages.push(message));

  adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');
  adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');
  adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');
  adapter.ensureActiveTurn('session-1', 'agent:main:justdo:session-1', 'main-run');
  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId: 'announce:v1:agent:main:subagent:child-run',
      sessionKey: 'agent:main:justdo:session-1',
      stream: 'thinking',
      data: { text: 'thinking snapshot' },
    },
  });
  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId: 'announce:v1:agent:main:subagent:child-run',
      sessionKey: 'agent:main:justdo:session-1',
      stream: 'assistant',
      data: { text: 'I will inspect the file.' },
    },
  });
  adapter.handleGatewayEvent({
    event: 'chat',
    payload: {
      sessionKey: 'agent:main:justdo:session-1',
      state: 'delta',
      message: {
        role: 'assistant',
        content: 'I will inspect the file.',
      },
    },
  });
  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId: 'announce:v1:agent:main:subagent:child-run',
      sessionKey: 'agent:main:justdo:session-1',
      stream: 'assistant',
      data: { text: 'I will inspect the file and then report back.' },
    },
  });
  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId: 'announce:v1:agent:main:subagent:child-run',
      sessionKey: 'agent:main:justdo:session-1',
      stream: 'tool',
      data: {
        phase: 'start',
        toolCallId: 'call-1',
        name: 'Bash',
        args: { command: 'pwd' },
      },
    },
  });
  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId: 'announce:v1:agent:main:subagent:child-run',
      sessionKey: 'agent:main:justdo:session-1',
      stream: 'tool',
      data: {
        phase: 'result',
        toolCallId: 'call-1',
        name: 'Bash',
        result: 'ok',
      },
    },
  });
  adapter.handleGatewayEvent({
    event: 'chat',
    payload: {
      sessionKey: 'agent:main:justdo:session-1',
      state: 'final',
      message: {
        role: 'assistant',
        content: 'I will inspect the file and then report back.',
      },
    },
  });

  expect(mainMessages.map(message => message.type)).toEqual([
    'assistant',
    'tool_use',
    'tool_result',
  ]);
  expect(session.messages.map(message => message.type)).toEqual([
    'assistant',
    'tool_use',
    'tool_result',
  ]);
  expect(session.messages[0].content).toBe('I will inspect the file and then report back.');
  expect(session.messages[0].thinkingContent).toBe('thinking snapshot');
  expect(session.messages[0].metadata).toEqual(
    expect.objectContaining({
      isThinking: false,
      isFinal: true,
    }),
  );
});

test('does not persist partial NO_REPLY snapshots from a detached announce run', () => {
  const { session, store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const emittedMessages: Array<Record<string, unknown>> = [];
  adapter.on('message', (_sessionId, message) => emittedMessages.push(message));

  const sessionKey = 'agent:main:justdo:session-1';
  const runId = 'announce:v1:agent:main:subagent:child-run';
  adapter.rememberSessionKey(session.id, sessionKey);

  for (const text of ['N', 'NO', 'NO_', 'NO_RE', 'NO_REPLY']) {
    adapter.handleGatewayEvent({
      event: 'agent',
      payload: {
        runId,
        sessionKey,
        stream: 'assistant',
        data: { text },
      },
    });
  }
  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId,
      sessionKey,
      stream: 'lifecycle',
      data: { phase: 'end' },
    },
  });

  expect(emittedMessages).toEqual([]);
  expect(session.messages).toEqual([]);
});

test('keeps a legitimate final NO reply after suppressing its live prefix', () => {
  const { session, store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const sessionKey = 'agent:main:justdo:session-1';
  const runId = 'main-run';

  adapter.rememberSessionKey(session.id, sessionKey);
  adapter.ensureActiveTurn(session.id, sessionKey, runId);
  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId,
      sessionKey,
      stream: 'assistant',
      data: { text: 'NO' },
    },
  });
  adapter.handleGatewayEvent({
    event: 'chat',
    payload: {
      runId,
      sessionKey,
      state: 'final',
      message: { role: 'assistant', content: 'NO' },
    },
  });

  expect(session.messages).toEqual([
    expect.objectContaining({
      type: 'assistant',
      content: 'NO',
      metadata: expect.objectContaining({ isFinal: true }),
    }),
  ]);
});

test('announce item and command_output events render tool messages', () => {
  const session = {
    id: 'session-1',
    title: 'Announce Session',
    status: 'running',
    pinned: false,
    cwd: '',
    executionMode: 'local',
    activeSkillIds: [],
    messages: [] as Array<Record<string, unknown>>,
    createdAt: 1,
    updatedAt: 1,
  };
  let nextId = 1;
  const store = {
    getSession: (sessionId: string) => (sessionId === session.id ? session : null),
    getAgent: () => null,
    addMessage: (sessionId: string, message: Record<string, unknown>) => {
      expect(sessionId).toBe(session.id);
      const created = {
        id: `msg-${nextId++}`,
        timestamp: nextId,
        metadata: {},
        ...message,
      };
      session.messages.push(created);
      return created;
    },
    updateMessage: () => true,
    updateSession: (_sessionId: string, updates: Record<string, unknown>) => {
      Object.assign(session, updates);
    },
    deleteMessage: () => true,
    replaceConversationMessages: () => {},
  };
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const mainMessages: Array<Record<string, unknown>> = [];
  adapter.on('message', (_sessionId, message) => mainMessages.push(message));

  adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');
  adapter.ensureActiveTurn('session-1', 'agent:main:justdo:session-1', 'main-run');
  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId: 'announce:v1:agent:main:subagent:child-run',
      sessionKey: 'agent:main:justdo:session-1',
      stream: 'item',
      data: {
        itemId: 'command:call-1',
        phase: 'start',
        kind: 'command',
        title: 'exec command',
        status: 'running',
        name: 'exec',
        toolCallId: 'call-1',
      },
    },
  });
  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId: 'announce:v1:agent:main:subagent:child-run',
      sessionKey: 'agent:main:justdo:session-1',
      stream: 'command_output',
      data: {
        itemId: 'command:call-1',
        phase: 'end',
        title: 'exec command',
        toolCallId: 'call-1',
        name: 'exec',
        output: 'ok',
        status: 'completed',
      },
    },
  });

  expect(mainMessages.map(message => message.type)).toEqual(['tool_use', 'tool_result']);
  expect(session.messages.map(message => message.type)).toEqual(['tool_use', 'tool_result']);
  expect(session.messages[1].content).toBe('ok');
});

test('announce events after parent turn cleanup do not render assistant deltas', () => {
  const session = {
    id: 'session-1',
    title: 'Announce Session',
    status: 'idle',
    pinned: false,
    cwd: '',
    executionMode: 'local',
    activeSkillIds: [],
    messages: [] as Array<Record<string, unknown>>,
    createdAt: 1,
    updatedAt: 1,
  };
  let nextId = 1;
  const store = {
    getSession: (sessionId: string) => (sessionId === session.id ? session : null),
    getAgent: () => null,
    addMessage: (sessionId: string, message: Record<string, unknown>) => {
      expect(sessionId).toBe(session.id);
      const created = {
        id: `msg-${nextId++}`,
        timestamp: nextId,
        metadata: {},
        ...message,
      };
      session.messages.push(created);
      return created;
    },
    updateMessage: () => true,
    updateSession: (_sessionId: string, updates: Record<string, unknown>) => {
      Object.assign(session, updates);
    },
    deleteMessage: () => true,
    replaceConversationMessages: () => {},
  };
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const mainMessages: Array<Record<string, unknown>> = [];
  adapter.on('message', (_sessionId, message) => mainMessages.push(message));

  adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');
  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId: 'announce:v1:agent:main:subagent:child-run',
      sessionKey: 'agent:main:justdo:session-1',
      stream: 'assistant',
      data: { text: '已汇总两个子agent的祝福语并写入Excel： | 序号 |' },
    },
  });
  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId: 'announce:v1:agent:main:subagent:child-run',
      sessionKey: 'agent:main:justdo:session-1',
      stream: 'assistant',
      data: {
        text: '已汇总两个子agent的祝福语并写入Excel： | 序号 | 祝福语 | |:---:|---|',
      },
    },
  });
  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId: 'announce:v1:agent:main:subagent:child-run',
      sessionKey: 'agent:main:justdo:session-1',
      stream: 'tool',
      data: {
        phase: 'start',
        toolCallId: 'call-1',
        name: 'exec',
        args: { command: 'write xlsx' },
      },
    },
  });
  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId: 'announce:v1:agent:main:subagent:child-run',
      sessionKey: 'agent:main:justdo:session-1',
      stream: 'tool',
      data: {
        phase: 'result',
        toolCallId: 'call-1',
        name: 'exec',
        result: 'ok',
      },
    },
  });
  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId: 'announce:v1:agent:main:subagent:child-run',
      sessionKey: 'agent:main:justdo:session-1',
      stream: 'lifecycle',
      data: { phase: 'end' },
    },
  });
  adapter.handleGatewayEvent({
    event: 'chat',
    payload: {
      sessionKey: 'agent:main:justdo:session-1',
      state: 'final',
      message: {
        role: 'assistant',
        content:
          '已汇总两个子agent的祝福语并写入Excel：\n\n| 序号 | 祝福语 |\n|:---:|---|\n| 1 | 愿你今天的每一份努力都化作明天的惊喜。 |\n| 2 | 愿你今天的每一分努力都有回响。 |\n\n文件已保存到：`blessings.xlsx`',
      },
    },
  });

  expect(mainMessages.map(message => message.type)).toEqual([
    'assistant',
    'tool_use',
    'tool_result',
    'assistant',
  ]);
  expect(session.messages.map(message => message.type)).toEqual([
    'assistant',
    'tool_use',
    'tool_result',
    'assistant',
  ]);
  expect(session.messages[3].content).toContain('文件已保存到');
});

test('detached announce final does not append composite assistant snapshot', () => {
  const session = {
    id: 'session-1',
    title: 'Announce Session',
    status: 'idle',
    pinned: false,
    cwd: '',
    executionMode: 'local',
    activeSkillIds: [],
    messages: [] as Array<Record<string, unknown>>,
    createdAt: 1,
    updatedAt: 1,
  };
  let nextId = 1;
  const store = {
    getSession: (sessionId: string) => (sessionId === session.id ? session : null),
    getAgent: () => null,
    addMessage: (sessionId: string, message: Record<string, unknown>) => {
      expect(sessionId).toBe(session.id);
      const created = {
        id: `msg-${nextId++}`,
        timestamp: nextId,
        metadata: {},
        ...message,
      };
      session.messages.push(created);
      return created;
    },
    updateMessage: (sessionId: string, messageId: string, updates: Record<string, unknown>) => {
      expect(sessionId).toBe(session.id);
      const index = session.messages.findIndex(m => m.id === messageId);
      if (index !== -1) {
        session.messages[index] = {
          ...session.messages[index],
          ...updates,
          metadata: {
            ...((session.messages[index].metadata as Record<string, unknown>) ?? {}),
            ...((updates.metadata as Record<string, unknown>) ?? {}),
          },
        };
      }
      return index !== -1;
    },
    updateSession: (_sessionId: string, updates: Record<string, unknown>) => {
      Object.assign(session, updates);
    },
    deleteMessage: () => true,
    replaceConversationMessages: () => {},
  };
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const mainMessages: Array<Record<string, unknown>> = [];
  adapter.on('message', (_sessionId, message) => mainMessages.push(message));

  const sessionKey = 'agent:main:justdo:session-1';
  const runId = 'announce:v1:agent:main:subagent:child-run';
  const beforeTool = '两个祝福语都收到了！现在汇总写入 Excel。';
  const afterTool = '✅ **完成！** 两个 subagent 的祝福语已汇总写入 Excel';

  adapter.rememberSessionKey('session-1', sessionKey);
  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId,
      sessionKey,
      stream: 'assistant',
      data: { text: beforeTool },
    },
  });
  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId,
      sessionKey,
      stream: 'tool',
      data: {
        phase: 'start',
        toolCallId: 'call-1',
        name: 'exec',
        args: { command: 'write xlsx' },
      },
    },
  });
  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId,
      sessionKey,
      stream: 'tool',
      data: {
        phase: 'result',
        toolCallId: 'call-1',
        name: 'exec',
        result: 'ok',
      },
    },
  });
  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId,
      sessionKey,
      stream: 'assistant',
      data: { text: afterTool },
    },
  });
  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId,
      sessionKey,
      stream: 'lifecycle',
      data: { phase: 'end' },
    },
  });
  adapter.handleGatewayEvent({
    event: 'chat',
    payload: {
      runId,
      sessionKey,
      state: 'final',
      message: {
        role: 'assistant',
        content: `${beforeTool}${afterTool}`,
      },
    },
  });

  expect(mainMessages.map(message => message.type)).toEqual([
    'assistant',
    'tool_use',
    'tool_result',
    'assistant',
  ]);
  expect(session.messages.map(message => message.type)).toEqual([
    'assistant',
    'tool_use',
    'tool_result',
    'assistant',
  ]);
  expect(session.messages[0].content).toBe(beforeTool);
  expect(session.messages[3].content).toBe(afterTool);
});

test('agent assistant stream wins over duplicate chat deltas for active run', () => {
  vi.useFakeTimers();
  const { session, store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const mainMessages: Array<Record<string, unknown>> = [];
  const updates: Array<{ messageId: string; content: string }> = [];
  adapter.on('message', (_sessionId, message) => mainMessages.push(message));
  adapter.on('messageUpdate', (_sessionId, messageId, content) => {
    updates.push({ messageId, content });
  });

  const sessionKey = 'agent:main:justdo:session-1';
  const runId = 'run-1';
  const firstSnapshot = '完成！两条祝福语已汇总写入 Excel 文件：';
  const finalSnapshot =
    '完成！两条祝福语已汇总写入 Excel 文件：\n\n| 序号 | 祝福语 |\n|------|--------|';

  adapter.rememberSessionKey('session-1', sessionKey);
  adapter.ensureActiveTurn('session-1', sessionKey, runId);

  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId,
      sessionKey,
      stream: 'assistant',
      data: { text: firstSnapshot },
    },
  });
  adapter.handleGatewayEvent({
    event: 'chat',
    payload: {
      runId,
      sessionKey,
      state: 'delta',
      message: { role: 'assistant', content: '完成！' },
    },
  });
  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId,
      sessionKey,
      stream: 'assistant',
      data: { text: finalSnapshot },
    },
  });
  adapter.handleGatewayEvent({
    event: 'chat',
    payload: {
      runId,
      sessionKey,
      state: 'final',
      message: { role: 'assistant', content: '完成！' },
    },
  });

  vi.runOnlyPendingTimers();
  vi.useRealTimers();

  expect(mainMessages.map(message => message.type)).toEqual(['assistant']);
  expect(session.messages).toHaveLength(1);
  expect(session.messages[0].content).toBe(finalSnapshot);
  expect(updates.at(-1)?.content).toBe(finalSnapshot);
});

test('merges a fuller chat final without run id into the active assistant stream', () => {
  const { session, store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const mainMessages: Array<Record<string, unknown>> = [];
  adapter.on('message', (_sessionId, message) => mainMessages.push(message));

  const sessionKey = 'agent:main:justdo:session-1';
  const runId = 'run-1';
  const streamedSnapshot =
    '报告已整理完成！文件保存在 `report.md`，以下是核心要点速览：\n\n---\n\n报告摘要已经整理完毕。';
  const finalSnapshot =
    '报告已整理完成！文件保存在 `report.md`，以下是核心要点速览：\n---\n报告摘要已经整理完毕。\nMEDIA:report.md\n还有什么需要我深入展开的吗？';

  adapter.rememberSessionKey('session-1', sessionKey);
  adapter.ensureActiveTurn('session-1', sessionKey, runId);
  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId,
      sessionKey,
      stream: 'assistant',
      data: { text: streamedSnapshot },
    },
  });
  adapter.handleGatewayEvent({
    event: 'chat',
    payload: {
      sessionKey,
      state: 'final',
      message: { role: 'assistant', content: finalSnapshot },
    },
  });

  expect(mainMessages).toHaveLength(1);
  expect(session.messages).toHaveLength(1);
  expect(session.messages[0].content).toBe(finalSnapshot);
  expect(session.messages[0].metadata).toMatchObject({
    isStreaming: false,
    isFinal: true,
  });
});

test('throttled assistant stream updates are persisted before renderer reloads', () => {
  vi.useFakeTimers();
  const { session, store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const updates: Array<{ messageId: string; content: string }> = [];
  adapter.on('messageUpdate', (_sessionId, messageId, content) => {
    updates.push({ messageId, content });
  });

  const sessionKey = 'agent:main:justdo:session-1';
  const runId = 'run-1';
  adapter.rememberSessionKey('session-1', sessionKey);
  adapter.ensureActiveTurn('session-1', sessionKey, runId);

  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId,
      sessionKey,
      stream: 'assistant',
      data: { text: 'first chunk' },
    },
  });
  const firstMessageId = session.messages[0].id as string;
  (
    adapter as unknown as {
      lastMessageUpdateEmitTime: Map<string, number>;
    }
  ).lastMessageUpdateEmitTime.set(firstMessageId, Date.now());
  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId,
      sessionKey,
      stream: 'assistant',
      data: { text: 'first chunk plus more' },
    },
  });

  expect(updates).toHaveLength(0);
  expect(session.messages).toHaveLength(1);
  expect(session.messages[0].content).toBe('first chunk plus more');

  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

test('chat delta without run id is ignored while a turn is active', () => {
  const session = {
    id: 'session-1',
    title: 'Session',
    status: 'running',
    pinned: false,
    cwd: '',
    executionMode: 'local',
    activeSkillIds: [],
    messages: [] as Array<Record<string, unknown>>,
    createdAt: 1,
    updatedAt: 1,
  };
  const store = {
    getSession: (sessionId: string) => (sessionId === session.id ? session : null),
    getAgent: () => null,
    addMessage: (sessionId: string, message: Record<string, unknown>) => {
      expect(sessionId).toBe(session.id);
      session.messages.push(message);
      return { id: `msg-${session.messages.length}`, timestamp: Date.now(), ...message };
    },
    updateMessage: () => true,
    updateSession: (_sessionId: string, updates: Record<string, unknown>) => {
      Object.assign(session, updates);
    },
    deleteMessage: () => true,
    replaceConversationMessages: () => {},
  };
  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');
  adapter.ensureActiveTurn('session-1', 'agent:main:justdo:session-1', 'main-run');

  adapter.handleGatewayEvent({
    event: 'chat',
    payload: {
      sessionKey: 'agent:main:justdo:session-1',
      state: 'delta',
      message: { role: 'assistant', content: 'unowned partial' },
    },
  });

  expect(session.messages).toHaveLength(0);
});

test('lifecycle end clears the active turn when chat final is missing', () => {
  vi.useFakeTimers();
  try {
    const { session, store } = createEmptyStore();
    session.status = 'running';
    store.updateSession = (_sessionId: string, updates: Record<string, unknown>) => {
      Object.assign(session, updates);
    };
    const adapter = new OpenClawRuntimeAdapter(store, {});
    const complete = vi.fn();
    adapter.on('complete', complete);
    adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');
    adapter.ensureActiveTurn('session-1', 'agent:main:justdo:session-1', 'run-1');

    adapter.handleGatewayEvent({
      event: 'agent',
      payload: {
        runId: 'run-1',
        sessionKey: 'agent:main:justdo:session-1',
        stream: 'lifecycle',
        data: { phase: 'end' },
      },
    });

    vi.advanceTimersByTime(1499);
    expect(adapter.isSessionActive('session-1')).toBe(true);

    vi.advanceTimersByTime(1);
    expect(adapter.isSessionActive('session-1')).toBe(false);
    expect(session.status).toBe('idle');
    expect(complete).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledWith('session-1', 'idle');
  } finally {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  }
});

test('chat final cancels the lifecycle end fallback', () => {
  vi.useFakeTimers();
  try {
    const { store } = createEmptyStore();
    const adapter = new OpenClawRuntimeAdapter(store, {});
    const complete = vi.fn();
    adapter.on('complete', complete);
    adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');
    adapter.ensureActiveTurn('session-1', 'agent:main:justdo:session-1', 'run-1');

    adapter.handleGatewayEvent({
      event: 'agent',
      payload: {
        runId: 'run-1',
        sessionKey: 'agent:main:justdo:session-1',
        stream: 'lifecycle',
        data: { phase: 'end' },
      },
    });
    adapter.handleGatewayEvent({
      event: 'chat',
      payload: {
        runId: 'run-1',
        sessionKey: 'agent:main:justdo:session-1',
        state: 'final',
        message: { role: 'assistant', content: 'done' },
      },
    });

    vi.advanceTimersByTime(1500);
    expect(complete).toHaveBeenCalledOnce();
  } finally {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  }
});

test('compaction pauses and then resumes the lifecycle end fallback', () => {
  vi.useFakeTimers();
  try {
    const { session, store } = createEmptyStore();
    session.status = 'running';
    store.updateSession = (_sessionId: string, updates: Record<string, unknown>) => {
      Object.assign(session, updates);
    };
    const adapter = new OpenClawRuntimeAdapter(store, {});
    adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');
    adapter.ensureActiveTurn('session-1', 'agent:main:justdo:session-1', 'run-1');

    adapter.handleGatewayEvent({
      event: 'agent',
      payload: {
        runId: 'run-1',
        sessionKey: 'agent:main:justdo:session-1',
        stream: 'lifecycle',
        data: { phase: 'end' },
      },
    });
    adapter.handleGatewayEvent({
      event: 'agent',
      payload: {
        runId: 'run-1',
        sessionKey: 'agent:main:justdo:session-1',
        stream: 'compaction',
        data: { phase: 'start' },
      },
    });
    vi.advanceTimersByTime(2000);
    expect(adapter.isSessionActive('session-1')).toBe(true);

    adapter.handleGatewayEvent({
      event: 'agent',
      payload: {
        runId: 'run-1',
        sessionKey: 'agent:main:justdo:session-1',
        stream: 'compaction',
        data: { phase: 'end', completed: true },
      },
    });
    vi.advanceTimersByTime(1500);
    expect(adapter.isSessionActive('session-1')).toBe(false);
    expect(session.status).toBe('idle');
  } finally {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  }
});

test('compaction timeout resumes the lifecycle end fallback when its end event is lost', () => {
  vi.useFakeTimers();
  try {
    const { session, store } = createEmptyStore();
    session.status = 'running';
    store.updateSession = (_sessionId: string, updates: Record<string, unknown>) => {
      Object.assign(session, updates);
    };
    const adapter = new OpenClawRuntimeAdapter(store, {});
    adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');
    adapter.ensureActiveTurn('session-1', 'agent:main:justdo:session-1', 'run-1');

    adapter.handleGatewayEvent({
      event: 'agent',
      payload: {
        runId: 'run-1',
        sessionKey: 'agent:main:justdo:session-1',
        stream: 'lifecycle',
        data: { phase: 'end' },
      },
    });
    adapter.handleGatewayEvent({
      event: 'agent',
      payload: {
        runId: 'run-1',
        sessionKey: 'agent:main:justdo:session-1',
        stream: 'compaction',
        data: { phase: 'start' },
      },
    });

    vi.advanceTimersByTime(10 * 60 * 1_000);
    expect(adapter.isSessionActive('session-1')).toBe(true);
    vi.advanceTimersByTime(1500);
    expect(adapter.isSessionActive('session-1')).toBe(false);
    expect(session.status).toBe('idle');
  } finally {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  }
});

test('session.message reload is deferred until sessions.changed clears active run', () => {
  const session = {
    id: 'session-1',
    title: 'Session',
    status: 'running',
    pinned: false,
    cwd: '',
    executionMode: 'local',
    activeSkillIds: [],
    messages: [] as Array<Record<string, unknown>>,
    createdAt: 1,
    updatedAt: 1,
  };
  const store = {
    getSession: (sessionId: string) => (sessionId === session.id ? session : null),
    getAgent: () => null,
    addMessage: () => {
      throw new Error('not expected');
    },
    updateMessage: () => true,
    updateSession: (_sessionId: string, updates: Record<string, unknown>) => {
      Object.assign(session, updates);
    },
    deleteMessage: () => true,
    replaceConversationMessages: () => {},
  };
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const complete = vi.fn();
  adapter.on('complete', complete);
  const reconcileWithHistory = vi.fn().mockResolvedValue(undefined);
  (
    adapter as unknown as {
      historyReconciler: { reconcileWithHistory: typeof reconcileWithHistory };
    }
  ).historyReconciler = { reconcileWithHistory };
  adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');
  adapter.ensureActiveTurn('session-1', 'agent:main:justdo:session-1', 'main-run');

  adapter.handleGatewayEvent({
    event: 'session.message',
    payload: { sessionKey: 'agent:main:justdo:session-1' },
  });
  expect(reconcileWithHistory).not.toHaveBeenCalled();

  adapter.handleGatewayEvent({
    event: 'sessions.changed',
    payload: {
      sessionKey: 'agent:main:justdo:session-1',
      key: 'agent:main:justdo:session-1',
      status: 'idle',
      hasActiveRun: false,
    },
  });

  expect(reconcileWithHistory).toHaveBeenCalledWith('session-1', 'agent:main:justdo:session-1');
  expect(session.status).toBe('idle');
  expect(complete).toHaveBeenCalledWith('session-1', 'idle');
});

test.each(['failed', 'timeout', 'timed_out', 'killed', 'aborted', 'cancelled'])(
  'maps abnormal terminal session status %s to error',
  status => {
    const { session, store } = createEmptyStore();
    session.status = 'running';
    store.updateSession = (_sessionId: string, updates: Record<string, unknown>) => {
      Object.assign(session, updates);
    };
    const adapter = new OpenClawRuntimeAdapter(store, {});
    const complete = vi.fn();
    adapter.on('complete', complete);
    adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');
    adapter.ensureActiveTurn('session-1', 'agent:main:justdo:session-1', 'run-1');

    adapter.handleGatewayEvent({
      event: 'sessions.changed',
      payload: {
        sessionKey: 'agent:main:justdo:session-1',
        status,
        hasActiveRun: false,
      },
    });

    expect(session.status).toBe('error');
    expect(complete).toHaveBeenCalledWith('session-1', 'error');
  },
);

test('patchSessionModel applies immediately to subsequent calls while session is active', async () => {
  const session = {
    id: 'session-1',
    title: 'Session',
    status: 'running',
    pinned: false,
    cwd: '',
    executionMode: 'local',
    activeSkillIds: [],
    messages: [] as Array<Record<string, unknown>>,
    createdAt: 1,
    updatedAt: 1,
    agentId: 'main',
  };
  const store = {
    getSession: (sessionId: string) => (sessionId === session.id ? session : null),
    getAgent: () => null,
    addMessage: () => {
      throw new Error('not expected');
    },
    updateMessage: () => true,
    updateSession: (_sessionId: string, updates: Record<string, unknown>) => {
      Object.assign(session, updates);
    },
    deleteMessage: () => true,
    replaceConversationMessages: () => {},
  };
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const patchSessionModel = vi.fn().mockResolvedValue({
    ok: true,
    modelRef: 'bailian/qwen3.6-plus',
    appliesTo: 'subsequent-calls',
    source: 'gateway',
  });
  (
    adapter as unknown as {
      sessionRpc: { patchModel: typeof patchSessionModel };
    }
  ).sessionRpc = { patchModel: patchSessionModel };

  adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');
  adapter.ensureActiveTurn('session-1', 'agent:main:justdo:session-1', 'main-run');
  const result = await adapter.patchSessionModel('session-1', 'bailian/qwen3.6-plus');

  expect(result).toEqual({
    ok: true,
    modelRef: 'bailian/qwen3.6-plus',
    appliesTo: 'subsequent-calls',
    source: 'gateway',
  });
  expect(patchSessionModel).toHaveBeenCalledWith(
    'session-1',
    'bailian/qwen3.6-plus',
    undefined,
    'subsequent-calls',
  );
});
