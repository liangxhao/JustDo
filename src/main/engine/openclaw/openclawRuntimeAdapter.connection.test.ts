import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
import { captureHostedCanvasBinding } from '../../chat/embed/hostedCanvasSurface';
import type { GatewayClientCtor, GatewayClientLike, SessionTurn } from '../gateway/types';
import { OpenClawRuntimeAdapter } from './openclawRuntimeAdapter';
import { _ensureGatewayClientReadyImpl, captureGatewayResponseContext, type RuntimeGatewayConnectionContext } from './runtimeGatewayConnection';

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

test.each([
  Object.assign(new Error('request timed out'), { code: 'CLIENT_TIMEOUT', requestSent: true }),
  new Error('gateway closed (1006): lost connection'),
])('retains a sent turn for authoritative recovery after $message', async failure => {
  const { store, session } = createEmptyStore();
  const update = vi.spyOn(store, 'updateSession');
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const errors = vi.fn();
  adapter.on('error', errors);
  const request = vi.fn(async (method: string) => {
    if (method === 'chat.send') throw failure;
    return {};
  });
  const internals = adapter as unknown as {
    activeTurns: Map<string, SessionTurn>;
    disconnectedSessionIds: Set<string>;
    gatewayClient: GatewayClientLike;
    ensureGatewayClientReady: () => Promise<void>;
    prepareSession: () => Promise<{ sessionKey: string; gatewaySessionId: string }>;
    runTurn: (sessionId: string, prompt: string, options: object) => Promise<void>;
    resolveTurn: (sessionId: string) => void;
    cleanupSessionTurn: (sessionId: string) => void;
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  internals.prepareSession = vi.fn().mockResolvedValue({
    sessionKey: 'agent:main:justdo:session-1',
    gatewaySessionId: 'gateway-session-1',
  });
  const running = internals.runTurn(session.id, 'hello', {});
  await vi.waitFor(() => expect(internals.disconnectedSessionIds.has(session.id)).toBe(true));
  expect(internals.activeTurns.has(session.id)).toBe(true);
  expect(update).not.toHaveBeenCalledWith(session.id, { status: 'error' });
  expect(errors).not.toHaveBeenCalled();
  internals.resolveTurn(session.id);
  await running;
  internals.cleanupSessionTurn(session.id);
});

test('resolves the Gateway session ID used by title generation', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn().mockResolvedValue({
    session: { key: 'agent:main:justdo:session-1', sessionId: 'gateway-session-123' },
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
  expect(request).toHaveBeenCalledExactlyOnceWith('sessions.describe',
    { key: 'agent:main:justdo:session-1', agentId: 'main' }, { timeoutMs: expect.any(Number) });
});

test.each(['key', 'agent', 'session', 'connection', 'product'])('rejects a stale or foreign title lookup: %s', async kind => {
  const { store, session } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const internals = adapter as unknown as {
    ensureGatewayClientReady: () => Promise<void>;
    gatewayClient: GatewayClientLike | null;
    gatewayClientGeneration: number;
    resolveGatewaySessionIdForTitle: (sessionId: string) => Promise<string | undefined>;
  };
  Object.assign(session, { historyBinding: { sessionKey: 'agent:main:justdo:session-1', nativeSessionId: 'expected-native' } });
  const request = vi.fn(async (_method: string) => {
    if (kind === 'connection') internals.gatewayClientGeneration += 1;
    if (kind === 'product') session.agentId = 'replacement';
    return { session: {
      key: kind === 'key' ? 'agent:main:foreign' : 'agent:main:justdo:session-1',
      agentId: kind === 'agent' ? 'foreign' : 'main',
      sessionId: kind === 'session' ? 'foreign-native' : 'expected-native',
    } };
  });
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  await expect(internals.resolveGatewaySessionIdForTitle('session-1')).resolves.toBeUndefined();
  expect(request).toHaveBeenCalledOnce();
  expect(request.mock.calls.every(([method]) => method !== 'sessions.list')).toBe(true);
});

test('an intentionally stopped gateway client cannot reclaim the active connection', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const stop = vi.fn();
  const workboardChanged = vi.fn();
  adapter.on('workboardChanged', workboardChanged);
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
  expect(clientOptions?.caps).toEqual(expect.arrayContaining(['exec-approvals', 'plugin-approvals']));
  expect(clientOptions?.scopes).toEqual([
    'operator.admin',
    'operator.read',
    'operator.write',
    'operator.approvals',
    'operator.questions',
  ]);
  (onHelloOk as () => void)();
  expect(connectionAdapter.gatewayClient).not.toBeNull();
  expect(connectionAdapter.pendingGatewayClient).toBeNull();
  expect(workboardChanged).toHaveBeenCalledOnce();
  expect(workboardChanged).toHaveBeenCalledWith({});

  connectionAdapter.disconnectGatewayClient();
  expect(connectionAdapter.gatewayClient).toBeNull();

  (onHelloOk as () => void)();
  expect(connectionAdapter.gatewayClient).toBeNull();
  expect(workboardChanged).toHaveBeenCalledOnce();
  expect(stop).toHaveBeenCalledTimes(2);
});

test('accepted Main hello owns the hosted document lease and disconnect retires that exact lease', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, { getStateDir: () => 'canvas-profile-root' });
  let onHelloOk: ((hello: unknown) => void) | undefined;
  class FakeClient {
    constructor(options: { onHelloOk: typeof onHelloOk }) { onHelloOk = options.onHelloOk; }
    start() {}
    stop() {}
    async request() { return {}; }
  }
  adapter.loadGatewayClientCtor = vi.fn().mockResolvedValue(FakeClient);
  adapter.handleGatewayReady = vi.fn().mockResolvedValue(undefined);
  adapter.reconcilePendingApprovals = vi.fn().mockResolvedValue(undefined);
  adapter.reconcilePendingAskUserInteractions = vi.fn().mockResolvedValue(undefined);
  adapter.startTickWatchdog = vi.fn();
  const generation = adapter.getGatewayClientGeneration();
  await adapter.createGatewayClient({
    url: 'ws://127.0.0.1:31415', token: '', version: 'test', clientEntryPath: 'test.js',
  });
  expect(captureHostedCanvasBinding(adapter.getGatewayClient(), generation, 'canvas-profile-root')).toBeNull();
  onHelloOk?.({ pluginSurfaceUrls: { canvas: 'http://127.0.0.1:31415/__openclaw__/cap/native_hello_0000000000' } });
  const client = adapter.getGatewayClient();
  const binding = captureHostedCanvasBinding(client, generation, 'canvas-profile-root');
  expect(binding?.gatewayOrigin).toBe('http://127.0.0.1:31415');
  const retired = vi.fn();
  binding?.onRetired(retired);
  adapter.disconnectGatewayClient();
  expect(retired).toHaveBeenCalledOnce();
  expect(binding?.isCurrent()).toBe(false);
  expect(captureHostedCanvasBinding(client, generation, 'canvas-profile-root')).toBeNull();
});

