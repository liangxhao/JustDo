import { createHash } from 'crypto';
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

import { createDefaultAgentRuntimeSettings } from '../../../shared/agents/agentRuntimeSettings';
import { AskUserInteractionEvent, AskUserQuestionGateway } from '../../../shared/cowork/interactions/askUserQuestion';
import { CoworkInteractionIpc } from '../../../shared/cowork/interactions/interactions';
import { PlanModeGateway } from '../../../shared/cowork/interactions/planMode';
import { PRODUCT_NAME_LOWERCASE } from '../../../shared/productMetadata';
import type { GatewayClientLike, SessionTurn } from '../gateway/types';
import { OpenClawRuntimeAdapter } from './openclawRuntimeAdapter';

const createPreparedSessionReceipt = (key = 'agent:main:justdo:session-1') => ({
  key,
  sessionId: 'gateway-session-1',
  entry: {
    sessionId: 'gateway-session-1',
    permissionMode: 'full',
    sessionRoot: process.cwd(),
  },
});

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
  gatewayClientGeneration: number;
  ensureGatewayClientReady: () => Promise<void>;
};

const getSessionPreparationInternals = (
  adapter: OpenClawRuntimeAdapter,
): SessionPreparationInternals => adapter as unknown as SessionPreparationInternals;

const createAskUserRequest = () => ({
  requestId: 'ask_0123456789abcdef',
  questions: [
    {
      id: 'deploy_target',
      header: 'Deploy',
      question: 'Where should this be deployed?',
      options: [
        { id: 'staging', label: 'Staging' },
        { id: 'production', label: 'Production' },
      ],
      allowOther: true,
    },
  ],
  sessionKey: 'agent:main:justdo:session-1',
  waitPolicy: { mode: 'required' as const },
});

const createPlanModeRequest = () => ({
  requestId: 'plan_0123456789abcdef',
  sessionKey: 'agent:main:justdo:session-1',
  title: 'Implementation plan',
  plan: '1. Inspect\n2. Implement\n3. Verify',
});

const createChildQuestion = (id = 'child') => ({
  ...createAskUserRequest(),
  requestId: `ask_${id}`,
  sessionKey: `agent:worker:subagent:${id}`,
  source: {
    sessionKey: `agent:worker:subagent:${id}`,
    nativeSessionId: `native-${id}`,
    runId: `run-${id}`,
    toolCallId: `call-${id}`,
    agentId: 'worker',
    lifecycleRevision: 'revision-1',
  },
  createdAt: 1,
});

test('independent Native children have real sources without a fabricated product parent', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const pending = createChildQuestion();
  const request = vi.fn(async (method: string) =>
    method === AskUserQuestionGateway.LIST
      ? { requests: [pending] }
      : { requestId: pending.requestId, status: 'cancelled', source: pending.source },
  );
  getSessionPreparationInternals(adapter).gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request,
  };
  getSessionPreparationInternals(adapter).ensureGatewayClientReady = vi
    .fn()
    .mockResolvedValue(undefined);
  const resolveOwner = vi.fn().mockResolvedValue(null);
  adapter.setExecutionSessionResolver(resolveOwner);
  const [envelope] = await adapter.listPendingAskUserInteractions();
  expect(envelope.sessionId).toBe('');
  expect(envelope.request.origin).toMatchObject({
    sessionKey: pending.sessionKey,
    nativeSessionId: 'native-child',
    toolCallId: 'call-child',
    available: true,
  });
  expect(resolveOwner).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionKey: pending.sessionKey,
      nativeSessionId: 'native-child',
      lifecycleRevision: 'revision-1',
      runId: 'run-child',
    }),
  );
  await expect(
    adapter.resolveAskUserInteraction(pending.requestId, { behavior: 'cancel' }),
  ).resolves.toEqual({ sessionId: '' });
  expect(request).toHaveBeenLastCalledWith(AskUserQuestionGateway.RESOLVE, {
    requestId: pending.requestId,
    behavior: 'cancel',
    source: pending.source,
  });
});

test('a standalone plugin question is claimed without inventing an owner session; disable hides it without cancelling Native', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const pending = {
    ...createChildQuestion(),
    source: { ...createChildQuestion().source, ownerPluginId: 'agent-team' },
  };
  const request = vi.fn().mockResolvedValue({ requests: [pending] });
  getSessionPreparationInternals(adapter).gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request,
  };
  getSessionPreparationInternals(adapter).ensureGatewayClientReady = vi
    .fn()
    .mockResolvedValue(undefined);
  let enabled = true;
  adapter.setExecutionSessionResolver(async () =>
    enabled
      ? {
          pluginId: 'agent-team',
          nativePluginId: 'agent-team',
          epoch: 'epoch-1',
          label: 'Standalone · Worker',
        }
      : null,
  );
  expect((await adapter.listPendingAskUserInteractions())[0]).toMatchObject({
    sessionId: '',
    request: { origin: { pluginId: 'agent-team', label: 'Standalone · Worker', available: true } },
  });
  request.mockClear();
  sendToRenderer.mockClear();
  enabled = false;
  await adapter.refreshExecutionSessionInteractions();
  expect(sendToRenderer).toHaveBeenLastCalledWith(
    CoworkInteractionIpc.Stream,
    expect.objectContaining({
      request: expect.objectContaining({
        origin: expect.objectContaining({ pluginId: 'agent-team', available: false }),
      }),
    }),
  );
  await expect(
    adapter.resolveAskUserInteraction(pending.requestId, { behavior: 'cancel' }),
  ).rejects.toThrow('source is unavailable');
  expect(request).not.toHaveBeenCalled();
  enabled = true;
  await adapter.refreshExecutionSessionInteractions();
  expect(sendToRenderer).toHaveBeenLastCalledWith(
    CoworkInteractionIpc.Stream,
    expect.objectContaining({
      request: expect.objectContaining({ origin: expect.objectContaining({ available: true }) }),
    }),
  );
});

test('a first late event with Native-owned plugin provenance cannot fall back to an unclaimed question after disable', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  getSessionPreparationInternals(adapter).gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request: vi.fn(),
  };
  adapter.setExecutionSessionResolver(async () => null);
  adapter.handleGatewayEvent({
    event: AskUserQuestionGateway.REQUESTED_EVENT,
    payload: {
      ...createChildQuestion(),
      source: { ...createChildQuestion().source, ownerPluginId: 'swarm-workflow' },
    },
  });
  await adapter.refreshExecutionSessionInteractions();
  expect(sendToRenderer).toHaveBeenLastCalledWith(
    CoworkInteractionIpc.Stream,
    expect.objectContaining({
      request: expect.objectContaining({
        origin: expect.objectContaining({ available: false }),
      }),
    }),
  );
});

test('an affirmative Native-only source can ask independently without acquiring an App owner or losing its draft eligibility on unrelated refresh', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const pending = {
    ...createChildQuestion('native-only'),
    source: { ...createChildQuestion('native-only').source, ownerPluginId: 'native-worker' },
  };
  const request = vi.fn(async (method: string) =>
    method === AskUserQuestionGateway.LIST
      ? { requests: [pending] }
      : { requestId: pending.requestId, status: 'cancelled', source: pending.source },
  );
  getSessionPreparationInternals(adapter).gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request,
  };
  getSessionPreparationInternals(adapter).ensureGatewayClientReady = vi
    .fn()
    .mockResolvedValue(undefined);
  const resolver = vi.fn().mockResolvedValue(null);
  adapter.setExecutionSessionResolver(resolver, id => id === 'native-worker');

  const [envelope] = await adapter.listPendingAskUserInteractions();
  expect(envelope.sessionId).toBe('');
  expect(envelope.request.origin).toMatchObject({
    available: true,
    nativeSessionId: 'native-native-only',
  });
  expect(envelope.request.origin).not.toHaveProperty('pluginId');
  expect(resolver).not.toHaveBeenCalled();
  sendToRenderer.mockClear();
  await adapter.refreshExecutionSessionInteractions();
  expect(sendToRenderer).not.toHaveBeenCalled();
  await expect(
    adapter.resolveAskUserInteraction(pending.requestId, { behavior: 'cancel' }),
  ).resolves.toEqual({ sessionId: '' });
  expect(request).toHaveBeenLastCalledWith(AskUserQuestionGateway.RESOLVE, {
    requestId: pending.requestId,
    behavior: 'cancel',
    source: pending.source,
  });
});

test.each(['inventory-unknown', 'known-app', 'classification-failed'] as const)(
  'does not treat %s Native ownership as an affirmative Native-only source',
  async state => {
    const { store } = createEmptyStore();
    const adapter = new OpenClawRuntimeAdapter(store, {});
    const pending = {
      ...createChildQuestion(state),
      source: { ...createChildQuestion(state).source, ownerPluginId: 'plugin-worker' },
    };
    const request = vi.fn().mockResolvedValue({ requests: [pending] });
    getSessionPreparationInternals(adapter).gatewayClient = {
      start: vi.fn(),
      stop: vi.fn(),
      request,
    };
    getSessionPreparationInternals(adapter).ensureGatewayClientReady = vi
      .fn()
      .mockResolvedValue(undefined);
    adapter.setExecutionSessionResolver(
      async () => null,
      state === 'inventory-unknown'
        ? undefined
        : () => {
            if (state === 'classification-failed') throw new Error('Inventory unavailable');
            return false;
          },
    );
    const [envelope] = await adapter.listPendingAskUserInteractions();
    expect(envelope.request.origin?.available).toBe(false);
    await expect(
      adapter.resolveAskUserInteraction(pending.requestId, { behavior: 'cancel' }),
    ).rejects.toThrow('source is unavailable');
    expect(request).not.toHaveBeenCalledWith(AskUserQuestionGateway.RESOLVE, expect.anything());
  },
);

test('losing affirmative Native-only classification synchronously vetoes an outstanding independent question', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const pending = {
    ...createChildQuestion('inventory'),
    source: { ...createChildQuestion('inventory').source, ownerPluginId: 'native-worker' },
  };
  getSessionPreparationInternals(adapter).gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request: vi.fn().mockResolvedValue({ requests: [pending] }),
  };
  getSessionPreparationInternals(adapter).ensureGatewayClientReady = vi
    .fn()
    .mockResolvedValue(undefined);
  let nativeOnly = true;
  let complete!: (value: null) => void;
  const slow = new Promise<null>(resolve => {
    complete = resolve;
  });
  adapter.setExecutionSessionResolver(
    () => slow,
    () => nativeOnly,
  );
  expect((await adapter.listPendingAskUserInteractions())[0].request.origin?.available).toBe(true);

  sendToRenderer.mockClear();
  nativeOnly = false;
  const refreshing = adapter.refreshExecutionSessionInteractions();
  expect(sendToRenderer).toHaveBeenLastCalledWith(
    CoworkInteractionIpc.Stream,
    expect.objectContaining({
      request: expect.objectContaining({ origin: expect.objectContaining({ available: false }) }),
    }),
  );
  complete(null);
  await refreshing;
});

test('a previously claimed App cannot downgrade to a Native-only question after losing its owner', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const pending = {
    ...createChildQuestion('claimed'),
    source: { ...createChildQuestion('claimed').source, ownerPluginId: 'app-worker' },
  };
  getSessionPreparationInternals(adapter).gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request: vi.fn().mockResolvedValue({ requests: [pending] }),
  };
  getSessionPreparationInternals(adapter).ensureGatewayClientReady = vi
    .fn()
    .mockResolvedValue(undefined);
  let claimed = true;
  adapter.setExecutionSessionResolver(
    async () =>
      claimed
        ? { pluginId: 'app-worker', nativePluginId: 'app-worker', epoch: 'epoch', label: 'Worker' }
        : null,
    () => !claimed,
  );
  expect((await adapter.listPendingAskUserInteractions())[0].request.origin?.available).toBe(true);
  claimed = false;
  expect((await adapter.listPendingAskUserInteractions())[0].request.origin?.available).toBe(false);
  await expect(
    adapter.resolveAskUserInteraction(pending.requestId, { behavior: 'cancel' }),
  ).rejects.toThrow('source is unavailable');
});

test('keeps a plugin manifest identity distinct from its Native plugin owner while projecting a pending question', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const pending = {
    ...createChildQuestion(),
    source: { ...createChildQuestion().source, ownerPluginId: 'native-tools' },
  };
  const request = vi.fn().mockResolvedValue({ requests: [pending] });
  getSessionPreparationInternals(adapter).gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request,
  };
  getSessionPreparationInternals(adapter).ensureGatewayClientReady = vi
    .fn()
    .mockResolvedValue(undefined);
  adapter.setExecutionSessionResolver(async () => ({
    pluginId: 'display-tools',
    nativePluginId: 'native-tools',
    epoch: 'ui-epoch',
    label: 'Worker',
    ownerSessionId: 'session-1',
  }));
  expect((await adapter.listPendingAskUserInteractions())[0]).toMatchObject({
    sessionId: 'session-1',
    request: { origin: { pluginId: 'display-tools', epoch: 'ui-epoch', available: true } },
  });
  adapter.setExecutionSessionResolver(async () => ({
    pluginId: 'display-tools',
    nativePluginId: 'another-native',
    epoch: 'ui-epoch',
    label: 'Wrong owner',
    ownerSessionId: 'session-1',
  }));
  await adapter.refreshExecutionSessionInteractions();
  await expect(
    adapter.resolveAskUserInteraction(pending.requestId, { behavior: 'cancel' }),
  ).rejects.toThrow('source is unavailable');
});

test('a pending origin lookup cannot authorize a reply after a newer refresh retracts that source', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const pending = createChildQuestion();
  const request = vi.fn().mockResolvedValue({ requests: [pending] });
  getSessionPreparationInternals(adapter).gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request,
  };
  getSessionPreparationInternals(adapter).ensureGatewayClientReady = vi
    .fn()
    .mockResolvedValue(undefined);
  const owner = {
    pluginId: 'swarm-workflow',
    epoch: 'one',
    ownerSessionId: 'session-1',
    label: 'Node',
  };
  const resolver = vi.fn().mockResolvedValue(owner);
  adapter.setExecutionSessionResolver(resolver);
  await adapter.listPendingAskUserInteractions();
  let finish!: (value: typeof owner) => void;
  resolver
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(null);
  request.mockClear();
  const reply = adapter.resolveAskUserInteraction(pending.requestId, { behavior: 'cancel' });
  const failed = expect(reply).rejects.toThrow('source is unavailable');
  await adapter.refreshExecutionSessionInteractions();
  finish(owner);
  await failed;
  expect(request).not.toHaveBeenCalled();
});

test('withdraws an owned question immediately even while an earlier origin lookup is awaiting Native feedback', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const pending = createChildQuestion();
  const request = vi.fn().mockResolvedValue({ requests: [pending] });
  getSessionPreparationInternals(adapter).gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request,
  };
  getSessionPreparationInternals(adapter).ensureGatewayClientReady = vi
    .fn()
    .mockResolvedValue(undefined);
  const owner = {
    pluginId: 'display-owner',
    nativePluginId: 'native-owner',
    epoch: 'one',
    ownerSessionId: 'session-1',
  };
  const resolver = vi.fn().mockResolvedValue(owner);
  adapter.setExecutionSessionResolver(resolver);
  await adapter.listPendingAskUserInteractions();
  let finish!: (value: typeof owner) => void;
  resolver
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(null);
  sendToRenderer.mockClear();
  const refreshing = adapter.refreshExecutionSessionInteractions();
  const withdrawal = adapter.refreshExecutionSessionInteractions();
  expect(sendToRenderer).toHaveBeenCalledWith(
    CoworkInteractionIpc.Stream,
    expect.objectContaining({
      request: expect.objectContaining({ origin: expect.objectContaining({ available: false }) }),
    }),
  );
  const bindings = (
    adapter as unknown as {
      pendingAskUserBindings: Map<string, { origin: { available: boolean } }>;
    }
  ).pendingAskUserBindings;
  expect(bindings.get(pending.requestId)?.origin.available).toBe(false);
  request.mockClear();
  finish(owner);
  await Promise.all([refreshing, withdrawal]);
  expect(bindings.get(pending.requestId)?.origin.available).toBe(false);
  await expect(
    adapter.resolveAskUserInteraction(pending.requestId, { behavior: 'cancel' }),
  ).rejects.toThrow('source is unavailable');
  expect(request).not.toHaveBeenCalled();
});

test('an unrelated metadata notification keeps an already displayed child question eligible while its exact source is being rechecked', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const one = createChildQuestion('visible-source');
  const two = createChildQuestion('other-source');
  const request = vi.fn().mockResolvedValue({ requests: [one, two] });
  getSessionPreparationInternals(adapter).gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  getSessionPreparationInternals(adapter).ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  const owner = {
    pluginId: 'fixture-team', nativePluginId: 'fixture-team', epoch: 'current',
    ownerSessionId: 'session-1', label: 'Worker',
  };
  const resolver = vi.fn().mockResolvedValue(owner);
  adapter.setExecutionSessionResolver(resolver);
  expect(await adapter.listPendingAskUserInteractions()).toHaveLength(2);
  let finish!: (value: typeof owner) => void;
  resolver.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  sendToRenderer.mockClear();
  const refreshing = adapter.refreshExecutionSessionInteractions(true);
  expect(sendToRenderer).not.toHaveBeenCalledWith(CoworkInteractionIpc.Stream, expect.objectContaining({
    request: expect.objectContaining({ requestId: one.requestId, origin: expect.objectContaining({ available: false }) }),
  }));
  const bindings = (adapter as unknown as {
    pendingAskUserBindings: Map<string, { origin: { available: boolean } }>;
  }).pendingAskUserBindings;
  expect(bindings.get(one.requestId)?.origin.available).toBe(true);
  finish(owner);
  await refreshing;
  expect(bindings.get(one.requestId)?.origin.available).toBe(true);
  expect(sendToRenderer.mock.calls.filter(([channel, envelope]) =>
    channel === CoworkInteractionIpc.Stream && envelope.request?.origin?.available === false,
  )).toEqual([]);
});

test('a lifecycle withdrawal immediately hides a question despite an earlier metadata-only lookup and fences its late result', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const pending = createChildQuestion('metadata-then-disable');
  const request = vi.fn().mockResolvedValue({ requests: [pending] });
  getSessionPreparationInternals(adapter).gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  getSessionPreparationInternals(adapter).ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  const owner = {
    pluginId: 'fixture-team', nativePluginId: 'fixture-team', epoch: 'old', ownerSessionId: 'session-1',
  };
  const resolver = vi.fn().mockResolvedValue(owner);
  adapter.setExecutionSessionResolver(resolver);
  await adapter.listPendingAskUserInteractions();
  let finish!: (value: typeof owner) => void;
  resolver.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(null);
  sendToRenderer.mockClear();
  const metadata = adapter.refreshExecutionSessionInteractions(true);
  const retired = adapter.refreshExecutionSessionInteractions();
  expect(sendToRenderer).toHaveBeenCalledWith(CoworkInteractionIpc.Stream, expect.objectContaining({
    request: expect.objectContaining({ requestId: pending.requestId, origin: expect.objectContaining({ available: false }) }),
  }));
  sendToRenderer.mockClear();
  finish(owner);
  await Promise.all([metadata, retired]);
  expect(sendToRenderer).not.toHaveBeenCalledWith(CoworkInteractionIpc.Stream, expect.objectContaining({
    request: expect.objectContaining({ requestId: pending.requestId, origin: expect.objectContaining({ available: true }) }),
  }));
  request.mockClear();
  await expect(adapter.resolveAskUserInteraction(pending.requestId, { behavior: 'cancel' })).rejects.toThrow('source is unavailable');
  expect(request).not.toHaveBeenCalled();
});