test('only forwards Gateway events from the current authenticated client and generation', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const options: Array<{
    onHelloOk: () => void;
    onEvent: (event: { event: string }) => void;
    onClose: (code: number, reason: string) => void;
  }> = [];
  class FakeClient {
    constructor(value: typeof options[number]) { options.push(value); }
    start() {}
    stop() {}
    async request() { return {}; }
  }
  adapter.loadGatewayClientCtor = vi.fn().mockResolvedValue(FakeClient);
  adapter.handleGatewayReady = vi.fn().mockResolvedValue(undefined);
  adapter.reconcilePendingApprovals = vi.fn().mockResolvedValue(undefined);
  adapter.reconcilePendingAskUserInteractions = vi.fn().mockResolvedValue(undefined);
  adapter.scheduleGatewayReconnect = vi.fn();
  adapter.startTickWatchdog = vi.fn();
  const received = vi.fn();
  adapter.on('gatewayEvent', received);
  const connection = { url: 'ws://127.0.0.1:1234', token: '', version: 'test', clientEntryPath: 'test.js' };
  const event = { event: 'tick' };

  await adapter.createGatewayClient(connection);
  options[0].onEvent(event);
  expect(received).not.toHaveBeenCalled();
  options[0].onHelloOk();
  options[0].onEvent(event);
  expect(received).toHaveBeenCalledTimes(1);

  options[0].onClose(1006, 'network interrupted');
  options[0].onEvent(event);
  expect(received).toHaveBeenCalledTimes(1);
  await adapter.createGatewayClient(connection);
  options[1].onHelloOk();
  options[0].onEvent(event);
  expect(received).toHaveBeenCalledTimes(1);
  options[1].onEvent(event);
  expect(received).toHaveBeenCalledTimes(2);

  adapter.gatewayClientGeneration++;
  options[1].onEvent(event);
  expect(received).toHaveBeenCalledTimes(2);
  adapter.disconnectGatewayClient();
  options[1].onEvent(event);
  expect(received).toHaveBeenCalledTimes(2);
});