test('preserving a displayed question during metadata refresh never grants permission to answer a newly unavailable source', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const pending = createChildQuestion('display-is-not-authority');
  const request = vi.fn().mockResolvedValue({ requests: [pending] });
  getSessionPreparationInternals(adapter).gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  getSessionPreparationInternals(adapter).ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  const owner = {
    pluginId: 'fixture-team', nativePluginId: 'fixture-team', epoch: 'current', ownerSessionId: 'session-1',
  };
  const resolver = vi.fn().mockResolvedValue(owner);
  adapter.setExecutionSessionResolver(resolver);
  await adapter.listPendingAskUserInteractions();
  let finish!: (value: typeof owner) => void;
  resolver.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(null);
  const metadata = adapter.refreshExecutionSessionInteractions(true);
  sendToRenderer.mockClear();
  request.mockClear();
  await expect(adapter.resolveAskUserInteraction(pending.requestId, { behavior: 'cancel' })).rejects.toThrow('source is unavailable');
  expect(request).not.toHaveBeenCalled();
  expect(sendToRenderer).toHaveBeenCalledWith(CoworkInteractionIpc.Stream, expect.objectContaining({
    request: expect.objectContaining({ requestId: pending.requestId, origin: expect.objectContaining({ available: false }) }),
  }));
  sendToRenderer.mockClear();
  finish(owner);
  await metadata;
  expect(sendToRenderer).not.toHaveBeenCalledWith(CoworkInteractionIpc.Stream, expect.objectContaining({
    request: expect.objectContaining({ requestId: pending.requestId, origin: expect.objectContaining({ available: true }) }),
  }));
});

async function ownedAnswerRaceFixture() {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const pending = createChildQuestion('reply-source-race');
  const request = vi.fn(async (method: string) => method === AskUserQuestionGateway.LIST
    ? { requests: [pending] }
    : { requestId: pending.requestId, status: 'cancelled', source: pending.source });
  getSessionPreparationInternals(adapter).gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  getSessionPreparationInternals(adapter).ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  const owner = {
    pluginId: 'fixture-team', nativePluginId: 'fixture-team', epoch: 'current', ownerSessionId: 'session-1',
  };
  const resolver = vi.fn().mockResolvedValue(owner);
  adapter.setExecutionSessionResolver(resolver);
  await adapter.listPendingAskUserInteractions();
  request.mockClear();
  resolver.mockClear();
  return { adapter, pending, request, resolver, owner };
}

test('external question views read only structured pending questions and receive validated invalidations', async () => {
  const f = await ownedAnswerRaceFixture();
  const changed = vi.fn();
  f.adapter.on(AskUserInteractionEvent.Changed, changed);
  await f.adapter.listPendingStructuredQuestions();
  expect(f.request).toHaveBeenCalledExactlyOnceWith(AskUserQuestionGateway.LIST, {});
  const next = createChildQuestion('live-question');
  f.adapter.handleGatewayEvent({ event: AskUserQuestionGateway.REQUESTED_EVENT, payload: next });
  await vi.waitFor(() => expect(changed).toHaveBeenCalledWith({ sessionId: 'session-1' }));
  f.adapter.handleGatewayEvent({ event: AskUserQuestionGateway.RESOLVED_EVENT,
    payload: { requestId: next.requestId, status: 'answered' } });
  expect(changed).toHaveBeenCalledWith({ requestId: next.requestId });
});

test('a withdrawn external question view cannot submit after asynchronous source verification', async () => {
  const f = await ownedAnswerRaceFixture();
  let project!: (value: typeof f.owner) => void;
  f.resolver.mockImplementationOnce(() => new Promise(resolve => { project = resolve; }));
  let current = true;
  const reply = f.adapter.resolveAskUserInteraction(f.pending.requestId, { behavior: 'cancel' }, {
    assertCurrent: () => { if (!current) throw new Error('View withdrawn'); },
  });
  current = false;
  project(f.owner);
  await expect(reply).rejects.toThrow('View withdrawn');
  expect(f.request).not.toHaveBeenCalled();
  await expect(f.adapter.resolveAskUserInteraction(f.pending.requestId, { behavior: 'cancel' }))
    .resolves.toEqual({ sessionId: 'session-1' });
});

test('two windows cannot send conflicting answers to the same question while a sibling remains independent', async () => {
  const f = await ownedAnswerRaceFixture();
  let confirm!: (value: { requestId: string; status: string; source: typeof f.pending.source }) => void;
  f.request.mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
  const first = f.adapter.resolveAskUserInteraction(f.pending.requestId, { behavior: 'cancel' });
  await vi.waitFor(() => expect(confirm).toBeTypeOf('function'));

  await expect(f.adapter.resolveAskUserInteraction(f.pending.requestId, {
    behavior: 'submit', answers: { deploy_target: { selected: ['production'] } },
  })).rejects.toThrow('already being answered');
  expect(f.request).toHaveBeenCalledTimes(1);

  const sibling = createChildQuestion('unblocked-sibling');
  f.adapter.handleGatewayEvent({ event: AskUserQuestionGateway.REQUESTED_EVENT, payload: sibling });
  f.request.mockImplementationOnce(async () => ({
    requestId: sibling.requestId, status: 'cancelled', source: sibling.source,
  }));
  await expect(f.adapter.resolveAskUserInteraction(sibling.requestId, { behavior: 'cancel' }))
    .resolves.toEqual({ sessionId: 'session-1' });
  confirm({ requestId: f.pending.requestId, status: 'cancelled', source: f.pending.source });
  await expect(first).resolves.toEqual({ sessionId: 'session-1' });
  expect(f.request).toHaveBeenNthCalledWith(2, AskUserQuestionGateway.RESOLVE, {
    requestId: sibling.requestId, behavior: 'cancel', source: sibling.source,
  });
});

test('two windows claim a question before any source lookup can start a competing answer', async () => {
  const f = await ownedAnswerRaceFixture();
  let project!: (value: typeof f.owner) => void;
  f.resolver.mockImplementationOnce(() => new Promise(resolve => { project = resolve; }));
  const first = f.adapter.resolveAskUserInteraction(f.pending.requestId, { behavior: 'cancel' });
  await expect(f.adapter.resolveAskUserInteraction(f.pending.requestId, { behavior: 'cancel' }))
    .rejects.toThrow('already being answered');
  expect(f.resolver).toHaveBeenCalledTimes(1);
  expect(f.request).not.toHaveBeenCalled();
  project(f.owner);
  await expect(first).resolves.toEqual({ sessionId: 'session-1' });
  expect(f.request).toHaveBeenCalledTimes(1);
});

test('an uncertain answer stays claimed until a newer pending read proves that exact request still waits', async () => {
  const f = await ownedAnswerRaceFixture();
  let snapshot!: (value: { requests: (typeof f.pending)[] }) => void;
  f.request.mockImplementationOnce(() => new Promise(resolve => { snapshot = resolve; }));
  const olderRead = f.adapter.listPendingAskUserInteractions();
  f.request.mockRejectedValueOnce(new Error('Acknowledgement lost'))
    .mockRejectedValueOnce(new Error('Pending read unavailable'));
  await expect(f.adapter.resolveAskUserInteraction(f.pending.requestId, { behavior: 'cancel' }))
    .rejects.toThrow('Acknowledgement lost');
  snapshot({ requests: [f.pending] });
  await olderRead;
  f.request.mockClear();
  f.request.mockRejectedValueOnce(new Error('Pending read still unavailable'));
  await expect(f.adapter.resolveAskUserInteraction(f.pending.requestId, { behavior: 'cancel' }))
    .rejects.toThrow('Pending read still unavailable');
  expect(f.request).toHaveBeenCalledExactlyOnceWith(AskUserQuestionGateway.LIST, {});

  f.request.mockImplementationOnce(async () => ({ requests: [f.pending] }));
  f.request.mockClear();
  await expect(f.adapter.resolveAskUserInteraction(f.pending.requestId, { behavior: 'cancel' }))
    .resolves.toEqual({ sessionId: 'session-1' });
  expect(f.request).toHaveBeenCalledTimes(2);
  expect(f.request).toHaveBeenNthCalledWith(1, AskUserQuestionGateway.LIST, {});
  expect(f.request).toHaveBeenNthCalledWith(2, AskUserQuestionGateway.RESOLVE, {
    requestId: f.pending.requestId, behavior: 'cancel', source: f.pending.source,
  });
});

test('a failed answer reconciles without replay and a confirmed pending request accepts a later explicit retry', async () => {
  const f = await ownedAnswerRaceFixture();
  f.request.mockRejectedValueOnce(new Error('Acknowledgement lost'));
  await expect(f.adapter.resolveAskUserInteraction(f.pending.requestId, { behavior: 'cancel' }))
    .rejects.toThrow('Acknowledgement lost');
  expect(f.request).toHaveBeenCalledTimes(2);
  expect(f.request).toHaveBeenNthCalledWith(1, AskUserQuestionGateway.RESOLVE, {
    requestId: f.pending.requestId, behavior: 'cancel', source: f.pending.source,
  });
  expect(f.request).toHaveBeenNthCalledWith(2, AskUserQuestionGateway.LIST, {});
  f.request.mockClear();
  await expect(f.adapter.resolveAskUserInteraction(f.pending.requestId, { behavior: 'cancel' }))
    .resolves.toEqual({ sessionId: 'session-1' });
  expect(f.request).toHaveBeenCalledTimes(1);
});

test('two explicit retries cannot use an older pending confirmation to release a newer window claim', async () => {
  const f = await ownedAnswerRaceFixture();
  f.request.mockRejectedValueOnce(new Error('Acknowledgement lost'))
    .mockRejectedValueOnce(new Error('Pending read unavailable'));
  await expect(f.adapter.resolveAskUserInteraction(f.pending.requestId, { behavior: 'cancel' }))
    .rejects.toThrow('Acknowledgement lost');
  f.request.mockClear();
  let confirmFirst!: (value: { requests: (typeof f.pending)[] }) => void;
  let confirmSecond!: (value: { requests: (typeof f.pending)[] }) => void;
  let confirmAnswer!: (value: { requestId: string; status: string; source: typeof f.pending.source }) => void;
  f.request
    .mockImplementationOnce(() => new Promise(resolve => { confirmFirst = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { confirmSecond = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { confirmAnswer = resolve; }));
  const first = f.adapter.resolveAskUserInteraction(f.pending.requestId, { behavior: 'cancel' });
  const second = f.adapter.resolveAskUserInteraction(f.pending.requestId, { behavior: 'cancel' });
  const rejected = expect(second).rejects.toThrow('already being answered');
  confirmFirst({ requests: [f.pending] });
  await vi.waitFor(() => expect(confirmAnswer).toBeTypeOf('function'));
  confirmSecond({ requests: [f.pending] });
  await rejected;
  confirmAnswer({ requestId: f.pending.requestId, status: 'cancelled', source: f.pending.source });
  await expect(first).resolves.toEqual({ sessionId: 'session-1' });
  expect(f.request.mock.calls.filter(([method]) => method === AskUserQuestionGateway.RESOLVE))
    .toHaveLength(1);
});

test.each(['withdrawal', 'reconnect'] as const)(
  'an explicit retry cannot cross a %s while its pending confirmation waits', async change => {
    const f = await ownedAnswerRaceFixture();
    f.request.mockRejectedValueOnce(new Error('Acknowledgement lost'))
      .mockRejectedValueOnce(new Error('Pending read unavailable'));
    await expect(f.adapter.resolveAskUserInteraction(f.pending.requestId, { behavior: 'cancel' }))
      .rejects.toThrow('Acknowledgement lost');
    f.request.mockClear();
    let confirm!: (value: { requests: (typeof f.pending)[] }) => void;
    f.request.mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
    const retry = f.adapter.resolveAskUserInteraction(f.pending.requestId, { behavior: 'cancel' });
    const rejected = expect(retry).rejects.toThrow(change === 'withdrawal'
      ? 'source is unavailable' : 'connection changed');
    if (change === 'withdrawal') {
      f.resolver.mockResolvedValue(null);
      await f.adapter.refreshExecutionSessionInteractions();
      f.resolver.mockResolvedValue({ ...f.owner, epoch: 'replacement' });
      await f.adapter.refreshExecutionSessionInteractions(true);
    } else getSessionPreparationInternals(f.adapter).gatewayClientGeneration++;
    confirm({ requests: [f.pending] });
    await rejected;
    expect(f.request).toHaveBeenCalledExactlyOnceWith(AskUserQuestionGateway.LIST, {});
  },
);

test('an answer lost in transit is dismissed when the later authoritative pending snapshot no longer contains it', async () => {
  const f = await ownedAnswerRaceFixture();
  f.request.mockRejectedValueOnce(new Error('Acknowledgement lost'))
    .mockImplementationOnce(async () => ({ requests: [] }));
  sendToRenderer.mockClear();
  await expect(f.adapter.resolveAskUserInteraction(f.pending.requestId, { behavior: 'cancel' }))
    .rejects.toThrow('Acknowledgement lost');
  expect(sendToRenderer).toHaveBeenCalledWith(CoworkInteractionIpc.Dismiss, {
    requestId: f.pending.requestId,
  });
  f.request.mockClear();
  await expect(f.adapter.resolveAskUserInteraction(f.pending.requestId, { behavior: 'cancel' }))
    .rejects.toThrow('not an active');
  expect(f.request).not.toHaveBeenCalled();
});

test('a failed source check releases its unsent claim without treating it as an uncertain Native answer', async () => {
  const f = await ownedAnswerRaceFixture();
  f.resolver.mockResolvedValueOnce(null);
  await expect(f.adapter.resolveAskUserInteraction(f.pending.requestId, { behavior: 'cancel' }))
    .rejects.toThrow('source is unavailable');
  expect(f.request).not.toHaveBeenCalled();
  await expect(f.adapter.resolveAskUserInteraction(f.pending.requestId, { behavior: 'cancel' }))
    .resolves.toEqual({ sessionId: 'session-1' });
  expect(f.request).toHaveBeenCalledTimes(1);
});

test('a same-object Gateway reconnect during source lookup cannot send an old window answer', async () => {
  const f = await ownedAnswerRaceFixture();
  let project!: (value: typeof f.owner) => void;
  f.resolver.mockImplementationOnce(() => new Promise(resolve => { project = resolve; }));
  const first = f.adapter.resolveAskUserInteraction(f.pending.requestId, { behavior: 'cancel' });
  const rejected = expect(first).rejects.toThrow('source is unavailable');
  getSessionPreparationInternals(f.adapter).gatewayClientGeneration += 1;
  project(f.owner);
  await rejected;
  expect(f.request).not.toHaveBeenCalled();
});

test('an unrelated metadata refresh cannot reject a valid reply whose exact source lookup is awaiting', async () => {
  const f = await ownedAnswerRaceFixture();
  let finish!: (value: typeof f.owner) => void;
  f.resolver.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const reply = f.adapter.resolveAskUserInteraction(f.pending.requestId, { behavior: 'cancel' });
  const accepted = expect(reply).resolves.toEqual({ sessionId: 'session-1' });
  await f.adapter.refreshExecutionSessionInteractions(true);
  finish(f.owner);
  await accepted;
  expect(f.resolver).toHaveBeenCalledTimes(3);
  expect(f.request).toHaveBeenCalledExactlyOnceWith(AskUserQuestionGateway.RESOLVE, {
    requestId: f.pending.requestId, behavior: 'cancel', source: f.pending.source,
  });
});

test('negative source metadata prevents an awaiting reply from performing a new admission or Native answer', async () => {
  const f = await ownedAnswerRaceFixture();
  let finish!: (value: typeof f.owner) => void;
  f.resolver.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(null);
  const reply = f.adapter.resolveAskUserInteraction(f.pending.requestId, { behavior: 'cancel' });
  const rejected = expect(reply).rejects.toThrow('source is unavailable');
  await f.adapter.refreshExecutionSessionInteractions(true);
  finish(f.owner);
  await rejected;
  expect(f.resolver).toHaveBeenCalledTimes(2);
  expect(f.request).not.toHaveBeenCalled();
});

test('a second metadata change during the one allowed reply source recheck is rejected without a third read or Native send', async () => {
  const f = await ownedAnswerRaceFixture();
  let finish!: (value: typeof f.owner) => void;
  let revalidated!: (value: typeof f.owner) => void;
  f.resolver.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const reply = f.adapter.resolveAskUserInteraction(f.pending.requestId, { behavior: 'cancel' });
  const rejected = expect(reply).rejects.toThrow('source is unavailable');
  await f.adapter.refreshExecutionSessionInteractions(true);
  f.resolver.mockImplementationOnce(() => new Promise(resolve => { revalidated = resolve; }));
  finish(f.owner);
  await vi.waitFor(() => expect(revalidated).toBeTypeOf('function'));
  await f.adapter.refreshExecutionSessionInteractions(true);
  revalidated(f.owner);
  await rejected;
  expect(f.resolver).toHaveBeenCalledTimes(4);
  expect(f.request).not.toHaveBeenCalled();
});

test('a lifecycle withdrawal cannot revive an old reply even if a new epoch restores question visibility before its lookup returns', async () => {
  const f = await ownedAnswerRaceFixture();
  let finish!: (value: typeof f.owner) => void;
  f.resolver.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(null);
  const reply = f.adapter.resolveAskUserInteraction(f.pending.requestId, { behavior: 'cancel' });
  const rejected = expect(reply).rejects.toThrow('source is unavailable');
  await f.adapter.refreshExecutionSessionInteractions();
  f.resolver.mockResolvedValue({ ...f.owner, epoch: 'replacement' });
  await f.adapter.refreshExecutionSessionInteractions(true);
  finish(f.owner);
  await rejected;
  expect(f.resolver).toHaveBeenCalledTimes(3);
  expect(f.request).not.toHaveBeenCalled();
});

test('an authoritative pending list removes only missing questions without cancelling sibling Native execution', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  let requests = [createChildQuestion('one'), createChildQuestion('two')];
  const request = vi.fn().mockImplementation(async () => ({ requests }));
  getSessionPreparationInternals(adapter).gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request,
  };
  getSessionPreparationInternals(adapter).ensureGatewayClientReady = vi
    .fn()
    .mockResolvedValue(undefined);
  await adapter.listPendingAskUserInteractions();
  requests = requests.slice(1);
  sendToRenderer.mockClear();
  expect(await adapter.listPendingAskUserInteractions()).toHaveLength(1);
  expect(sendToRenderer).toHaveBeenCalledWith(CoworkInteractionIpc.Dismiss, {
    requestId: 'ask_one',
  });
  expect(request.mock.calls.every(([method]) => method !== AskUserQuestionGateway.RESOLVE)).toBe(
    true,
  );
});

test.each([false, true])(
  'keeps an independent member question in its own product chat (Native owner: %s)',
  async owned => {
    const { store } = createEmptyStore();
    const adapter = new OpenClawRuntimeAdapter(store, {});
    const child = createChildQuestion('member-local');
    const pending = {
      ...child,
      sessionKey: 'agent:main:justdo:session-1',
      source: {
        ...child.source,
        sessionKey: 'agent:main:justdo:session-1',
        ...(owned ? { ownerPluginId: 'fixture-team' } : {}),
      },
    };
    const request = vi.fn(async (method: string) =>
      method === AskUserQuestionGateway.LIST
        ? { requests: [pending] }
        : { requestId: pending.requestId, status: 'cancelled', source: pending.source },
    );
    getSessionPreparationInternals(adapter).gatewayClient = {
      start: vi.fn(), stop: vi.fn(), request,
    };
    getSessionPreparationInternals(adapter).ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
    adapter.setExecutionSessionResolver(async () => ({
      pluginId: 'fixture-team', nativePluginId: 'fixture-team', epoch: 'current',
      ownerSessionId: 'session-1', label: 'Member',
    }));

    const [interaction] = await adapter.listPendingAskUserInteractions();
    expect(interaction).toMatchObject({
      sessionId: 'session-1',
      request: { origin: { ownerSessionId: 'session-1', available: true } },
    });
    await expect(adapter.resolveAskUserInteraction(pending.requestId, { behavior: 'cancel' }))
      .resolves.toEqual({ sessionId: 'session-1' });
    expect(request).toHaveBeenLastCalledWith(AskUserQuestionGateway.RESOLVE, {
      requestId: pending.requestId, behavior: 'cancel', source: pending.source,
    });
  },
);