test('reconnectGateway preserves the retry loop when the immediate handshake fails', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const reconnectError = new Error('handshake failed');
  const internals = adapter as unknown as {
    stopGatewayClient: () => void;
    ensureGatewayClientReady: () => Promise<void>;
    scheduleGatewayReconnect: () => void;
  };
  internals.stopGatewayClient = vi.fn();
  internals.ensureGatewayClientReady = vi.fn().mockRejectedValue(reconnectError);
  internals.scheduleGatewayReconnect = vi.fn();

  await expect(adapter.reconnectGateway()).rejects.toBe(reconnectError);

  expect(internals.stopGatewayClient).toHaveBeenCalledOnce();
  expect(internals.scheduleGatewayReconnect).toHaveBeenCalledOnce();
});

test('reconnectGateway resets reconnect backoff after a successful handshake', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const internals = adapter as unknown as {
    gatewayReconnectAttempt: number;
    stopGatewayClient: () => void;
    ensureGatewayClientReady: () => Promise<void>;
  };
  internals.gatewayReconnectAttempt = 4;
  internals.stopGatewayClient = vi.fn();
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);

  await adapter.reconnectGateway();

  expect(internals.gatewayReconnectAttempt).toBe(0);
});

test('Gateway reconnect scheduling keeps only one cancellable timer', () => {
  vi.useFakeTimers();
  try {
    const { store } = createEmptyStore();
    const adapter = new OpenClawRuntimeAdapter(store, {});
    const internals = adapter as unknown as {
      gatewayReconnectAttempt: number;
      scheduleGatewayReconnect: () => void;
    };

    internals.scheduleGatewayReconnect();
    internals.scheduleGatewayReconnect();

    expect(internals.gatewayReconnectAttempt).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    adapter.disconnectGatewayClient();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test('captures the public response facade only for the exact loaded constructor and transport incarnation', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-response-context-'));
  try {
    fs.writeFileSync(path.join(directory, 'owner.cjs'),
      'class GatewayClient {}\nmodule.exports={GatewayClient,responses:new WeakSet()};');
    const entryPath = path.join(directory, 'client-implementation.js');
    fs.writeFileSync(entryPath, "module.exports={t:require('./owner.cjs').GatewayClient};");
    fs.writeFileSync(path.join(directory, 'client-public.js'),
      "const owner=require('./owner.cjs'); module.exports={GatewayClient:owner.GatewayClient,isGatewayProtocolResponseError:value=>owner.responses.has(value)};");
    const { responses } = require(path.join(directory, 'owner.cjs')) as { responses: WeakSet<Error> };
    const client = { start: vi.fn(), stop: vi.fn(), request: vi.fn() };
    const context = { gatewayClient: client, gatewayClientGeneration: 7, gatewayClientEntryPath: entryPath };
    const captured = captureGatewayResponseContext.call(context as unknown as RuntimeGatewayConnectionContext);
    expect(captured).not.toBeNull();
    const unconfirmed = new Error('same shape is not a response');
    expect(captured!.isResponseError(unconfirmed)).toBe(false);
    responses.add(unconfirmed);
    expect(captured!.isResponseError(unconfirmed)).toBe(true);
    expect(captured!.isCurrent()).toBe(true);
    context.gatewayClientGeneration++;
    expect(captured!.isCurrent()).toBe(false);
    context.gatewayClientGeneration--;
    context.gatewayClient = { ...client };
    expect(captured!.isCurrent()).toBe(false);
    expect(client.start).not.toHaveBeenCalled();
    expect(client.request).not.toHaveBeenCalled();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test.each(['missing', 'foreign-constructor', 'throwing-predicate', 'conflicting-predicates'] as const)(
  'does not grant native response evidence for a %s facade', kind => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-response-context-'));
    try {
      fs.writeFileSync(path.join(directory, 'owner.cjs'), 'class GatewayClient {} module.exports={GatewayClient};');
      const entryPath = path.join(directory, 'client-implementation.js');
      fs.writeFileSync(entryPath, "module.exports={t:require('./owner.cjs').GatewayClient};");
      if (kind !== 'missing') {
        fs.writeFileSync(path.join(directory, 'client-public.js'),
          `module.exports={GatewayClient:${kind === 'foreign-constructor' ? 'class GatewayClient {}' : "require('./owner.cjs').GatewayClient"},isGatewayProtocolResponseError:()=>{${kind === 'throwing-predicate' ? "throw new Error('unavailable')" : 'return true'}}};`);
      }
      if (kind === 'conflicting-predicates') fs.writeFileSync(path.join(directory, 'client-other.js'),
        "module.exports={GatewayClient:require('./owner.cjs').GatewayClient,isGatewayProtocolResponseError:()=>true};");
      const context = { gatewayClient: { start: vi.fn(), stop: vi.fn(), request: vi.fn() },
        gatewayClientGeneration: 1, gatewayClientEntryPath: entryPath };
      const captured = captureGatewayResponseContext.call(context as unknown as RuntimeGatewayConnectionContext);
      if (kind === 'throwing-predicate') expect(captured!.isResponseError(new Error('pending'))).toBe(false);
      else expect(captured).toBeNull();
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  },
);

test('ensureGatewayClientReady reuses an already connected Gateway client', async () => {
  const { store } = createEmptyStore();
  const startGateway = vi.fn();
  const adapter = new OpenClawRuntimeAdapter(store, { startGateway } as never);
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    ensureGatewayClientReady: () => Promise<void>;
  };
  internals.gatewayClient = {
    request: vi.fn().mockResolvedValue({
      loaded: true,
      policyId: 'native-session-automation-permission',
    }),
  } as unknown as GatewayClientLike;

  await internals.ensureGatewayClientReady();

  expect(startGateway).not.toHaveBeenCalled();
});

function createReconnectHarness(phase: string) {
  const connection = { url: 'ws://127.0.0.1:12345', token: 'fixture', version: 'test', clientEntryPath: 'fixture.mjs' };
  const manager = {
    getStatus: vi.fn(() => ({ phase })),
    startGateway: vi.fn().mockResolvedValue({ phase: 'running' }),
    getGatewayConnectionInfo: vi.fn(() => connection),
  };
  const context = {
    engineManager: manager,
    gatewayClient: null,
    stopGatewayClient: vi.fn(),
    createGatewayClient: vi.fn().mockResolvedValue(undefined),
  };
  return {
    manager, context, connection,
    connect: () => _ensureGatewayClientReadyImpl.call(context as unknown as RuntimeGatewayConnectionContext),
  };
}

test('reconnects to a running process without re-entering startup health checks', async () => {
  const h = createReconnectHarness('running');
  await h.connect();
  expect(h.manager.startGateway).not.toHaveBeenCalled();
  expect(h.context.createGatewayClient).toHaveBeenCalledExactlyOnceWith(h.connection);
});

test.each(['ready', 'starting', 'error'])('awaits engine startup before connecting in %s', async phase => {
  const h = createReconnectHarness(phase);
  await h.connect();
  expect(h.manager.startGateway).toHaveBeenCalledOnce();
  expect(h.manager.startGateway.mock.invocationCallOrder[0]).toBeLessThan(
    h.context.createGatewayClient.mock.invocationCallOrder[0],
  );
});

test('retries a transient handshake without replacing the running process', async () => {
  vi.useFakeTimers();
  try {
    const h = createReconnectHarness('running');
    h.context.createGatewayClient.mockRejectedValueOnce(new Error('temporarily unavailable'));
    const connected = h.connect();
    await vi.runAllTimersAsync();
    await connected;
    expect(h.context.createGatewayClient).toHaveBeenCalledTimes(2);
    expect(h.manager.startGateway).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

test('uses the installation deadline without changing default Gateway request options', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn().mockResolvedValue({ ok: true });
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike;
    ensureGatewayClientReady: () => Promise<void>;
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn().mockResolvedValue(undefined);

  await adapter.requestGateway('plugins.install', { source: 'local' }, { timeoutMs: 600_000 });
  await adapter.requestGateway('plugins.list', {});

  expect(request).toHaveBeenNthCalledWith(1, 'plugins.install', { source: 'local' }, {
    timeoutMs: 600_000,
  });
  expect(request).toHaveBeenNthCalledWith(2, 'plugins.list', {});
});

test('rejects a failed admission check before preparing the Gateway connection', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const request = vi.fn();
  const ensureReady = vi.fn().mockResolvedValue(undefined);
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike;
    ensureGatewayClientReady: () => Promise<void>;
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = ensureReady;
  const refusal = new Error('The admitted Gateway process is no longer current.');
  const assertBeforeSend = vi.fn(() => { throw refusal; });

  await expect(adapter.requestGateway('plugins.uninstall', { pluginId: 'sample' }, {
    assertBeforeSend,
  })).rejects.toBe(refusal);

  expect(assertBeforeSend).toHaveBeenCalledOnce();
  expect(ensureReady).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});

test('does not dispatch to a replacement Gateway after connection preparation', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const originalRequest = vi.fn();
  const replacementRequest = vi.fn();
  let releaseReady!: () => void;
  const ready = new Promise<void>(resolve => { releaseReady = resolve; });
  const ensureReady = vi.fn(() => ready);
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike;
    ensureGatewayClientReady: () => Promise<void>;
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request: originalRequest };
  internals.ensureGatewayClientReady = ensureReady;
  let generation = 1;
  const refusal = new Error('The admitted Gateway process is no longer current.');
  const assertBeforeSend = vi.fn(() => {
    if (generation !== 1) throw refusal;
  });

  const pending = adapter.requestGateway('plugins.uninstall', { pluginId: 'sample' }, {
    assertBeforeSend,
  });
  expect(ensureReady).toHaveBeenCalledOnce();
  generation += 1;
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request: replacementRequest };
  releaseReady();

  await expect(pending).rejects.toBe(refusal);
  expect(assertBeforeSend).toHaveBeenCalledTimes(2);
  expect(originalRequest).not.toHaveBeenCalled();
  expect(replacementRequest).not.toHaveBeenCalled();
});

test('keeps admission callbacks local while preserving native timeout and default options', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const order: string[] = [];
  const request = vi.fn().mockImplementation(() => {
    order.push('send');
    return Promise.resolve({ ok: true });
  });
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike;
    ensureGatewayClientReady: () => Promise<void>;
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.ensureGatewayClientReady = vi.fn(async () => { order.push('ready'); });
  const assertBeforeSend = vi.fn(() => { order.push('check'); });

  await expect(adapter.requestGateway('plugins.install', { source: 'local' }, {
    timeoutMs: 600_000,
    assertBeforeSend,
  })).resolves.toEqual({ ok: true });
  expect(order).toEqual(['check', 'ready', 'check', 'send']);
  expect(request).toHaveBeenNthCalledWith(1, 'plugins.install', { source: 'local' }, {
    timeoutMs: 600_000,
  });

  await adapter.requestGateway('plugins.refresh', {}, { assertBeforeSend });
  expect(request).toHaveBeenNthCalledWith(2, 'plugins.refresh', {});
  expect(assertBeforeSend).toHaveBeenCalledTimes(4);
});

test('keeps the initial cutoff pending when the Gateway generation changes mid-scan', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  let goalCreatedAt = 300;
  const request = vi.fn(async (method: string) => {
    if (method === 'automationPermission.info') {
      return { loaded: true, policyId: 'native-session-automation-permission' };
    }
    if (method === 'sessions.list') {
      return {
        sessions: [
          {
            key: 'agent:main:justdo:session-1',
            goal: { schemaVersion: 1, id: 'goal-1', objective: 'Ship', status: 'active', createdAt: goalCreatedAt },
          },
        ],
      };
    }
    if (method === 'sessions.describe') return { session: {
      key: 'agent:main:justdo:session-1',
      goal: { schemaVersion: 1, id: 'goal-1', objective: 'Ship', status: 'active', createdAt: goalCreatedAt },
    } };
    if (method === 'sessions.create') return createPreparedSessionReceipt();
    throw new Error(`unexpected method ${method}`);
  });
  let releaseContinue: (() => void) | undefined;
  const continueGoal = vi.fn(
    () =>
      new Promise<void>(resolve => {
        releaseContinue = resolve;
      }),
  );
  const internals = adapter as unknown as {
    gatewayClient: GatewayClientLike | null;
    gatewayClientGeneration: number;
    initialGatewayGoalRecoveryPending: boolean;
    recoverActiveGoals: (
      generation: number,
      options?: { stopGoalsCreatedBeforeMs?: number },
    ) => Promise<void>;
    goalContinuationCoordinator: { reconcileNativeObservation: typeof continueGoal };
  };
  internals.gatewayClient = { start: vi.fn(), stop: vi.fn(), request };
  internals.gatewayClientGeneration = 3;
  internals.goalContinuationCoordinator.reconcileNativeObservation = continueGoal;

  const staleRecovery = internals.recoverActiveGoals(3, { stopGoalsCreatedBeforeMs: 200 });
  await vi.waitFor(() => expect(continueGoal).toHaveBeenCalledOnce());
  goalCreatedAt = 100;
  internals.gatewayClientGeneration = 4;
  releaseContinue?.();
  await staleRecovery;

  expect(internals.initialGatewayGoalRecoveryPending).toBe(true);

  await internals.recoverActiveGoals(4, { stopGoalsCreatedBeforeMs: 200 });

  expect(store.getGoalExecutionSnapshot('session-1')).toMatchObject({
    goalId: 'goal-1',
    phase: 'stopped',
  });
  expect(internals.initialGatewayGoalRecoveryPending).toBe(false);
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

test.each([
  { status: 'ok', expected: 'idle' },
  { status: 'error', expected: 'error' },
  { status: 'timeout', endedAt: 123, expected: 'error' },
])(
  'recovers a disconnected run from the authoritative $status terminal result',
  async ({ status, endedAt, expected }) => {
    const { store } = createEmptyStore();
    store.updateSession = vi.fn();
    const adapter = new OpenClawRuntimeAdapter(store, {});
    adapter.on('error', vi.fn());
    adapter.activeTurns.set('session-1', createSessionTurn());
    adapter.rememberSessionKey('session-1', 'agent:main:justdo:session-1');
    adapter.disconnectedSessionIds.add('session-1');
    const request = vi.fn(async method =>
      method === 'agent.wait'
        ? { runId: 'run-1', status, endedAt }
        : method === 'sessions.describe'
          ? { session: { key: 'agent:main:justdo:session-1', goal: null } }
          : { sessions: [] },
    );
    adapter.gatewayClient = { request };
    await expect(adapter.getSessionRuntimeStatus('session-1')).resolves.toMatchObject({
      known: true,
      running: false,
    });
    expect(request).toHaveBeenCalledWith('agent.wait', { runId: 'run-1', timeoutMs: 0 });
    expect(store.updateSession).toHaveBeenCalledWith('session-1', { status: expected });
    expect(adapter.activeTurns.has('session-1')).toBe(false);
  },
);

test('an unexpected Gateway close preserves execution identity without publishing a business failure', async () => {
  vi.useFakeTimers();
  try {
    const { store } = createEmptyStore();
    store.updateSession = vi.fn();
    const adapter = new OpenClawRuntimeAdapter(store, {});
    const error = vi.fn();
    adapter.on('error', error);
    const connection = vi.fn();
    adapter.on('diagnosticConnection', connection);
    let options;
    class FakeClient {
      constructor(value) {
        options = value;
      }
      start() {}
      stop() {}
      async request() {
        return {};
      }
    }
    adapter.loadGatewayClientCtor = vi.fn().mockResolvedValue(FakeClient);
    adapter.handleGatewayReady = vi.fn().mockResolvedValue(undefined);
    adapter.reconcilePendingApprovals = vi.fn().mockResolvedValue(undefined);
    adapter.reconcilePendingAskUserInteractions = vi.fn().mockResolvedValue(undefined);
    await adapter.createGatewayClient({
      url: 'ws://127.0.0.1:1234',
      token: '',
      version: 'test',
      clientEntryPath: 'test.js',
    });
    options.onHelloOk({ protocol: 3, server: { version: '2026.10.4', buildId: 'abcdef012345', connId: 'PRIVATE' }, auth: { token: 'PRIVATE' } });
    expect(adapter.getDiagnosticGatewayInfo()).toEqual({ version: '2026.10.4', protocol: 3, buildId: 'abcdef012345' });
    expect(connection).toHaveBeenLastCalledWith({ connected: true, runs: [] });
    const turn = createSessionTurn();
    const reject = vi.fn();
    adapter.activeTurns.set('session-1', turn);
    adapter.pendingTurns.set('session-1', { resolve: vi.fn(), reject });
    options.onClose(1006, 'network interrupted');
    expect(adapter.getDiagnosticGatewayInfo()).toBeNull();
    expect(connection).toHaveBeenLastCalledWith({ connected: false, runs: [{ sessionId: 'session-1', nativeRunId: 'run-1' }] });
    expect(adapter.activeTurns.get('session-1')).toBe(turn);
    expect(adapter.disconnectedSessionIds.has('session-1')).toBe(true);
    expect(store.updateSession).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
    adapter.disconnectGatewayClient();
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});


test('diagnostic identity resolves exact keys and active runs without latest-run fallback', () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const internals = adapter as unknown as { activeTurns: Map<string, SessionTurn> };
  internals.activeTurns.set('session-1', createSessionTurn());
  expect(adapter.resolveDiagnosticSession('run-1')).toBe('session-1');
  expect(adapter.resolveDiagnosticSession('older-run')).toBeNull();
  expect(adapter.resolveDiagnosticSession('older-run', 'agent:main:justdo:session-1')).toBe('session-1');
  expect(adapter.resolveDiagnosticSession('run-1', 'agent:other:justdo:session-1')).toBeNull();
  internals.activeTurns.set('session-2', createSessionTurn({ sessionId: 'session-2', runId: 'run-2', knownRunIds: new Set(['run-2']) }));
  expect(adapter.resolveDiagnosticSession('run-2', 'agent:main:justdo:session-1')).toBeNull();
  internals.activeTurns.clear();
  expect(adapter.resolveDiagnosticSession('run-1')).toBeNull();
});

test.each([false, true])('cancellation diagnostics retain identity and isolate observer failures (failure=%s)', async failed => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const internals = adapter as unknown as {
    activeTurns: Map<string, SessionTurn>;
    stopSessionInternal: () => Promise<void>;
  };
  internals.activeTurns.set('session-1', createSessionTurn());
  const failure = new Error('abort unavailable');
  internals.stopSessionInternal = vi.fn(async () => {
    internals.activeTurns.clear();
    if (failed) throw failure;
  });
  const observed = vi.fn();
  adapter.on('diagnosticCancellation', () => { throw new Error('observer failed'); });
  adapter.on('diagnosticCancellation', observed);
  const stopping = adapter.stopSession('session-1', { diagnosticUserInitiated: true });
  if (failed) await expect(stopping).rejects.toBe(failure);
  else await expect(stopping).resolves.toBeUndefined();
  expect(observed.mock.calls.map(([event]) => event)).toEqual([
    { sessionId: 'session-1', nativeRunId: 'run-1', userInitiated: true, phase: 'requested' },
    { sessionId: 'session-1', nativeRunId: 'run-1', userInitiated: true, phase: failed ? 'failed' : 'acknowledged' },
  ]);
  expect(internals.stopSessionInternal).toHaveBeenCalledTimes(1);
});

test('intentional disconnect reports active run evidence before stopping the client', () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const internals = adapter as unknown as {
    activeTurns: Map<string, SessionTurn>;
    gatewayClient: GatewayClientLike;
  };
  internals.activeTurns.set('session-1', createSessionTurn());
  const observed = vi.fn();
  adapter.on('diagnosticConnection', () => { throw new Error('observer failed'); });
  adapter.on('diagnosticConnection', observed);
  const stop = vi.fn(() => {
    expect(observed).toHaveBeenCalledWith({ connected: false, runs: [{ sessionId: 'session-1', nativeRunId: 'run-1' }] });
  });
  internals.gatewayClient = { start: vi.fn(), stop, request: vi.fn() };
  adapter.disconnectGatewayClient();
  expect(stop).toHaveBeenCalledTimes(1);
});