test('answering one child while a sibling source lookup awaits preserves the other exact pending request', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const one = createChildQuestion('parallel-one');
  const two = createChildQuestion('parallel-two');
  const request = vi.fn(async (method: string, params: { requestId?: string }) => {
    if (method === AskUserQuestionGateway.LIST) return { requests: [one, two] };
    const pending = params.requestId === one.requestId ? one : two;
    return { requestId: pending.requestId, status: 'cancelled', source: pending.source };
  });
  getSessionPreparationInternals(adapter).gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  getSessionPreparationInternals(adapter).ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  const resolver = vi.fn().mockResolvedValue(null);
  adapter.setExecutionSessionResolver(resolver);
  expect(await adapter.listPendingAskUserInteractions()).toHaveLength(2);
  let finish!: (value: null) => void;
  resolver.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const firstReply = adapter.resolveAskUserInteraction(one.requestId, { behavior: 'cancel' });
  sendToRenderer.mockClear();
  await expect(adapter.resolveAskUserInteraction(two.requestId, { behavior: 'cancel' }))
    .resolves.toEqual({ sessionId: '' });
  expect(sendToRenderer).toHaveBeenCalledWith(CoworkInteractionIpc.Dismiss, { requestId: two.requestId });
  expect(sendToRenderer).not.toHaveBeenCalledWith(CoworkInteractionIpc.Dismiss, { requestId: one.requestId });
  finish(null);
  await expect(firstReply).resolves.toEqual({ sessionId: '' });
  expect(request.mock.calls.filter(([method]) => method === AskUserQuestionGateway.RESOLVE)
    .map(([, params]) => params.requestId)).toEqual([two.requestId, one.requestId]);
});

test.each(['sessionKey', 'nativeSessionId', 'runId', 'toolCallId', 'lifecycleRevision'] as const)(
  'does not dismiss a question when the Native answer receipt changes its %s',
  async field => {
    const { store } = createEmptyStore();
    const adapter = new OpenClawRuntimeAdapter(store, {});
    const pending = createChildQuestion('receipt');
    let invalid = true;
    const request = vi.fn(async (method: string) => method === AskUserQuestionGateway.LIST
      ? { requests: [pending] }
      : {
          requestId: pending.requestId,
          status: 'cancelled',
          source: invalid ? { ...pending.source, [field]: 'different' } : pending.source,
        });
    getSessionPreparationInternals(adapter).gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
    getSessionPreparationInternals(adapter).ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
    await adapter.listPendingAskUserInteractions();
    sendToRenderer.mockClear();
    await expect(adapter.resolveAskUserInteraction(pending.requestId, { behavior: 'cancel' }))
      .rejects.toThrow('invalid payload');
    expect(sendToRenderer).not.toHaveBeenCalledWith(CoworkInteractionIpc.Dismiss, { requestId: pending.requestId });
    invalid = false;
    expect((await adapter.listPendingAskUserInteractions()).map(item => item.request.requestId))
      .toEqual([pending.requestId]);
  },
);

test('a failed pending read preserves both child questions until an authoritative recovery removes one', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const one = createChildQuestion('recovery-one');
  const two = createChildQuestion('recovery-two');
  const request = vi.fn().mockResolvedValue({ requests: [one, two] });
  getSessionPreparationInternals(adapter).gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  getSessionPreparationInternals(adapter).ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  expect(await adapter.listPendingAskUserInteractions()).toHaveLength(2);
  request.mockRejectedValueOnce(new Error('Transport unavailable'));
  sendToRenderer.mockClear();
  await expect(adapter.listPendingAskUserInteractions()).rejects.toThrow('Transport unavailable');
  expect(sendToRenderer).not.toHaveBeenCalled();
  request.mockResolvedValue({ requests: [one, two] });
  expect((await adapter.listPendingAskUserInteractions()).map(item => item.request.requestId))
    .toEqual([one.requestId, two.requestId]);
  request.mockResolvedValue({ requests: [two] });
  expect((await adapter.listPendingAskUserInteractions()).map(item => item.request.requestId))
    .toEqual([two.requestId]);
  expect(sendToRenderer).toHaveBeenCalledWith(CoworkInteractionIpc.Dismiss, { requestId: one.requestId });
  expect(sendToRenderer).not.toHaveBeenCalledWith(CoworkInteractionIpc.Dismiss, { requestId: two.requestId });
});

test('holds a question without guessing its parent until the exact delayed execution receipt becomes available', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const pending = createChildQuestion('delayed-admission');
  const request = vi.fn(async (method: string) => method === AskUserQuestionGateway.LIST
    ? { requests: [pending] }
    : { requestId: pending.requestId, status: 'cancelled', source: pending.source });
  getSessionPreparationInternals(adapter).gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  getSessionPreparationInternals(adapter).ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  let admitted = false;
  adapter.setExecutionSessionResolver(async () => ({
    pluginId: 'fixture-team', nativePluginId: 'fixture-team', epoch: 'same-epoch',
    ownerSessionId: 'session-1', ...(admitted ? {} : { pending: true as const }),
  }));
  const [held] = await adapter.listPendingAskUserInteractions();
  expect(held.request.origin).toMatchObject({ pluginId: 'fixture-team', available: false });
  request.mockClear();
  await expect(adapter.resolveAskUserInteraction(pending.requestId, { behavior: 'cancel' }))
    .rejects.toThrow('source is unavailable');
  expect(request).not.toHaveBeenCalled();
  admitted = true;
  sendToRenderer.mockClear();
  await adapter.refreshExecutionSessionInteractions(true);
  expect(sendToRenderer).toHaveBeenLastCalledWith(CoworkInteractionIpc.Stream, expect.objectContaining({
    sessionId: 'session-1', request: expect.objectContaining({
      requestId: pending.requestId, origin: expect.objectContaining({ available: true }),
    }),
  }));
  await expect(adapter.resolveAskUserInteraction(pending.requestId, { behavior: 'cancel' }))
    .resolves.toEqual({ sessionId: 'session-1' });
  expect(request).toHaveBeenCalledExactlyOnceWith(AskUserQuestionGateway.RESOLVE, {
    requestId: pending.requestId, behavior: 'cancel', source: pending.source,
  });
});

const createApprovedPlanArtifactStore = (
  verifiedMarkdown = '1. Inspect\n2. Implement\n3. Verify',
) => ({
  publish: vi.fn(
    (input: { workspaceRoot: string; sessionId: string; planId: string; markdown: string }) => ({
      sessionId: input.sessionId,
      planId: input.planId,
      workspaceRoot: input.workspaceRoot,
      relativePath: `.${PRODUCT_NAME_LOWERCASE}/plans/${input.sessionId}/${input.planId}.md`,
      sha256: createHash('sha256').update(input.markdown.replace(/\r\n?/g, '\n')).digest('hex'),
      byteLength: Buffer.byteLength(input.markdown),
    }),
  ),
  readVerified: vi.fn(() => verifiedMarkdown),
});

const seedPresentedPlan = (
  adapter: OpenClawRuntimeAdapter,
  request: ReturnType<typeof createPlanModeRequest>,
) => {
  const internals = adapter as unknown as {
    persistAndVerifyPresentedPlan: (sessionId: string, request: unknown) => unknown;
    pendingPlanModeRequests: Map<string, unknown>;
  };
  internals.persistAndVerifyPresentedPlan('session-1', request);
  internals.pendingPlanModeRequests.set(request.requestId, request);
};

test.each(['answered', 'cancelled', 'timeout'])(
  'forwards AskUserQuestion events and dismisses the question after %s',
  status => {
    sendToRenderer.mockClear();
    const { store } = createEmptyStore();
    const adapter = new OpenClawRuntimeAdapter(store, {});
    const request = createAskUserRequest();
    getSessionPreparationInternals(adapter).gatewayClient = {
      start: vi.fn(),
      stop: vi.fn(),
      request: vi.fn(),
    };

    adapter.handleGatewayEvent({
      event: AskUserQuestionGateway.REQUESTED_EVENT,
      payload: request,
    });

    expect(sendToRenderer).toHaveBeenCalledWith(CoworkInteractionIpc.Stream, {
      sessionId: 'session-1',
      request: expect.objectContaining({
        requestId: request.requestId,
        toolName: 'ask_user_question',
        toolInput: expect.objectContaining({ waitPolicy: { mode: 'required' } }),
      }),
    });

    adapter.handleGatewayEvent({
      event: AskUserQuestionGateway.RESOLVED_EVENT,
      payload: { requestId: request.requestId, status },
    });
    expect(sendToRenderer).toHaveBeenCalledWith(CoworkInteractionIpc.Dismiss, {
      requestId: request.requestId,
    });
  },
);

test('resets context and starts an approved plan on the same OpenClaw session', async () => {
  const { store, planHandoffs } = createEmptyStore();
  const verifiedPlan = 'Verified approved plan';
  const artifactStore = createApprovedPlanArtifactStore(verifiedPlan);
  const adapter = new OpenClawRuntimeAdapter(store, {}, undefined, artifactStore);
  adapter.on('error', () => undefined);
  const planRequest = createPlanModeRequest();
  planRequest.plan = verifiedPlan;
  seedPresentedPlan(adapter, planRequest);
  const request = vi.fn(async (method: string, _params?: Record<string, unknown>) => {
    if (method === PlanModeGateway.RESOLVE) {
      return { requestId: planRequest.requestId, decision: 'implement' };
    }
    if (method === 'sessions.describe') {
      return {
        session: {
          key: planRequest.sessionKey,
          sessionId: 'gateway-session-1',
          permissionMode: 'full',
          sessionRoot: process.cwd(),
          modelProvider: 'openai',
          model: 'gpt-5',
        },
      };
    }
    if (method === 'sessions.reset') {
      return {
        ok: true,
        key: planRequest.sessionKey,
        entry: { sessionId: 'gateway-session-1' },
      };
    }
    if (method === 'automationPermission.info') {
      return { loaded: true, policyId: 'native-session-automation-permission' };
    }
    if (method === 'sessions.create') return createPreparedSessionReceipt();
    if (method === 'sessions.pluginPatch') return { ok: true };
    if (method === 'chat.send') return { runId: 'implementation-run-1' };
    throw new Error(`Unexpected method: ${method}`);
  });
  const internals = getSessionPreparationInternals(adapter);
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  const activeTurns = (adapter as unknown as { activeTurns: Map<string, SessionTurn> }).activeTurns;
  const planningTurn = createSessionTurn({ runId: 'planning-run' });
  activeTurns.set('session-1', planningTurn);
  const stopSessionInternal = vi
    .spyOn(
      adapter as unknown as {
        stopSessionInternal: (
          sessionId: string,
          options: Record<string, unknown>,
          cancelPendingStart: boolean,
        ) => Promise<void>;
      },
      'stopSessionInternal',
    )
    .mockImplementation(async sessionId => {
      activeTurns.delete(sessionId);
    });

  await expect(
    adapter.resolveAskUserInteraction(planRequest.requestId, {
      behavior: 'plan',
      decision: 'implement',
    }),
  ).resolves.toEqual({ sessionId: 'session-1' });

  expect(request).toHaveBeenCalledWith('sessions.reset', {
    key: planRequest.sessionKey,
    agentId: 'main',
    reason: 'reset',
    expectedSessionId: 'gateway-session-1',
  });
  expect(stopSessionInternal).toHaveBeenCalledWith('session-1', {}, false);
  expect(stopSessionInternal.mock.invocationCallOrder[0]).toBeLessThan(
    request.mock.invocationCallOrder[
      request.mock.calls.findIndex(([method]) => method === 'sessions.reset')
    ],
  );
  expect(request).toHaveBeenCalledWith(
    'chat.send',
    expect.objectContaining({
      sessionKey: planRequest.sessionKey,
      message: expect.stringContaining(verifiedPlan),
      justdoHideUserMessage: true,
      idempotencyKey: `justdo-plan-implementation-${planRequest.requestId}`,
    }),
  );
  expect(request.mock.calls.filter(([method]) => method === 'sessions.create')).toHaveLength(1);
  expect(planHandoffs.get(planRequest.requestId)).toMatchObject({
    state: 'resolved',
    planningSessionKey: planRequest.sessionKey,
    implementationSessionKey: planRequest.sessionKey,
    implementationGatewaySessionId: 'gateway-session-1',
    implementationRunId: 'implementation-run-1',
  });
});

test.each(['connection changed', 'session replaced'])(
  'does not dispatch implementation when reset is unsafe: %s',
  async failure => {
    const { store, planHandoffs } = createEmptyStore();
    const adapter = new OpenClawRuntimeAdapter(
      store,
      {},
      undefined,
      createApprovedPlanArtifactStore('Verified approved plan'),
    );
    const planRequest = createPlanModeRequest();
    planRequest.plan = 'Verified approved plan';
    seedPresentedPlan(adapter, planRequest);
    const internals = getSessionPreparationInternals(adapter);
    const request = vi.fn(async (method: string) => {
      if (method === PlanModeGateway.RESOLVE) {
        return { requestId: planRequest.requestId, decision: 'implement' };
      }
      if (method === 'sessions.describe') {
        if (failure === 'connection changed') internals.gatewayClient = null;
        return { session: { sessionId: 'gateway-session-1' } };
      }
      if (method === 'sessions.reset') throw new Error('session-changed');
      throw new Error(`Unexpected method: ${method}`);
    });
    internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
    internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);

    await expect(
      adapter.resolveAskUserInteraction(planRequest.requestId, {
        behavior: 'plan',
        decision: 'implement',
      }),
    ).rejects.toThrow(failure === 'connection changed' ? 'connection changed' : 'session-changed');

    expect(request.mock.calls.some(([method]) => method === 'chat.send')).toBe(false);
    expect(request.mock.calls.some(([method]) => method === 'sessions.reset')).toBe(
      failure === 'session replaced',
    );
    expect(planHandoffs.get(planRequest.requestId)?.state).toBe('dispatching');
  },
);

test('admits an approved plan when chat.send acknowledgement is lost but activity is observed', async () => {
  const { store, planHandoffs } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(
    store,
    {},
    undefined,
    createApprovedPlanArtifactStore('Verified approved plan'),
  );
  adapter.on('error', () => undefined);
  const planRequest = createPlanModeRequest();
  planRequest.plan = 'Verified approved plan';
  seedPresentedPlan(adapter, planRequest);
  const implementationRunId = `justdo-plan-implementation-${planRequest.requestId}`;
  const request = vi.fn(async (method: string) => {
    if (method === PlanModeGateway.RESOLVE) {
      return { requestId: planRequest.requestId, decision: 'implement' };
    }
    if (method === 'sessions.describe') {
      return {
        session: { key: planRequest.sessionKey, agentId: 'main', sessionId: 'gateway-session-1' },
      };
    }
    if (method === 'sessions.reset') {
      return {
        ok: true,
        key: planRequest.sessionKey,
        entry: { sessionId: 'gateway-session-1' },
      };
    }
    if (method === 'automationPermission.info') {
      return { loaded: true, policyId: 'native-session-automation-permission' };
    }
    if (method === 'sessions.create') return createPreparedSessionReceipt();
    if (method === 'sessions.pluginPatch') return { ok: true };
    if (method === 'chat.send') {
      const error = new Error('request timeout: chat.send') as Error & {
        code: string;
        requestSent: boolean;
      };
      error.code = 'CLIENT_TIMEOUT';
      error.requestSent = true;
      throw error;
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  const internals = getSessionPreparationInternals(adapter);
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);

  const resolving = adapter.resolveAskUserInteraction(planRequest.requestId, {
    behavior: 'plan',
    decision: 'implement',
  });
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith('chat.send', expect.anything()));
  await vi.waitFor(() =>
    expect(
      (
        adapter as unknown as {
          unknownSessionRuns: Map<string, { runId: string }>;
        }
      ).unknownSessionRuns.get('session-1'),
    ).toMatchObject({ runId: implementationRunId }),
  );

  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      seq: 1,
      runId: implementationRunId,
      sessionKey: planRequest.sessionKey,
      stream: 'lifecycle',
      data: { phase: 'start' },
    },
  });

  await expect(resolving).resolves.toEqual({ sessionId: 'session-1' });
  expect(planHandoffs.get(planRequest.requestId)).toMatchObject({
    state: 'resolved',
    implementationRunId,
  });
});

test('disables Plan mode before resolving an admitted implementation during recovery', async () => {
  const { store, planHandoffs } = createEmptyStore();
  const artifactStore = createApprovedPlanArtifactStore();
  const planRequest = createPlanModeRequest();
  const firstAdapter = new OpenClawRuntimeAdapter(store, {}, undefined, artifactStore);
  seedPresentedPlan(firstAdapter, planRequest);
  store.transitionPlanHandoff({
    planId: planRequest.requestId,
    expectedState: 'presented',
    nextState: 'admitted',
    transitionedAt: Date.now(),
    implementationSessionKey: planRequest.sessionKey,
    implementationGatewaySessionId: 'implementation-session-1',
    implementationRunId: 'implementation-run-1',
  });

  const adapter = new OpenClawRuntimeAdapter(store, {}, undefined, artifactStore);
  let planModeEnabled = true;
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === AskUserQuestionGateway.LIST) return { requests: [] };
    if (method === PlanModeGateway.LIST) return { requests: [planRequest] };
    if (method === 'sessions.pluginPatch') {
      planModeEnabled = (params?.value as { enabled?: boolean } | undefined)?.enabled ?? true;
      return { ok: true };
    }
    if (method === PlanModeGateway.RESOLVE) {
      if (planModeEnabled) throw new Error('Disable Plan mode before approving implementation.');
      return { requestId: planRequest.requestId, decision: 'implement' };
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  const internals = getSessionPreparationInternals(adapter);
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);

  await expect(adapter.listPendingAskUserInteractions()).resolves.toEqual([]);

  expect(request.mock.calls.map(([method]) => method)).toEqual([
    AskUserQuestionGateway.LIST,
    PlanModeGateway.LIST,
    'sessions.pluginPatch',
    PlanModeGateway.RESOLVE,
    'sessions.pluginPatch',
  ]);
  expect(planHandoffs.get(planRequest.requestId)?.state).toBe('resolved');
});

test('does not expose a plan approval when durable artifact publication fails', async () => {
  sendToRenderer.mockClear();
  const { store } = createEmptyStore();
  const artifactStore = createApprovedPlanArtifactStore();
  artifactStore.publish.mockImplementation(() => {
    throw new Error('disk full');
  });
  const adapter = new OpenClawRuntimeAdapter(store, {}, undefined, artifactStore);
  const planRequest = createPlanModeRequest();
  const request = vi.fn().mockResolvedValue({
    requestId: planRequest.requestId,
    decision: 'cancel',
  });
  const internals = getSessionPreparationInternals(adapter);
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };

  adapter.handleGatewayEvent({ event: PlanModeGateway.REQUESTED_EVENT, payload: planRequest });

  await vi.waitFor(() => {
    expect(request).toHaveBeenCalledWith(PlanModeGateway.RESOLVE, {
      requestId: planRequest.requestId,
      decision: 'cancel',
    });
  });
  expect(sendToRenderer).not.toHaveBeenCalledWith(
    CoworkInteractionIpc.Stream,
    expect.objectContaining({
      request: expect.objectContaining({ requestId: planRequest.requestId }),
    }),
  );
});

test('persists the plan review recovery marker before exposing the side panel', async () => {
  sendToRenderer.mockClear();
  const { store } = createEmptyStore();
  const artifactStore = createApprovedPlanArtifactStore();
  const adapter = new OpenClawRuntimeAdapter(store, {}, undefined, artifactStore);
  const planRequest = createPlanModeRequest();
  let finishPatch!: (value: { ok: true }) => void;
  const patchPending = new Promise<{ ok: true }>(resolve => {
    finishPatch = resolve;
  });
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.pluginPatch') return patchPending;
    throw new Error(`Unexpected method: ${method}`);
  });
  const internals = getSessionPreparationInternals(adapter);
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };

  adapter.handleGatewayEvent({ event: PlanModeGateway.REQUESTED_EVENT, payload: planRequest });

  await vi.waitFor(() => expect(artifactStore.publish).toHaveBeenCalledOnce());
  expect(sendToRenderer).not.toHaveBeenCalledWith(
    CoworkInteractionIpc.Stream,
    expect.objectContaining({
      request: expect.objectContaining({ requestId: planRequest.requestId }),
    }),
  );
  expect(request).toHaveBeenCalledWith(
    'sessions.pluginPatch',
    expect.objectContaining({
      key: planRequest.sessionKey,
      value: expect.objectContaining({
        enabled: true,
        awaitingReview: {
          version: 1,
          requestId: planRequest.requestId,
          persistedAt: expect.any(Number),
        },
      }),
    }),
  );

  finishPatch({ ok: true });
  await vi.waitFor(() => {
    expect(sendToRenderer).toHaveBeenCalledWith(
      CoworkInteractionIpc.Stream,
      expect.objectContaining({
        request: expect.objectContaining({ requestId: planRequest.requestId }),
      }),
    );
  });
});

test('keeps a plan handoff recoverable when its rejected marker cannot be cleared', async () => {
  sendToRenderer.mockClear();
  const { store, planHandoffs } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(
    store,
    {},
    undefined,
    createApprovedPlanArtifactStore(),
  );
  const planRequest = createPlanModeRequest();
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.pluginPatch') throw new Error('state unavailable');
    if (method === PlanModeGateway.RESOLVE) {
      return { requestId: planRequest.requestId, decision: 'cancel' };
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  const internals = getSessionPreparationInternals(adapter);
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };

  adapter.handleGatewayEvent({ event: PlanModeGateway.REQUESTED_EVENT, payload: planRequest });

  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    'sessions.pluginPatch',
    PlanModeGateway.RESOLVE,
    'sessions.pluginPatch',
  ]);
  expect(planHandoffs.get(planRequest.requestId)?.state).toBe('presented');
  expect(sendToRenderer).not.toHaveBeenCalledWith(
    CoworkInteractionIpc.Stream,
    expect.objectContaining({
      request: expect.objectContaining({ requestId: planRequest.requestId }),
    }),
  );
});

test('rebuilds a dispatching plan approval from its verified artifact when Gateway pending is empty', async () => {
  const { store } = createEmptyStore();
  const artifactStore = createApprovedPlanArtifactStore('Canonical persisted plan');
  const planRequest = createPlanModeRequest();
  const firstAdapter = new OpenClawRuntimeAdapter(store, {}, undefined, artifactStore);
  seedPresentedPlan(firstAdapter, planRequest);
  store.transitionPlanHandoff({
    planId: planRequest.requestId,
    expectedState: 'presented',
    nextState: 'dispatching',
    transitionedAt: Date.now(),
    implementationSessionKey: planRequest.sessionKey,
  });

  const adapter = new OpenClawRuntimeAdapter(store, {}, undefined, artifactStore);
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.pluginPatch') return { ok: true };
    if (method === AskUserQuestionGateway.LIST || method === PlanModeGateway.LIST) {
      return { requests: [] };
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  const internals = getSessionPreparationInternals(adapter);
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);

  await expect(adapter.listPendingAskUserInteractions()).resolves.toEqual([
    expect.objectContaining({
      sessionId: 'session-1',
      request: expect.objectContaining({
        requestId: planRequest.requestId,
        toolInput: expect.objectContaining({ plan: 'Canonical persisted plan' }),
      }),
    }),
  ]);
  expect(request).toHaveBeenCalledWith(
    'sessions.pluginPatch',
    expect.objectContaining({
      key: planRequest.sessionKey,
      value: expect.objectContaining({
        enabled: true,
        awaitingReview: expect.objectContaining({ requestId: planRequest.requestId }),
      }),
    }),
  );
});

test('restores a missing workspace plan from the matching Gateway pending request', async () => {
  const { store } = createEmptyStore();
  const planRequest = createPlanModeRequest();
  const artifactStore = createApprovedPlanArtifactStore(planRequest.plan);
  const firstAdapter = new OpenClawRuntimeAdapter(store, {}, undefined, artifactStore);
  seedPresentedPlan(firstAdapter, planRequest);
  artifactStore.publish.mockClear();
  artifactStore.readVerified
    .mockImplementationOnce(() => {
      throw new Error('missing artifact');
    })
    .mockImplementation(() => planRequest.plan);

  const adapter = new OpenClawRuntimeAdapter(store, {}, undefined, artifactStore);
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.pluginPatch') return { ok: true };
    if (method === AskUserQuestionGateway.LIST) return { requests: [] };
    if (method === PlanModeGateway.LIST) return { requests: [planRequest] };
    throw new Error(`Unexpected method: ${method}`);
  });
  const internals = getSessionPreparationInternals(adapter);
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);

  await expect(adapter.listPendingAskUserInteractions()).resolves.toEqual([
    expect.objectContaining({
      sessionId: 'session-1',
      request: expect.objectContaining({ requestId: planRequest.requestId }),
    }),
  ]);
  expect(artifactStore.publish).toHaveBeenCalledWith({
    workspaceRoot: process.cwd(),
    sessionId: 'session-1',
    planId: planRequest.requestId,
    markdown: planRequest.plan,
  });
});

test('keeps an admitted recovery disabled when Plan mode resolution is transiently unavailable', async () => {
  const { store, planHandoffs } = createEmptyStore();
  const artifactStore = createApprovedPlanArtifactStore();
  const planRequest = createPlanModeRequest();
  const firstAdapter = new OpenClawRuntimeAdapter(store, {}, undefined, artifactStore);
  seedPresentedPlan(firstAdapter, planRequest);
  store.transitionPlanHandoff({
    planId: planRequest.requestId,
    expectedState: 'presented',
    nextState: 'admitted',
    transitionedAt: Date.now(),
    implementationSessionKey: planRequest.sessionKey,
  });

  const adapter = new OpenClawRuntimeAdapter(store, {}, undefined, artifactStore);
  let resolveAttempts = 0;
  const patchedStates: Array<{ enabled?: boolean; awaitingReview?: unknown }> = [];
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === AskUserQuestionGateway.LIST) return { requests: [] };
    if (method === PlanModeGateway.LIST) return { requests: [planRequest] };
    if (method === 'sessions.pluginPatch') {
      patchedStates.push(params?.value as { enabled?: boolean; awaitingReview?: unknown });
      return { ok: true };
    }
    if (method === PlanModeGateway.RESOLVE) {
      resolveAttempts += 1;
      if (resolveAttempts === 1) throw new Error('temporary resolve failure');
      return { requestId: planRequest.requestId, decision: 'implement' };
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  const internals = getSessionPreparationInternals(adapter);
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);

  await expect(adapter.listPendingAskUserInteractions()).resolves.toEqual([]);
  expect(planHandoffs.get(planRequest.requestId)?.state).toBe('admitted');
  expect(patchedStates).toEqual([
    expect.objectContaining({
      enabled: false,
      awaitingReview: expect.objectContaining({ requestId: planRequest.requestId }),
    }),
  ]);

  await expect(adapter.listPendingAskUserInteractions()).resolves.toEqual([]);
  expect(planHandoffs.get(planRequest.requestId)?.state).toBe('resolved');
  expect(patchedStates.every(state => state.enabled === false)).toBe(true);
  expect(patchedStates.at(-1)).not.toHaveProperty('awaitingReview');
});

test('keeps the review marker intact when revising a still-pending plan fails', async () => {
  const { store, planHandoffs } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(
    store,
    {},
    undefined,
    createApprovedPlanArtifactStore(),
  );
  const planRequest = createPlanModeRequest();
  seedPresentedPlan(adapter, planRequest);
  const patchedStates: unknown[] = [];
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'sessions.pluginPatch') {
      patchedStates.push(params?.value);
      return { ok: true };
    }
    if (method === PlanModeGateway.RESOLVE) throw new Error('temporary resolve failure');
    if (method === PlanModeGateway.LIST) return { requests: [planRequest] };
    throw new Error(`Unexpected method: ${method}`);
  });
  const internals = getSessionPreparationInternals(adapter);
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);

  await expect(
    adapter.resolveAskUserInteraction(planRequest.requestId, {
      behavior: 'plan',
      decision: 'revise',
      feedback: 'Keep the existing API.',
    }),
  ).rejects.toThrow('temporary resolve failure');

  expect(patchedStates).toEqual([]);
  expect(planHandoffs.get(planRequest.requestId)?.state).toBe('presented');
});

test('locally resolves a recovered failed-plan cancellation when Gateway lost the pending request', async () => {
  const { store, planHandoffs } = createEmptyStore();
  const artifactStore = createApprovedPlanArtifactStore('Persisted plan');
  const planRequest = createPlanModeRequest();
  const firstAdapter = new OpenClawRuntimeAdapter(store, {}, undefined, artifactStore);
  seedPresentedPlan(firstAdapter, planRequest);
  store.transitionPlanHandoff({
    planId: planRequest.requestId,
    expectedState: 'presented',
    nextState: 'failed',
    transitionedAt: Date.now(),
    error: 'implementation setup failed',
  });

  const adapter = new OpenClawRuntimeAdapter(store, {}, undefined, artifactStore);
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.pluginPatch') return { ok: true };
    if (method === AskUserQuestionGateway.LIST || method === PlanModeGateway.LIST) {
      return { requests: [] };
    }
    if (method === PlanModeGateway.RESOLVE) throw new Error('request not found');
    throw new Error(`Unexpected method: ${method}`);
  });
  const internals = getSessionPreparationInternals(adapter);
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  await adapter.listPendingAskUserInteractions();

  await expect(
    adapter.resolveAskUserInteraction(planRequest.requestId, {
      behavior: 'plan',
      decision: 'cancel',
    }),
  ).resolves.toEqual({ sessionId: 'session-1' });

  expect(planHandoffs.get(planRequest.requestId)?.state).toBe('resolved');
  expect(request).toHaveBeenCalledWith(PlanModeGateway.LIST, {});
});

test('revises a recovered failed plan whose Gateway request was lost', async () => {
  const { store, planHandoffs } = createEmptyStore();
  const artifactStore = createApprovedPlanArtifactStore('Persisted original plan');
  const planRequest = createPlanModeRequest();
  const firstAdapter = new OpenClawRuntimeAdapter(store, {}, undefined, artifactStore);
  seedPresentedPlan(firstAdapter, planRequest);
  store.transitionPlanHandoff({
    planId: planRequest.requestId,
    expectedState: 'presented',
    nextState: 'failed',
    transitionedAt: Date.now(),
    error: 'implementation setup failed',
  });

  const adapter = new OpenClawRuntimeAdapter(store, {}, undefined, artifactStore);
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.pluginPatch') return { ok: true };
    if (method === AskUserQuestionGateway.LIST || method === PlanModeGateway.LIST) {
      return { requests: [] };
    }
    if (method === PlanModeGateway.RESOLVE) throw new Error('request not found');
    throw new Error(`Unexpected method: ${method}`);
  });
  const internals = getSessionPreparationInternals(adapter);
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  const startSession = vi.spyOn(adapter, 'startSession').mockResolvedValue(undefined);
  await adapter.listPendingAskUserInteractions();

  await expect(
    adapter.resolveAskUserInteraction(planRequest.requestId, {
      behavior: 'plan',
      decision: 'revise',
      feedback: 'Add rollback verification.',
    }),
  ).resolves.toEqual({ sessionId: 'session-1' });

  expect(planHandoffs.get(planRequest.requestId)?.state).toBe('resolved');
  expect(startSession).toHaveBeenCalledWith(
    'session-1',
    expect.stringContaining('Add rollback verification.'),
    expect.objectContaining({
      planMode: true,
      clientTurnId: `justdo-plan-revision-${planRequest.requestId}`,
    }),
  );
  expect(startSession.mock.calls[0]?.[1]).toContain('Persisted original plan');
});

test('reads Plan mode with the closed sessions.describe request shape', async () => {
  const { store, session } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.describe') {
      return {
        session: {
          pluginExtensions: [
            {
              pluginId: 'plan-mode',
              namespace: 'state',
              value: { enabled: true, updatedAt: 1 },
            },
          ],
        },
      };
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  const internals = getSessionPreparationInternals(adapter);
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  adapter.rememberSessionKey(
    session.id,
    'agent:main:openai-user:telegram:__default__:2459325231940374',
  );

  await expect(adapter.getPlanMode(session.id)).resolves.toEqual({ enabled: true });
  expect(request).toHaveBeenCalledWith('sessions.describe', {
    key: 'agent:main:justdo:session-1',
  });
});

test('rejects a Plan mode toggle when a turn starts during Gateway readiness', async () => {
  const { store, session } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  let finishReadiness: (() => void) | undefined;
  const readiness = new Promise<void>(resolve => {
    finishReadiness = resolve;
  });
  const request = vi.fn().mockResolvedValue({ ok: true });
  const internals = adapter as unknown as SessionPreparationInternals & {
    pendingTurnStarts: Map<string, unknown>;
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn(() => readiness);

  const toggling = adapter.setPlanMode(session.id, true);
  internals.pendingTurnStarts.set(session.id, {});
  finishReadiness?.();

  await expect(toggling).rejects.toThrow('cannot be changed while the session is running');
  expect(request).not.toHaveBeenCalled();
});

test('disables Plan mode without stopping an active turn', async () => {
  const { store, session } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn().mockResolvedValue({ ok: true });
  const internals = adapter as unknown as SessionPreparationInternals & {
    pendingTurnStarts: Map<string, unknown>;
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  internals.pendingTurnStarts.set(session.id, {});

  await expect(adapter.setPlanMode(session.id, false)).resolves.toEqual({ enabled: false });

  expect(request).toHaveBeenCalledWith(
    'sessions.pluginPatch',
    expect.objectContaining({
      key: 'agent:main:justdo:session-1',
      pluginId: 'plan-mode',
      value: expect.objectContaining({ enabled: false }),
    }),
  );
});

test('writes Plan mode to the canonical JustDo key when a channel key is also known', async () => {
  const { store, session } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn().mockResolvedValue({ ok: true });
  const internals = getSessionPreparationInternals(adapter);
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  adapter.rememberSessionKey(
    session.id,
    'agent:main:openai-user:telegram:__default__:2459325231940374',
  );

  await expect(adapter.setPlanMode(session.id, true)).resolves.toEqual({ enabled: true });

  expect(request).toHaveBeenCalledWith(
    'sessions.pluginPatch',
    expect.objectContaining({
      key: 'agent:main:justdo:session-1',
      pluginId: 'plan-mode',
      value: expect.objectContaining({ enabled: true }),
    }),
  );
});

test('does not reopen an AskUserQuestion after its terminal event', () => {
  sendToRenderer.mockClear();
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = createAskUserRequest();

  adapter.handleGatewayEvent({
    event: AskUserQuestionGateway.RESOLVED_EVENT,
    payload: { requestId: request.requestId, status: 'timeout' },
  });
  adapter.handleGatewayEvent({
    event: AskUserQuestionGateway.REQUESTED_EVENT,
    payload: request,
  });

  expect(sendToRenderer).not.toHaveBeenCalled();
});

test('recovers and resolves AskUserQuestion through extension-owned Gateway RPCs', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const pendingRequest = createAskUserRequest();
  const request = vi.fn(async (method: string) => {
    if (method === AskUserQuestionGateway.LIST) return { requests: [pendingRequest] };
    if (method === AskUserQuestionGateway.RESOLVE) {
      return { requestId: pendingRequest.requestId, status: 'answered' };
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  const internals = getSessionPreparationInternals(adapter);
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);

  await expect(adapter.listPendingAskUserInteractions()).resolves.toEqual([
    expect.objectContaining({
      sessionId: 'session-1',
      request: expect.objectContaining({ requestId: pendingRequest.requestId }),
    }),
  ]);
  await expect(
    adapter.resolveAskUserInteraction(pendingRequest.requestId, {
      behavior: 'submit',
      answers: { deploy_target: { selected: ['production'] } },
    }),
  ).resolves.toEqual({ sessionId: 'session-1' });
  expect(request).toHaveBeenCalledWith(AskUserQuestionGateway.RESOLVE, {
    requestId: pendingRequest.requestId,
    behavior: 'submit',
    answers: { deploy_target: { selected: ['production'] } },
  });
});

test('isolates malformed AskUserQuestion records during pending recovery', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const pendingRequest = createAskUserRequest();
  const internals = getSessionPreparationInternals(adapter);
  internals.gatewayClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request: vi.fn().mockResolvedValue({ requests: [{ requestId: 'malformed' }, pendingRequest] }),
  };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);

  await expect(adapter.listPendingAskUserInteractions()).resolves.toEqual([
    expect.objectContaining({
      request: expect.objectContaining({ requestId: pendingRequest.requestId }),
    }),
  ]);
});

test('does not resolve an admitted handoff from a stale Gateway pending response', async () => {
  const { store, planHandoffs } = createEmptyStore();
  const artifactStore = createApprovedPlanArtifactStore();
  const adapter = new OpenClawRuntimeAdapter(store, {}, undefined, artifactStore);
  const planRequest = createPlanModeRequest();
  seedPresentedPlan(adapter, planRequest);
  store.transitionPlanHandoff({
    planId: planRequest.requestId,
    expectedState: 'presented',
    nextState: 'dispatching',
    transitionedAt: Date.now(),
    implementationSessionKey: planRequest.sessionKey,
  });
  store.transitionPlanHandoff({
    planId: planRequest.requestId,
    expectedState: 'dispatching',
    nextState: 'admitted',
    implementationGatewaySessionId: 'gateway-session-1',
    implementationRunId: 'implementation-run-1',
    transitionedAt: Date.now(),
  });
  let resolvePlanList!: (value: unknown) => void;
  const oldClient = {
    start: vi.fn(),
    stop: vi.fn(),
    request: vi.fn((method: string) => {
      if (method === AskUserQuestionGateway.LIST) return Promise.resolve({ requests: [] });
      if (method === PlanModeGateway.LIST) {
        return new Promise<unknown>(resolve => {
          resolvePlanList = resolve;
        });
      }
      return Promise.reject(new Error(`Unexpected method: ${method}`));
    }),
  };
  const newClient = { start: vi.fn(), stop: vi.fn(), request: vi.fn() };
  const internals = adapter as unknown as SessionPreparationInternals & {
    gatewayClientGeneration: number;
  };
  internals.gatewayClient = oldClient;
  internals.gatewayClientGeneration = 1;
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);

  const pending = adapter.listPendingAskUserInteractions();
  await vi.waitFor(() => expect(oldClient.request).toHaveBeenCalledWith(PlanModeGateway.LIST, {}));
  internals.gatewayClient = newClient;
  internals.gatewayClientGeneration = 2;
  resolvePlanList({ requests: [] });

  await expect(pending).resolves.toEqual([]);
  expect(planHandoffs.get(planRequest.requestId)?.state).toBe('admitted');
});

test('persists enabled Plan mode before sending the first turn', async () => {
  const { store, session } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.pluginPatch') return { ok: true };
    if (method === 'chat.send') return { runId: 'gateway-run-1' };
    throw new Error(`Unexpected method: ${method}`);
  });
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    ensureGatewayClientReady: () => Promise<void>;
    prepareSession: () => Promise<{ sessionKey: string; gatewaySessionId: string }>;
    runTurn: (
      sessionId: string,
      prompt: string,
      options: { agentId: string; planMode: boolean },
    ) => Promise<void>;
    resolveTurn: (sessionId: string) => void;
    cleanupSessionTurn: (sessionId: string) => void;
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  internals.prepareSession = vi.fn().mockResolvedValue({
    sessionKey: 'agent:main:justdo:session-1',
    gatewaySessionId: 'gateway-session-1',
  });

  const running = internals.runTurn(session.id, 'inspect this repository', {
    agentId: 'main',
    planMode: true,
  });
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith('chat.send', expect.anything()));

  expect(request.mock.calls.map(([method]) => method)).toEqual([
    'sessions.pluginPatch',
    'chat.send',
  ]);
  expect(request).toHaveBeenNthCalledWith(
    1,
    'sessions.pluginPatch',
    expect.objectContaining({
      key: 'agent:main:justdo:session-1',
      pluginId: 'plan-mode',
      namespace: 'state',
      value: expect.objectContaining({ enabled: true }),
    }),
  );

  internals.resolveTurn(session.id);
  await running;
  internals.cleanupSessionTurn(session.id);
});

test('settles an internal managed handoff chat error without forwarding it', () => {
  const { session, store } = createEmptyStore();
  session.status = 'running';
  store.updateSession = (_sessionId: string, updates: Record<string, unknown>) => {
    Object.assign(session, updates);
  };
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const complete = vi.fn();
  const error = vi.fn();
  adapter.on('complete', complete);
  adapter.on('error', error);
  adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');
  adapter.ensureActiveTurn('session-1', 'agent:main:justdo:session-1', 'run-1');

  adapter.handleGatewayEvent({
    event: 'chat',
    payload: {
      runId: 'run-1',
      sessionKey: 'agent:main:justdo:session-1',
      state: 'error',
      errorMessage: 'Managed subagent terminal handoff could not be persisted.',
    },
  });

  expect(session.status).toBe('idle');
  expect(complete).toHaveBeenCalledWith('session-1', 'idle');
  expect(error).not.toHaveBeenCalled();
});
