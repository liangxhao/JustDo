import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { buildSync } from 'esbuild';
import { afterEach, expect, it, vi } from 'vitest';
import * as nativeClient from '@runtime-services/sdk/native-client';
import * as execution from '@runtime-services/sdk/execution';
import {
  registerRuntimeServicesProvider,
  RUNTIME_SERVICES_BINDING_METHOD,
} from '@runtime-services/sdk/provider';
import type { ExecutionAdmissionSnapshot } from '@runtime-services/sdk/admission';

import { buildSwarmWorkflowInstruction, SwarmWorkflowGateway } from '../../app/contracts';
import { FlowStore } from '../../data/store';
import { FLOW_RPC } from '../../contracts/flow';
const requireNative = createRequire(import.meta.url);
const pluginRoot = path.resolve(import.meta.dirname, '../..');
const code = buildSync({
  entryPoints: [path.join(pluginRoot, 'index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  external: [
    'openclaw/plugin-sdk/*',
    '@runtime-services/sdk/native-client',
    '@runtime-services/sdk/execution',
  ],
}).outputFiles[0].text;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0)) await action();
  vi.useRealTimers();
});
async function fixture(options: { autoStart?: boolean; deferCapabilities?: boolean } = {}) {
  const emit = vi.fn();
  const root = mkdtempSync(path.join(os.tmpdir(), 'flow-plugin-'));
  const parentKey = 'agent:main:justdo:parent';
  const parent = { sessionId: 'native-parent', sessionRoot: root, permissionMode: 'workspace' };
  const methods = new Map<string, any>();
  const methodDescriptors = new Map<string, Record<string, unknown>>();
  const messages: Array<Record<string, unknown>> = [];
  const nodeMessages: Array<Record<string, unknown>> = [];
  const getSessionMessages = vi.fn(async (_params: any) => ({ messages: nodeMessages }));
  const agents = [{ id: 'main', name: 'Main' }];
  const config = {
    plugins: { entries: { 'swarm-workflow': { config: { availableAgentIds: ['main'] } } } },
  };
  let tool: any;
  const toolFactories: any[] = [];
  const registeredToolNames: string[] = [];
  const wait = vi.fn(async (_params: any): Promise<any> => ({ status: 'pending' }));
  const runStates = new Map<string, any>();
  const hooks = new Map<string, any>();
  const hookOptions = new Map<string, any>();
  const nativeListeners = new Set<(event: any) => void>();
  const lifecycle = new AbortController();
  const nativeDisposers = new Set<() => void | Promise<void>>();
  let releaseCapabilities: (() => void) | undefined;
  const capabilitiesReady = options.deferCapabilities
    ? new Promise<void>(resolve => { releaseCapabilities = resolve; })
    : undefined;
  const nativeDispatch = vi.fn(async (method: string, params: any) => ({
    ok: true,
    payload: await request(method, params),
  }));
  let service: any;
  const moduleBox = { exports: {} as any };
  vm.runInNewContext(code, {
    module: moduleBox,
    exports: moduleBox.exports,
    setTimeout,
    clearTimeout,
    Date,
    Buffer,
    process,
    require: (name: string) =>
      name === 'openclaw/plugin-sdk/session-store-runtime'
        ? {
            getSessionEntry: ({ sessionKey }: any) =>
              sessionKey === parentKey ? parent : undefined,
          }
        : name === 'openclaw/plugin-sdk/gateway-method-runtime'
          ? { dispatchGatewayMethod: nativeDispatch }
          : name === '@runtime-services/sdk/native-client'
            ? nativeClient
            : name === '@runtime-services/sdk/execution'
              ? execution
              : requireNative(name),
  });
  const request = vi.fn(async (method: string, params: any) => {
    if (method === RUNTIME_SERVICES_BINDING_METHOD) await capabilitiesReady;
    if (method === 'agents.list') return { agents };
    if (method === 'chat.history') {
      const offset = params.offset ?? 0;
      const end = Math.max(0, messages.length - offset);
      const start = Math.max(0, end - params.limit);
      return {
        messages: messages.slice(start, end),
        totalMessages: messages.length,
        hasMore: start > 0,
        ...(start > 0 ? { nextOffset: offset + end - start } : {}),
      };
    }
    if (methods.has(method))
      return new Promise((resolve, reject) =>
        methods.get(method)({
          params,
          client: { connect: { client: { mode: 'backend' } } },
          req: { method },
          context: {
            isConfigReloadSettled: () => true,
            getGatewayMethodRegistry: () => ({
              descriptors: () => Object.freeze([...methodDescriptors.values()]),
            }),
          },
          hasCurrentClientAuthority: () => true,
          respond: (ok: boolean, value: unknown, error: any) =>
            ok ? resolve(value) : reject(new Error(error.message)),
        }),
      );
    if (method === 'sessions.create')
      return {
        key: params.key,
        sessionId: 'child',
        entry: { sessionRoot: params.cwd, permissionMode: params.permissionMode },
      };
    if (method === 'sessions.abort' || method === 'chat.inject') return { ok: true };
    throw new Error('Unexpected API ' + method);
  });
  const run = vi.fn(async (params: any) => {
    params.assertCurrent();
    return { runId: params.idempotencyKey, sessionKey: params.sessionKey };
  });
  const api = {
    id: 'swarm-workflow',
    source: path.join(pluginRoot, 'index.ts'),
    lifecycle: {
      signal: lifecycle.signal,
      runInBackgroundContext: (run: () => unknown) => run(),
      onDispose: (dispose: () => void | Promise<void>) => {
        nativeDisposers.add(dispose);
        return () => nativeDisposers.delete(dispose);
      },
    },
    runtime: {
      state: { resolveStateDir: () => root },
      events: {
        onAgentEvent: (listener: (event: any) => void) => {
          nativeListeners.add(listener);
          return () => nativeListeners.delete(listener);
        },
      },
      config: { current: () => config },
      gateway: { request },
      subagent: {
        run,
        waitForRun: async (params: any) => {
          const result = await wait(params);
          runStates.set(params.runId, result);
          return result;
        },
        describeRun: async ({ runId }: any) => {
          const result = runStates.get(runId) ?? { status: 'pending' };
          const settled = Boolean(
            result.endedAt &&
            result.status !== 'pending' &&
            !result.yielded &&
            !result.pendingError &&
            result.livenessState !== 'paused',
          );
          return {
            runId,
            state: settled ? 'settled' : 'running',
            executionSettled: settled,
            cleanupSettled: settled,
            executionStartedAt: result.executionStartedAt,
            executionEndedAt: result.endedAt,
            outcome: result.status,
          };
        },
        cancelRun: async ({ runId }: any) =>
          request('sessions.abort', { runId, clearQueued: true }),
        getSessionMessages,
      },
    },
    registerService: (s: any) => {
      service = s;
    },
    registerGatewayMethod: (name: string, fn: any, options: any = {}) => {
      // Match Native's first-owner-wins registration instead of accepting every alias.
      if (methods.has(name)) return;
      methods.set(name, fn);
      methodDescriptors.set(
        name,
        Object.freeze({
          name,
          handler: fn,
          owner: { kind: 'plugin', pluginId: 'swarm-workflow' },
          scope: options.scope ?? 'operator.admin',
          profileAccess: options.profileAccess ?? 'required',
          ...(options.sessionAccess ? { sessionAccess: options.sessionAccess } : {}),
        }),
      );
    },
    registerTool: (factory: any, options?: { name?: string; names?: string[] }) => {
      toolFactories.push(factory);
      registeredToolNames.push(...(options?.names ?? (options?.name ? [options.name] : [])));
      const created =
        typeof factory === 'function'
          ? factory({ sessionKey: parentKey })
          : factory.create({
              sessionKey: parentKey,
              sessionId: parent.sessionId,
              assertInvocationCurrent: () => {},
            });
      if (created?.name === 'swarm_workflow_start') tool = created;
    },
    on: (name: string, fn: any, options: any) => {
      hooks.set(name, fn);
      hookOptions.set(name, options);
    },
  };
  let executionAdmission: ExecutionAdmissionSnapshot = { state: 'clear', generation: 0 };
  const retireProvider = registerRuntimeServicesProvider(
    {
      id: 'runtime-services',
      lifecycle: api.lifecycle,
      registerGatewayMethod: (name: string, handler: any) => {
        methods.set(name, handler);
      },
    } as unknown as Parameters<typeof registerRuntimeServicesProvider>[0],
    {
      readExecutionAdmission: () => executionAdmission,
      managedExecution: execution.MANAGED_EXECUTION_DESCRIPTOR,
    },
  );
  moduleBox.exports.default.register(api);
  cleanup.push(async () => {
    await service.stop();
    for (const dispose of nativeDisposers) await dispose();
    retireProvider();
    lifecycle.abort();
    expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(root)).toMatch(/^flow-plugin-/u);
    rmSync(root, { recursive: true, force: true });
  });
  if (options.autoStart !== false) {
    await service.start({ stateDir: root, gatewayEvents: { emit }, logger: { error: vi.fn() } });
    tool = toolFactories.at(-1).create({
      sessionKey: parentKey,
      sessionId: parent.sessionId,
      assertInvocationCurrent: () => {},
    });
  }
  const registerAgent = () => {
    const agentHooks = new Map<string, any>();
    const agentTools: any[] = [];
    let agentService: any;
    moduleBox.exports.default.register({
      ...api,
      registerGatewayMethod: vi.fn(),
      registerService: (value: any) => {
        agentService = value;
      },
      registerTool: (value: any) => agentTools.push(value),
      on: (name: string, fn: any) => agentHooks.set(name, fn),
    });
    return { hooks: agentHooks, tools: agentTools, service: agentService };
  };
  return {
    emit,
    root,
    parent,
    parentKey,
    request,
    run,
    messages,
    nodeMessages,
    getSessionMessages,
    agents,
    config,
    tool,
    toolFactories,
    hooks,
    hookOptions,
    nativeListeners,
    wait,
    hook: hooks.get('before_prompt_build'),
    service,
    registerAgent,
    api,
    methods,
    registeredToolNames,
    releaseCapabilities,
    setExecutionAdmission: (snapshot: ExecutionAdmissionSnapshot) => {
      executionAdmission = snapshot;
    },
    plugin: moduleBox.exports.default,
  };
}
it('does not start an engine after stop retires a pending capability binding', async () => {
  const f = await fixture({ autoStart: false, deferCapabilities: true });
  const starting = f.service.start({
    stateDir: f.root,
    gatewayEvents: { emit: f.emit },
    logger: { error: vi.fn() },
  });
  const rejected = expect(starting).rejects.toThrow('no longer current');
  await f.service.stop();
  f.releaseCapabilities!();
  await rejected;
  expect(f.run).not.toHaveBeenCalled();
  expect(f.emit).not.toHaveBeenCalled();
  expect(existsSync(path.join(f.root, 'swarm-workflow/flows.sqlite'))).toBe(false);
  await expect(f.request('swarmWorkflow.list', { parentKeys: [f.parentKey] })).rejects.toThrow('unavailable');
});

it('loads the manifest, tools, application RPCs and durable store under one Swarm Workflow namespace', async () => {
  const manifest = JSON.parse(readFileSync(path.join(pluginRoot, 'openclaw.plugin.json'), 'utf8'));
  const f = await fixture();
  expect(f.plugin.id).toBe('swarm-workflow');
  expect(manifest.id).toBe(f.plugin.id);
  expect(manifest.name).toBe(f.plugin.name);
  expect(f.plugin.name).toBe('Swarm Workflow');
  expect(manifest.configContracts.configurationStatusMethod).toBe(SwarmWorkflowGateway.Health);
  expect([...f.registeredToolNames].sort()).toEqual([...manifest.contracts.tools].sort());
  for (const method of Object.values(SwarmWorkflowGateway))
    expect(f.methods.has(method)).toBe(true);
  const receipt = (await f.request('swarm-workflow.app.handshake', {})) as any;
  expect(receipt).toMatchObject({ pluginId: 'swarm-workflow', processId: process.pid });
  expect(
    await f.request('swarm-workflow.app.dispatch', {
      registrationId: receipt.registrationId,
      processId: receipt.processId,
      method: 'agents.list',
    }),
  ).toEqual({ agents: f.agents });
  const summary = receipt.gatewayMethods.find(
    (item: any) => item.method === SwarmWorkflowGateway.Summary,
  );
  expect(summary).toBeTruthy();
  const summaryParams = Object.freeze({ parentKeys: Object.freeze([f.parentKey]) });
  expect(await f.request(summary.alias, summaryParams)).toEqual({ count: 0, running: false });
  expect(Object.keys(summaryParams)).toEqual(['parentKeys']);
  expect(existsSync(path.join(f.root, 'swarm-workflow', 'flows.sqlite'))).toBe(true);
});

it('admits the original workflow start through its registered alias and keeps readonly input intact', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const receipt = (await f.request('swarm-workflow.app.handshake', {})) as any;
  const start = receipt.gatewayMethods.find((item: any) => item.method === FLOW_RPC.start);
  expect(start).toBeTruthy();
  const params = Object.freeze({
    parentKey: f.parentKey,
    requestId: 'alias-admission',
    goal: 'Inspect via public alias',
    mode: 'auto',
  });

  const accepted = (await f.request(start.alias, params)) as any;

  expect(accepted.id).toEqual(expect.any(String));
  expect(
    ((await f.request('swarmWorkflow.list', { parentKeys: [f.parentKey] })) as any).flows,
  ).toEqual([expect.objectContaining({ id: accepted.id })]);
  expect(params).toEqual({
    parentKey: f.parentKey,
    requestId: 'alias-admission',
    goal: 'Inspect via public alias',
    mode: 'auto',
  });
});
it('reports active older flows beyond the twenty visible histories for owned parents only', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  await f.request('swarmWorkflow.start', {
    parentKey: f.parentKey,
    requestId: 'old-active',
    goal: 'Long-running task',
    mode: 'auto',
  });
  const store = new FlowStore(path.join(f.root, 'swarm-workflow'));
  try {
    const active = store.forParents([f.parentKey])[0];
    for (let index = 0; index < 20; index++) {
      store.insert({
        ...active,
        id: `history-${index}`,
        requestId: `history-${index}`,
        status: 'completed',
        nodes: [],
      });
    }
    const params = { parentKeys: [f.parentKey] };
    expect(await f.request('swarmWorkflow.summary', params)).toEqual({ count: 21, running: true });
    expect(await f.request('swarmWorkflow.activity', {})).toMatchObject({
      parentKeys: [f.parentKey],
    });
    expect(await f.request('swarmWorkflow.list', params)).toMatchObject({ running: true });
    const listed = (await f.request('swarmWorkflow.list', params)) as any;
    expect(listed.flows).toHaveLength(20);
    expect(listed.flows.every((flow: any) => flow.status === 'completed')).toBe(true);
    active.status = 'completed';
    store.put(active);
    store.insert({
      ...active,
      id: 'foreign-active',
      requestId: 'foreign-active',
      parentKey: 'agent:main:justdo:foreign',
      status: 'running',
    });
    expect(await f.request('swarmWorkflow.list', params)).toMatchObject({ running: false });
  } finally {
    store.close();
  }
});

it('validates compact read requests without dispatching any work', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const activity = (await f.request('swarmWorkflow.activity', {})) as any;
  expect(activity).toMatchObject({ parentKeys: [], snapshot: expect.any(String) });
  expect(await f.request('swarmWorkflow.summary', { parentKeys: [f.parentKey] })).toEqual({
    count: 0,
    running: false,
  });
  await expect(f.request('swarmWorkflow.summary', { parentKeys: [] })).rejects.toThrow(
    'Invalid parent',
  );
  await expect(
    f.request('swarmWorkflow.summary', { parentKeys: ['agent:main:subagent:worker'] }),
  ).rejects.toThrow('Invalid parent');
  await expect(f.request('swarmWorkflow.activity', { cursor: 1 })).rejects.toThrow(
    'Invalid activity cursor',
  );
  expect(f.run).not.toHaveBeenCalled();
});

it.each(['paused', 'blocked'] as const)(
  'preserves %s batch activity until its accepted item settles',
  async status => {
    vi.useFakeTimers();
    const f = await fixture();
    await f.request('swarmWorkflow.start', {
      parentKey: f.parentKey,
      requestId: 'batch-activity',
      goal: 'Batch task',
      mode: 'auto',
    });
    const store = new FlowStore(path.join(f.root, 'swarm-workflow'));
    try {
      const active = store.forParents([f.parentKey])[0];
      const stage = {
        ...active.nodes[0],
        id: 'batch',
        kind: 'batch' as const,
        sessionKey: '',
        batchInput: { version: 'v1', manifestPath: 'manifest.json' },
      };
      active.status = status;
      active.nodes.push(stage);
      store.put(active);
      const item = {
        ...stage,
        id: 'item',
        kind: 'work' as const,
        status: 'uncertain' as const,
        sessionKey: 'agent:main:subagent:activity-item',
        batchInput: undefined,
        batchItem: {
          stageId: stage.id,
          manifestVersion: 'v1',
          ordinal: 0,
          key: 'input',
          workspace: f.root,
        },
      };
      store.expandBatch(active, stage, [item], () => {});
      const params = { parentKeys: [f.parentKey] };
      const listed = (await f.request('swarmWorkflow.list', params)) as any;
      expect(listed.running).toBe(true);
      expect(await f.request('swarmWorkflow.summary', params)).toEqual({ count: 1, running: true });
      expect(await f.request('swarmWorkflow.activity', {})).toMatchObject({
        parentKeys: [f.parentKey],
      });
      expect(
        listed.flows[0].nodes.find((node: any) => node.id === 'batch').batchCounts,
      ).toMatchObject({ uncertain: 1 });
      const settled = store.get(active.id, item.id)!;
      settled.nodes.find(node => node.id === item.id)!.status = 'done';
      store.put(settled);
      expect(await f.request('swarmWorkflow.list', params)).toMatchObject({ running: false });
      expect(await f.request('swarmWorkflow.summary', params)).toEqual({
        count: 1,
        running: false,
      });
      expect(await f.request('swarmWorkflow.activity', {})).toMatchObject({ parentKeys: [] });
    } finally {
      store.close();
    }
  },
);

it('publishes workflow changes through the active Gateway service without leaking bodies', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  expect(f.emit).toHaveBeenCalledWith('reset', {}, { scope: 'operator.read' });
  const created = (await f.request('swarmWorkflow.start', {
    parentKey: f.parentKey,
    requestId: 'event-test',
    goal: 'Private task text',
    mode: 'auto',
  })) as any;
  expect(f.emit).toHaveBeenLastCalledWith(
    'changed',
    {
      parentKey: f.parentKey,
      flowId: created.id,
      revision: created.revision,
    },
    { scope: 'operator.read' },
  );
  f.emit.mockImplementationOnce(() => {
    throw new Error('Transport unavailable');
  });
  await expect(
    f.request('swarmWorkflow.control', {
      parentKeys: [f.parentKey],
      id: created.id,
      revision: created.revision,
      action: 'pause',
    }),
  ).resolves.toBeDefined();
  const listed = (await f.request('swarmWorkflow.list', { parentKeys: [f.parentKey] })) as any;
  expect(listed.flows[0].status).toBe('paused');
});
it('classifies a local launch preflight failure before the SDK invocation as conclusively unstarted', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const runtime = f.api.runtime.subagent;
  let reads = 0;
  Object.defineProperty(f.api.runtime, 'subagent', {
    get: () => {
      reads += 1;
      if (reads === 2) throw new Error('Local execution capability changed.');
      return runtime;
    },
  });
  await f.request('swarmWorkflow.start', {
    parentKey: f.parentKey,
    requestId: 'preflight-capability',
    goal: 'Inspect',
    mode: 'auto',
  });
  await vi.advanceTimersByTimeAsync(1600);
  const flow = ((await f.request('swarmWorkflow.list', { parentKeys: [f.parentKey] })) as any)
    .flows[0];
  expect(reads).toBe(2);
  expect(f.run).not.toHaveBeenCalled();
  expect(flow).toMatchObject({
    status: 'blocked',
    nodes: [expect.objectContaining({ status: 'failed', cleanupSettled: true })],
  });
  expect(flow.nodes[0].error).toContain('Local execution capability changed');
});

it.each(['sync-throw', 'response-loss'] as const)(
  'keeps %s from the invoked SDK outside the preflight proof boundary',
  async kind => {
    vi.useFakeTimers();
    const f = await fixture();
    if (kind === 'sync-throw')
      f.run.mockImplementationOnce(() => {
        throw new Error('SDK response unavailable.');
      });
    else f.run.mockRejectedValueOnce(new Error('SDK response unavailable.'));
    await f.request('swarmWorkflow.start', {
      parentKey: f.parentKey,
      requestId: 'sdk-' + kind,
      goal: 'Inspect',
      mode: 'auto',
    });
    await vi.advanceTimersByTimeAsync(1600);
    const flow = ((await f.request('swarmWorkflow.list', { parentKeys: [f.parentKey] })) as any)
      .flows[0];
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(flow.nodes[0]).toMatchObject({ status: 'uncertain' });
    expect(flow.nodes[0]).not.toHaveProperty('cleanupSettled');
  },
);

it('exposes management only to the parent and binds it to live native invocation authority', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const factory = f.toolFactories.filter(value => value.contextVersion === 2)[1];
  const guard = vi.fn();
  expect(
    factory.create({ sessionKey: 'agent:main:subagent:other', assertInvocationCurrent: guard }),
  ).toBeNull();
  let tools = factory.create({ sessionKey: f.parentKey, assertInvocationCurrent: guard });
  expect(tools.map((tool: any) => tool.name)).toEqual(['swarm_workflow_status']);
  expect((await tools[0].execute('unbound', {})).details.accepted).toBe(false);
  const flow = (await f.request('swarmWorkflow.start', {
    parentKey: f.parentKey,
    requestId: 'manage',
    goal: 'Inspect',
    mode: 'auto',
  })) as any;
  tools = factory.create({ sessionKey: f.parentKey, assertInvocationCurrent: guard });
  const status = tools.find((tool: any) => tool.name === 'swarm_workflow_status');
  const control = tools.find((tool: any) => tool.name === 'swarm_workflow_control');
  const before = f.hooks.get('before_tool_call');
  expect(before({ toolName: status.name }, { sessionKey: f.parentKey })).toMatchObject({
    block: true,
  });
  const context = { sessionKey: f.parentKey, runId: 'manage-turn', toolCallId: 'status' };
  before({ toolName: status.name }, context);
  expect((await status.execute('status', {})).details.id).toBe(flow.id);
  f.hooks.get('after_tool_call')({ toolName: status.name }, context);
  expect((await status.execute('status', {})).details.accepted).toBe(false);
  const signal = new AbortController();
  before(
    { toolName: control.name },
    { ...context, toolCallId: 'pause', abortSignal: signal.signal },
  );
  signal.abort();
  expect(
    (await control.execute('pause', { flowId: flow.id, revision: flow.revision, action: 'pause' }))
      .details.accepted,
  ).toBe(false);
  before({ toolName: control.name }, { ...context, toolCallId: 'pause-ok' });
  expect(
    (
      await control.execute('pause-ok', {
        flowId: flow.id,
        revision: flow.revision,
        action: 'pause',
      })
    ).details.accepted,
  ).toBe(true);
  before({ toolName: status.name }, { ...context, toolCallId: 'expired' });
  await vi.advanceTimersByTimeAsync(31000);
  expect((await status.execute('expired', {})).details.accepted).toBe(false);
  expect(guard).toHaveBeenCalled();
});

it('does not hold node recovery behind a slow main-conversation notification', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  let release!: () => void;
  const pending = new Promise<void>(resolve => {
    release = resolve;
  });
  const originalRequest = f.request.getMockImplementation()!;
  f.request.mockImplementation(async (method, params) => {
    if (method === 'chat.inject') {
      await pending;
      return { ok: true };
    }
    return originalRequest(method, params);
  });
  try {
    await f.request('swarmWorkflow.start', {
      parentKey: f.parentKey,
      requestId: 'slow-notice',
      goal: 'Inspect',
      mode: 'auto',
    });
    await vi.advanceTimersByTimeAsync(1600);
    f.wait.mockResolvedValueOnce({ status: 'error', endedAt: Date.now(), error: 'Missing input' });
    await vi.advanceTimersByTimeAsync(1600);
    const flow = ((await f.request('swarmWorkflow.list', { parentKeys: [f.parentKey] })) as any)
      .flows[0];
    expect(flow.status).toBe('blocked');
    expect(f.request.mock.calls.some(([method]) => method === 'chat.inject')).toBe(true);
    await f.request('swarmWorkflow.intervene', {
      parentKeys: [f.parentKey],
      id: flow.id,
      nodeId: 'plan',
      revision: flow.revision,
      intervention: { id: 'continue-plan', action: 'continue', text: 'Input supplied; continue' },
    });
    await vi.advanceTimersByTimeAsync(1600);
    expect(f.run).toHaveBeenCalledTimes(2);
  } finally {
    release();
  }
});

it.each(['permissions', 'project', 'planning'])(
  'allows safe controls after %s changes through chat and Tab, but rejects a replaced parent',
  async change => {
    vi.useFakeTimers();
    const f = await fixture();
    const flow = (await f.request('swarmWorkflow.start', {
      parentKey: f.parentKey,
      requestId: 'safe-controls',
      goal: 'Inspect',
      mode: 'auto',
    })) as any;
    if (change === 'permissions') f.parent.permissionMode = 'read-only';
    else if (change === 'project') f.parent.sessionRoot = path.join(f.root, 'other');
    else
      Object.assign(f.parent, { pluginExtensions: { 'plan-mode': { state: { enabled: true } } } });
    const factory = f.toolFactories.filter(value => value.contextVersion === 2)[1];
    const tool = factory
      .create({ sessionKey: f.parentKey, assertInvocationCurrent: vi.fn() })
      .find((item: any) => item.name === 'swarm_workflow_control');
    const invoke = async (action: string, revision: number, call: string) => {
      f.hooks.get('before_tool_call')(
        { toolName: tool.name },
        { sessionKey: f.parentKey, runId: 'control-turn', toolCallId: call },
      );
      return (await tool.execute(call, { flowId: flow.id, revision, action })).details;
    };
    const paused = await invoke('pause', flow.revision, 'pause');
    expect(paused).toMatchObject({ accepted: true, flow: { status: 'paused' } });
    expect(await invoke('resume', paused.flow.revision, 'resume')).toMatchObject({
      accepted: false,
    });
    await expect(
      f.request('swarmWorkflow.control', {
        parentKeys: [f.parentKey],
        id: flow.id,
        revision: paused.flow.revision,
        action: 'resume',
      }),
    ).rejects.toThrow('changed');
    f.parent.sessionId = 'replacement-parent';
    expect(await invoke('stop', paused.flow.revision, 'invalid-stop')).toMatchObject({
      accepted: false,
    });
    await expect(
      f.request('swarmWorkflow.control', {
        parentKeys: [f.parentKey],
        id: flow.id,
        revision: paused.flow.revision,
        action: 'stop',
      }),
    ).rejects.toThrow('identity');
    f.parent.sessionId = 'native-parent';
    const stopped = await invoke('stop', paused.flow.revision, 'stop');
    expect(stopped).toMatchObject({ accepted: true, flow: { status: 'stopping' } });
    expect(
      await f.request('swarmWorkflow.control', {
        parentKeys: [f.parentKey],
        id: flow.id,
        revision: stopped.flow.revision,
        action: 'stop',
      }),
    ).toMatchObject({ status: 'stopping' });
    expect(f.run).not.toHaveBeenCalled();
  },
);

it('notifies a native run deadline while the run remains active without repeating the notice', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  await f.request('swarmWorkflow.start', {
    parentKey: f.parentKey,
    requestId: 'run-deadline',
    goal: 'Inspect',
    mode: 'auto',
  });
  await vi.advanceTimersByTimeAsync(1600);
  const start = Date.now();
  f.wait.mockResolvedValue({ status: 'pending', executionStartedAt: start });
  await vi.advanceTimersByTimeAsync(1600);
  vi.setSystemTime(start + 14400001);
  await vi.advanceTimersByTimeAsync(1600);
  const current = ((await f.request('swarmWorkflow.list', { parentKeys: [f.parentKey] })) as any)
    .flows[0];
  expect(current).toMatchObject({
    status: 'blocked',
    nodes: [{ status: 'running', error: expect.stringContaining('budget') }],
  });
  const notices = () => f.request.mock.calls.filter(([method]) => method === 'chat.inject');
  expect(notices()).toHaveLength(1);
  expect(notices()[0][1].message).toContain('budget');
  expect(f.request.mock.calls.some(([method]) => method === 'sessions.abort')).toBe(true);
  await vi.advanceTimersByTimeAsync(3200);
  expect(notices()).toHaveLength(1);
  expect(f.run).toHaveBeenCalledTimes(1);
});

it.each(['permissions', 'project', 'planning'])(
  'notifies a %s admission blocker without admitting more work',
  async change => {
    vi.useFakeTimers();
    const f = await fixture();
    await f.request('swarmWorkflow.start', {
      parentKey: f.parentKey,
      requestId: 'changed-policy-notice',
      goal: 'Inspect',
      mode: 'auto',
    });
    if (change === 'permissions') f.parent.permissionMode = 'read-only';
    else if (change === 'project') f.parent.sessionRoot = path.join(f.root, 'other');
    else
      Object.assign(f.parent, { pluginExtensions: { 'plan-mode': { state: { enabled: true } } } });
    await vi.advanceTimersByTimeAsync(1600);
    const flow = ((await f.request('swarmWorkflow.list', { parentKeys: [f.parentKey] })) as any)
      .flows[0];
    expect(flow.status).toBe('blocked');
    expect(f.run).not.toHaveBeenCalled();
    const notices = () => f.request.mock.calls.filter(([method]) => method === 'chat.inject');
    expect(notices()).toHaveLength(1);
    expect(notices()[0][1].message).toContain('permissions or project changed');
    await vi.advanceTimersByTimeAsync(3200);
    expect(notices()).toHaveLength(1);
    const stopped = await f.request('swarmWorkflow.control', {
      parentKeys: [f.parentKey],
      id: flow.id,
      revision: flow.revision,
      action: 'stop',
    });
    expect(stopped).toMatchObject({ status: 'stopping' });
  },
);

it.each([{ action: ['stop'] }, { action: { action: 'stop' } }, { action: null }, { action: 1 }])(
  'rejects non-string Gateway control action $action without altering a paused flow',
  async ({ action }) => {
    const f = await fixture();
    const flow = (await f.request('swarmWorkflow.start', {
      parentKey: f.parentKey,
      requestId: 'invalid-action',
      goal: 'Inspect',
      mode: 'auto',
    })) as any;
    const paused = (await f.request('swarmWorkflow.control', {
      parentKeys: [f.parentKey],
      id: flow.id,
      revision: flow.revision,
      action: 'pause',
    })) as any;
    await expect(
      f.request('swarmWorkflow.control', {
        parentKeys: [f.parentKey],
        id: flow.id,
        revision: paused.revision,
        action,
      }),
    ).rejects.toThrow('Invalid flow control');
    const current = ((await f.request('swarmWorkflow.list', { parentKeys: [f.parentKey] })) as any)
      .flows[0];
    expect(current).toMatchObject({ status: 'paused', revision: paused.revision });
    expect(f.run).not.toHaveBeenCalled();
  },
);

it.each(['full', 'workspace', 'guarded', 'read-only'])(
  'inherits explicit %s permissions and the project for inspection and verification stages',
  async mode => {
    vi.useFakeTimers();
    const f = await fixture();
    f.parent.permissionMode = mode;
    await f.request('swarmWorkflow.start', {
      parentKey: f.parentKey,
      requestId: 'permission-' + mode,
      goal: 'Inspect',
      mode: 'auto',
    });
    await vi.advanceTimersByTimeAsync(1600);
    f.wait.mockResolvedValueOnce({
      status: 'ok',
      endedAt: Date.now(),
      terminalReply: {
        disposition: 'visible',
        text: JSON.stringify({
          tasks: [
            {
              id: 'inspect',
              title: 'Inspect',
              task: 'Inspect code without modifications',
              access: 'read',
              deps: [],
              batch: null,
            },
          ],
        }),
      },
    });
    await vi.advanceTimersByTimeAsync(1600);
    const worker = f.run.mock.calls[1][0];
    expect(JSON.parse(worker.message)).toMatchObject({
      access: 'read',
      accessInstruction: expect.stringContaining('Do not modify source files'),
    });
    const factory = f.toolFactories.find(value => value.contextVersion === 2);
    const tool = factory
      .create({ sessionKey: worker.sessionKey, assertInvocationCurrent: vi.fn() })
      .find((value: any) => value.name === 'swarm_workflow_complete');
    f.hooks.get('before_tool_call')(
      { toolName: tool.name, params: {} },
      { sessionKey: worker.sessionKey, runId: worker.idempotencyKey, toolCallId: 'done' },
    );
    expect(
      (await tool.execute('done', { summary: 'Inspected', evidence: ['source.ts:1'] })).details
        .accepted,
    ).toBe(true);
    f.wait.mockResolvedValueOnce({
      status: 'ok',
      endedAt: Date.now(),
      terminalReply: { disposition: 'visible', text: 'Checked.' },
    });
    await vi.advanceTimersByTimeAsync(1600);
    const creates = f.request.mock.calls
      .filter(([method]) => method === 'sessions.create')
      .map(([, params]) => params);
    expect(creates).toHaveLength(3);
    for (const params of creates)
      expect(params).toMatchObject({ permissionMode: mode, cwd: f.root });
    expect(creates[2].key).toMatch(/-verify$/);
  },
);
it.each(['native', 'product'])(
  'rechecks %s agent availability before dispatch and blocks instead of replacing its identity',
  async source => {
    vi.useFakeTimers();
    const f = await fixture();
    await f.request('swarmWorkflow.start', {
      parentKey: f.parentKey,
      requestId: 'once',
      goal: 'Inspect',
      mode: 'auto',
    });
    if (source === 'native') f.agents.splice(0);
    else f.config.plugins.entries['swarm-workflow'].config.availableAgentIds.splice(0);
    await vi.advanceTimersByTimeAsync(1600);
    const result = (await f.request('swarmWorkflow.list', { parentKeys: [f.parentKey] })) as any;
    expect(result.flows[0].status).toBe('blocked');
    expect(result.flows[0].nodes[0].error).toContain('no longer available');
    expect(f.run).not.toHaveBeenCalled();
  },
);
it('resolves only the exact current admitted message for the embedded runtime', async () => {
  const f = await fixture();
  const content = 'Inspect\n\n' + buildSwarmWorkflowInstruction({ mode: 'auto', verify: true });
  f.messages.push({ role: 'user', content, idempotencyKey: 'old:user' });
  const event = { prompt: content, messages: [] };
  const context = {
    sessionKey: f.parentKey,
    runId: 'current',
    inputProvenance: { kind: 'external_user' },
  };
  expect((await f.hook(event, context)).prependSystemContext).toContain('could not be confirmed');
  expect(
    ((await f.request('swarmWorkflow.list', { parentKeys: [f.parentKey] })) as any).flows,
  ).toHaveLength(0);
  f.messages.push({ role: 'user', content, idempotencyKey: 'current:user' });
  expect((await f.hook(event, context)).toolsAllow).toBeUndefined();
  await f.tool.execute('call-1', {
    goal: 'Inspect',
    mode: 'auto',
    sourceRequestId: 'current:user',
  });
  await f.tool.execute('call-2', {
    goal: 'Inspect',
    mode: 'auto',
    sourceRequestId: 'current:user',
  });
  await f.tool.execute('call-3', { goal: 'Inspect', mode: 'auto' });
  expect(
    ((await f.request('swarmWorkflow.list', { parentKeys: [f.parentKey] })) as any).flows,
  ).toHaveLength(1);
});
it.each(['auto', 'research', 'review'] as const)(
  'preserves the native tool surface for preparation before %s workflow launch',
  async mode => {
    const f = await fixture();
    const text = 'Inspect project\n\n' + buildSwarmWorkflowInstruction({ mode, verify: true });
    const context = { sessionKey: f.parentKey, runId: 'prepare' };
    f.messages.push({ role: 'user', content: text, idempotencyKey: 'prepare:user' });
    const prompt = await f.hook({ prompt: text, messages: [] }, context);
    for (let index = 0; index < 25; index++)
      f.messages.push({
        role: 'toolResult',
        toolName: 'read',
        content: `Preparation finding ${index}`,
      });
    // Omitting toolsAllow preserves native permissions and catalog projection;
    // setting it to '*' would risk replacing other restrictions.
    expect(prompt).not.toHaveProperty('toolsAllow');
    expect(prompt.prependSystemContext).toContain('prepare a preliminary plan');
    const before = f.hooks.get('before_tool_call');
    for (const toolName of ['skills_read', 'skills_search', 'progress_card'])
      expect(before({ toolName, params: {} }, context)).toBeUndefined();
    for (const toolName of [
      'ask_user',
      'read',
      'write',
      'exec',
      'browser',
      'session_status',
      'sessions_spawn',
    ])
      expect(before({ toolName, params: {} }, context)).toBeUndefined();
    expect(
      before(
        {
          toolName: 'exec',
          toolKind: 'code_mode_exec',
          toolInputKind: 'javascript',
        },
        context,
      ),
    ).toBeUndefined();
    expect(before({ toolName: 'write', params: {} }, context)).toBeUndefined();
    expect(
      ((await f.request('swarmWorkflow.list', { parentKeys: [f.parentKey] })) as any).flows,
    ).toEqual([]);
    expect(f.run).not.toHaveBeenCalled();
    const correction = await f.hooks.get('before_agent_finalize')(
      {
        ...context,
        stopHookActive: false,
        messages: [],
      },
      context,
    );
    expect(correction).toMatchObject({ action: 'revise' });
    expect(
      (await f.hook({ prompt: 'Native correction without a marker', messages: [] }, context))
        .toolsAllow,
    ).toEqual(prompt.toolsAllow);
    const goal = 'Inspect project using the preparation findings and verify the result.';
    await f.tool.execute('prepared-start', { goal, mode, sourceRequestId: 'prepare:user' });
    const flows = ((await f.request('swarmWorkflow.list', { parentKeys: [f.parentKey] })) as any)
      .flows;
    expect(flows).toHaveLength(1);
    expect(flows[0].goal).toBe(goal);
  },
);
it('does not reuse an older request when preparation history contains a newer user', async () => {
  const f = await fixture();
  const text = 'Inspect\n\n' + buildSwarmWorkflowInstruction({ mode: 'auto', verify: true });
  const context = { sessionKey: f.parentKey, runId: 'original' };
  f.messages.push({ role: 'user', content: text, idempotencyKey: 'original:user' });
  await f.hook({ prompt: text }, context);
  f.messages.push({ role: 'user', content: 'Cancel that request', idempotencyKey: 'new:user' });
  for (let index = 0; index < 25; index++)
    f.messages.push({ role: 'toolResult', content: `Preparation ${index}` });
  const result = f.hooks.get('before_tool_call')(
    { toolName: 'swarm_workflow_start', params: { goal: 'Inspect', mode: 'auto' } },
    context,
  );
  expect(result.params.sourceRequestId).toBe('original:user');
  await expect(f.tool.execute('old-call', result.params)).rejects.toThrow('no longer current');
  expect((await f.hook({ prompt: 'Native correction' }, context)).toolsAllow).toEqual([]);
  expect(
    await f.hooks.get('before_agent_finalize')({ ...context, stopHookActive: false }, context),
  ).toBeUndefined();
  expect(
    ((await f.request('swarmWorkflow.list', { parentKeys: [f.parentKey] })) as any).flows,
  ).toEqual([]);
});
it.each(['restart', 'identity', 'project', 'permissions', 'policy', 'plan'])(
  'rejects %s during source history lookup before issuing a native flow admission',
  async change => {
    vi.useFakeTimers();
    const f = await fixture();
    f.messages.push({
      role: 'user',
      content: 'Use Swarm Workflow to inspect',
      idempotencyKey: 'source:user',
    });
    const request = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method, params) => {
      const result = await request(method, params);
      if (method === 'chat.history') {
        if (change === 'restart') {
          await f.service.stop();
          await f.service.start({
            stateDir: f.root,
            gatewayEvents: { emit: f.emit },
            logger: { error: vi.fn() },
          });
        } else if (change === 'identity') f.parent.sessionId = 'changed';
        else if (change === 'project') f.parent.sessionRoot = path.join(f.root, 'changed');
        else if (change === 'permissions') f.parent.permissionMode = 'read-only';
        else if (change === 'policy')
          Object.assign(f.parent, { toolOverrides: { disabled: ['exec'] } });
        else
          Object.assign(f.parent, {
            pluginExtensions: { 'plan-mode': { state: { enabled: true } } },
          });
      }
      return result;
    });
    await expect(f.tool.execute('lookup-race', { goal: 'Inspect', mode: 'auto' })).rejects.toThrow(
      'before flow creation',
    );
    expect(f.request.mock.calls.some(([method]) => method === 'swarmWorkflow.start')).toBe(false);
    expect(f.run).not.toHaveBeenCalled();
  },
);
it.each(['expired', 'project', 'permissions', 'policy', 'mode', 'request'])(
  'rejects %s after source preparation instead of adopting a different launch context',
  async change => {
    vi.useFakeTimers();
    const f = await fixture();
    const text = 'Inspect\n\n' + buildSwarmWorkflowInstruction({ mode: 'auto', verify: true });
    f.messages.push({ role: 'user', content: text, idempotencyKey: 'prepare:user' });
    const context = { sessionKey: f.parentKey, runId: 'prepare' };
    await f.hook({ prompt: text }, context);
    const params = { goal: 'Inspect', mode: 'auto', sourceRequestId: 'prepare:user' };
    if (change === 'expired') vi.setSystemTime(Date.now() + 30 * 60 * 1000 + 1);
    if (change === 'project') f.parent.sessionRoot = path.join(f.root, 'changed');
    if (change === 'permissions') f.parent.permissionMode = 'read-only';
    if (change === 'policy') Object.assign(f.parent, { toolOverrides: { disabled: ['exec'] } });
    if (change === 'mode') params.mode = 'review';
    if (change === 'request') params.sourceRequestId = 'other:user';
    expect(
      f.hooks.get('before_tool_call')({ toolName: 'swarm_workflow_start', params }, context),
    ).toMatchObject({ block: true });
    if (change !== 'request')
      await expect(f.tool.execute('late-launch', params)).rejects.toThrow('before flow creation');
    expect(f.run).not.toHaveBeenCalled();
  },
);
it('hides a Swarm start while the generic source lane is unavailable and rejects a retained definition', async () => {
  const f = await fixture();
  const startFactory = f.toolFactories.at(-1);
  const ctx = {
    sessionKey: f.parentKey,
    sessionId: f.parent.sessionId,
    assertInvocationCurrent: vi.fn(),
  };
  expect(startFactory.create(ctx).name).toBe('swarm_workflow_start');
  f.setExecutionAdmission({ state: 'unknown', generation: 1 });
  expect(startFactory.create(ctx)).toBeNull();
  await expect(f.tool.execute('competing', { goal: 'Inspect', mode: 'auto' })).rejects.toThrow(
    'execution admission',
  );
  expect(f.request.mock.calls.some(([method]) => method === 'swarmWorkflow.start')).toBe(false);
  f.setExecutionAdmission({ state: 'clear', generation: 1 });
  expect(startFactory.create(ctx).name).toBe('swarm_workflow_start');
});
it('blocks competing Team dispatch before native Team admission while preserving preparation and cleanup', async () => {
  const f = await fixture();
  const text = 'Inspect\n\n' + buildSwarmWorkflowInstruction({ mode: 'auto', verify: true });
  f.messages.push({ role: 'user', content: text, idempotencyKey: 'launch:user' });
  const context = { sessionKey: f.parentKey, runId: 'launch' };
  await f.hook({ prompt: text }, context);
  const before = f.hooks.get('before_tool_call');
  expect(f.hookOptions.get('before_tool_call').priority).toBeGreaterThan(0);
  for (const event of [
    { toolName: 'task_assistants', params: { agentId: 'worker' } },
    { toolName: 'team_discussion', params: { action: 'create' } },
    { toolName: 'team_discussion', params: { action: 'send' } },
    { toolName: 'sessions_send', params: { sessionKey: 'agent:worker:justdo:peer' } },
  ])
    expect(before(event, context)).toMatchObject({ block: true });
  for (const event of [
    { toolName: 'task_assistants', params: {} },
    { toolName: 'task_assistants', params: { seal: true } },
    { toolName: 'task_assistants', params: { review: { verdict: 'passed' } } },
    { toolName: 'team_discussion', params: { action: 'read' } },
    { toolName: 'team_discussion', params: { action: 'stop' } },
    { toolName: 'sessions_send', params: { sessionKey: 'agent:main:subagent:preparation' } },
    { toolName: 'exec', params: {} },
  ])
    expect(before(event, context)).toBeUndefined();
  expect(
    before(
      { toolName: 'team_discussion', params: { action: 'create' } },
      { ...context, runId: 'ordinary' },
    ),
  ).toBeUndefined();
  expect(f.run).not.toHaveBeenCalled();
});
it('keeps the selected mode after acceptance until the exact source whole-run terminal', async () => {
  const f = await fixture();
  const text = 'Inspect\n\n' + buildSwarmWorkflowInstruction({ mode: 'auto', verify: true });
  f.messages.push({ role: 'user', content: text, idempotencyKey: 'launch:user' });
  const context = { sessionKey: f.parentKey, runId: 'launch' };
  await f.hook({ prompt: text }, context);
  await f.tool.execute('accept', { goal: 'Inspect', mode: 'auto', sourceRequestId: 'launch:user' });
  const before = f.hooks.get('before_tool_call');
  const competing = { toolName: 'team_discussion', params: { action: 'create' } };
  expect(before(competing, context)).toMatchObject({ block: true });
  expect((await f.hook({ prompt: 'Native continuation' }, context)).prependSystemContext).toContain(
    'already has an accepted flow',
  );
  const terminal = {
    sessionKey: f.parentKey,
    sessionId: f.parent.sessionId,
    runId: 'launch',
    stream: 'lifecycle',
    data: { phase: 'end', executionSettled: true },
  };
  for (const event of [
    { ...terminal, sessionId: 'other' },
    { ...terminal, runId: 'other' },
    { ...terminal, data: { phase: 'end', executionSettled: false } },
  ]) {
    for (const listener of f.nativeListeners) listener(event);
    expect(before(competing, context)).toMatchObject({ block: true });
  }
  for (const listener of f.nativeListeners) listener(terminal);
  expect(before(competing, context)).toBeUndefined();
  await f.service.stop();
  expect(f.nativeListeners.size).toBe(0);
});
it('does not let a retained source-terminal listener clear a new service generation', async () => {
  const f = await fixture();
  const oldListener = [...f.nativeListeners][0];
  await f.service.stop();
  await f.service.start({
    stateDir: f.root,
    gatewayEvents: { emit: f.emit },
    logger: { error: vi.fn() },
  });
  const text = 'Inspect\n\n' + buildSwarmWorkflowInstruction({ mode: 'auto', verify: true });
  f.messages.push({ role: 'user', content: text, idempotencyKey: 'launch:user' });
  const context = { sessionKey: f.parentKey, runId: 'launch' };
  await f.hook({ prompt: text }, context);
  oldListener({
    sessionKey: f.parentKey,
    sessionId: f.parent.sessionId,
    runId: 'launch',
    stream: 'lifecycle',
    data: { phase: 'end', executionSettled: true },
  });
  expect(
    f.hooks.get('before_tool_call')(
      { toolName: 'team_discussion', params: { action: 'create' } },
      context,
    ),
  ).toMatchObject({ block: true });
});
it('intersects the native roster with live product admission before creating or dispatching work', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  f.agents.push({ id: 'reviewer', name: 'Reviewer' }, { id: 'deleted', name: 'Deleted' });
  f.config.plugins.entries['swarm-workflow'].config.availableAgentIds.push('reviewer');
  await f.request('swarmWorkflow.start', {
    parentKey: f.parentKey,
    requestId: 'roster',
    goal: 'Inspect',
    mode: 'auto',
  });
  await vi.advanceTimersByTimeAsync(1600);
  const prompt = JSON.parse(f.run.mock.calls[0][0].message);
  expect(prompt.availableAgents.map((agent: any) => agent.id)).toEqual(['main', 'reviewer']);
  f.config.plugins.entries['swarm-workflow'].config.availableAgentIds.splice(0);
  await expect(
    f.request('swarmWorkflow.start', {
      parentKey: f.parentKey,
      requestId: 'new',
      goal: 'New task',
      mode: 'auto',
    }),
  ).rejects.toThrow('main agent is unavailable');
});
it.each(['stop', 'restart', 'planning', 'expired', 'identity', 'project', 'permissions', 'policy'])(
  'rejects a launch invalidated by %s during the native roster lookup without creating a flow',
  async change => {
    vi.useFakeTimers();
    const f = await fixture();
    f.messages.push({
      role: 'user',
      content: 'Inspect\n\n' + buildSwarmWorkflowInstruction({ mode: 'auto', verify: true }),
      idempotencyKey: 'roster-race:user',
    });
    const request = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method, params) => {
      const result = await request(method, params);
      if (method === 'agents.list') {
        if (change === 'stop' || change === 'restart') {
          await f.service.stop();
          if (change === 'restart')
            await f.service.start({
              stateDir: f.root,
              gatewayEvents: { emit: f.emit },
              logger: { error: vi.fn() },
            });
        } else if (change === 'expired') vi.setSystemTime(Date.now() + 30001);
        else if (change === 'planning')
          Object.assign(f.parent, {
            pluginExtensions: { 'plan-mode': { state: { enabled: true } } },
          });
        else if (change === 'identity') f.parent.sessionId = 'changed';
        else if (change === 'project') f.parent.sessionRoot = path.join(f.root, 'changed');
        else if (change === 'permissions') f.parent.permissionMode = 'read-only';
        else (f.parent as any).toolOverrides = { disabled: ['exec'] };
      }
      return result;
    });
    await expect(
      f.tool.execute('launch', {
        goal: 'Inspect',
        mode: 'auto',
        sourceRequestId: 'roster-race:user',
      }),
    ).rejects.toThrow('before flow creation');
    if (change === 'stop')
      await f.service.start({
        stateDir: f.root,
        gatewayEvents: { emit: f.emit },
        logger: { error: vi.fn() },
      });
    expect(
      ((await f.request('swarmWorkflow.list', { parentKeys: [f.parentKey] })) as any).flows,
    ).toEqual([]);
    expect(f.run).not.toHaveBeenCalled();
  },
);
it('requests a self-contained brief in the parent conversation before admitting a durable flow', async () => {
  const f = await fixture();
  const text =
    'Inspect project\n\n' + buildSwarmWorkflowInstruction({ mode: 'auto', verify: true });
  const context = { sessionKey: f.parentKey, inputProvenance: { kind: 'external_user' } };
  const event = {
    prompt: text,
    currentUserMessage: text,
    currentUserMessageId: 'admitted-user-1',
    messages: [],
  };
  const instruction = await f.hook(event, context);
  expect(instruction.toolsAllow).toBeUndefined();
  expect(instruction.prependSystemContext).toContain('current attachments');
  expect(instruction.prependSystemContext).toContain('self-contained goal');
  await f.hook(event, context);
  expect(
    ((await f.request('swarmWorkflow.list', { parentKeys: [f.parentKey] })) as any).flows,
  ).toHaveLength(0);
  f.messages.push({ role: 'user', content: text, idempotencyKey: 'admitted-user-1' });
  await f.tool.execute('call-1', {
    goal: 'Inspect project',
    mode: 'auto',
    sourceRequestId: 'admitted-user-1',
  });
  const listed = (await f.request('swarmWorkflow.list', { parentKeys: [f.parentKey] })) as any;
  expect(listed.flows).toHaveLength(1);
  expect(listed.flows[0].nodes[0].kind).toBe('plan');
  expect(await f.hook({ ...event, currentUserMessage: 'Normal follow-up' }, context)).toMatchObject(
    { prependSystemContext: expect.stringContaining('swarm_workflow_status') },
  );
  expect(
    await f.hook(event, { ...context, inputProvenance: { kind: 'inter_session' } }),
  ).toBeUndefined();
  expect(f.request.mock.calls.some(([method]) => method.startsWith('workboard'))).toBe(false);
});
it('permits native preparation and Code Mode targets without substituting the selected workflow', async () => {
  const f = await fixture();
  const text =
    'Inspect project\n\n' + buildSwarmWorkflowInstruction({ mode: 'auto', verify: true });
  f.messages.push({ role: 'user', content: text, idempotencyKey: 'launch:user' });
  const context = { sessionKey: f.parentKey, runId: 'launch' };
  const prompt = await f.hook({ prompt: text, messages: [] }, context);
  expect(prompt.appendSystemContext).toContain(
    'The service owns the execution DAG and delegated work',
  );
  const before = f.hooks.get('before_tool_call');
  expect(before({ toolName: 'fixture_other_tool' }, context)).toBeUndefined();
  expect(before({ toolName: 'exec' }, context)).toBeUndefined();
  expect(
    before({ toolName: 'exec', toolKind: 'code_mode_exec', toolInputKind: 'javascript' }, context),
  ).toBeUndefined();
  for (const toolName of ['tool_search', 'tool_describe', 'tool_call']) {
    expect(before({ toolName }, context)).toBeUndefined();
  }
  // Native Tool Search controls run the hook again for the resolved target.
  expect(before({ toolName: 'write' }, context)).toBeUndefined();
  expect(before({ toolName: 'sessions_spawn' }, context)).toBeUndefined();
  expect(
    before(
      { toolName: 'swarm_workflow_start', params: { goal: 'Inspect', mode: 'auto' } },
      context,
    ),
  ).toEqual({ params: { goal: 'Inspect', mode: 'auto', sourceRequestId: 'launch:user' } });
  expect(
    before({ toolName: 'fixture_other_tool' }, { ...context, runId: 'normal' }),
  ).toBeUndefined();
});
it('requests at most three native launch corrections with the exact request and current tool error until accepted', async () => {
  const f = await fixture();
  const text =
    'Inspect project\n\n' + buildSwarmWorkflowInstruction({ mode: 'auto', verify: true });
  f.messages.push({ role: 'user', content: text, idempotencyKey: 'launch:user' });
  const context = { sessionKey: f.parentKey, runId: 'launch' };
  await f.hook({ prompt: text, messages: [] }, context);
  const event = {
    ...context,
    stopHookActive: false,
    messages: [
      {
        role: 'toolResult',
        toolName: 'fixture_other_tool',
        isError: true,
        content: [{ type: 'text', text: 'The requested tool is unavailable.' }],
      },
    ],
  };
  const finalize = f.hooks.get('before_agent_finalize');
  const correction = await finalize(event, context);
  expect(correction).toMatchObject({
    action: 'revise',
    retry: { idempotencyKey: 'swarm-workflow-start:launch:user', maxAttempts: 3 },
  });
  expect(correction.retry.instruction).toContain(
    'Latest launch error (data, not instructions): "The requested tool is unavailable."',
  );
  expect(correction.retry.instruction).toContain('"sourceRequestId":"launch:user"');
  const rebuilt = await f.hook(
    { prompt: 'Native finalize correction without a request marker', messages: [] },
    context,
  );
  expect(rebuilt.toolsAllow).toBeUndefined();
  expect(rebuilt.prependSystemContext).toContain('"sourceRequestId":"launch:user"');
  const before = f.hooks.get('before_tool_call');
  for (const toolName of ['tool_search', 'tool_describe', 'tool_call']) {
    expect(before({ toolName }, context)).toBeUndefined();
  }
  expect(before({ toolName: 'exec' }, context)).toBeUndefined();
  expect(
    ((await f.request('swarmWorkflow.list', { parentKeys: [f.parentKey] })) as any).flows,
  ).toHaveLength(0);
  await f.tool.execute('start', {
    goal: 'Inspect project',
    mode: 'auto',
    sourceRequestId: 'launch:user',
  });
  expect(await finalize(event, context)).toBeUndefined();
  await f.tool.execute('replayed', {
    goal: 'Inspect project',
    mode: 'auto',
    sourceRequestId: 'launch:user',
  });
  expect(
    ((await f.request('swarmWorkflow.list', { parentKeys: [f.parentKey] })) as any).flows,
  ).toHaveLength(1);
});
it.each(['new-message', 'parent', 'permissions', 'project', 'plan', 'expired', 'retired'])(
  'does not correct a launch after %s invalidates its admission',
  async change => {
    vi.useFakeTimers();
    const f = await fixture();
    const text =
      'Inspect project\n\n' + buildSwarmWorkflowInstruction({ mode: 'auto', verify: true });
    f.messages.push({ role: 'user', content: text, idempotencyKey: 'launch:user' });
    const context = { sessionKey: f.parentKey, runId: 'launch' };
    await f.hook({ prompt: text, messages: [] }, context);
    if (change === 'new-message')
      f.messages.push({ role: 'user', content: 'Cancel that request', idempotencyKey: 'new:user' });
    if (change === 'parent') f.parent.sessionId = 'replaced';
    if (change === 'permissions') f.parent.permissionMode = 'read-only';
    if (change === 'project') f.parent.sessionRoot = path.join(f.root, 'other');
    if (change === 'plan')
      Object.assign(f.parent, { pluginExtensions: { 'plan-mode': { state: { enabled: true } } } });
    if (change === 'expired') vi.setSystemTime(Date.now() + 30 * 60 * 1000 + 1);
    if (change === 'retired') await f.service.stop();
    expect(
      await f.hooks.get('before_agent_finalize')({ ...context, stopHookActive: false }, context),
    ).toBeUndefined();
    expect(f.run).not.toHaveBeenCalled();
  },
);
it.each(['permissions', 'expired'])(
  'rechecks %s after an asynchronous launch correction history read',
  async change => {
    vi.useFakeTimers();
    const f = await fixture();
    const text = 'Inspect\n\n' + buildSwarmWorkflowInstruction({ mode: 'auto', verify: true });
    f.messages.push({ role: 'user', content: text, idempotencyKey: 'launch:user' });
    const context = { sessionKey: f.parentKey, runId: 'launch' };
    await f.hook({ prompt: text, messages: [] }, context);
    const request = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method, params) => {
      const result = await request(method, params);
      if (method === 'chat.history') {
        if (change === 'permissions') f.parent.permissionMode = 'read-only';
        else vi.setSystemTime(Date.now() + 30 * 60 * 1000 + 1);
      }
      return result;
    });
    expect(
      await f.hooks.get('before_agent_finalize')({ ...context, stopHookActive: false }, context),
    ).toBeUndefined();
  },
);
it.each([
  ['launch', 'stop'],
  ['launch', 'restart'],
  ['correction', 'stop'],
  ['correction', 'restart'],
  ['correction', 'expired'],
])('does not re-admit a %s turn after %s during its prompt history read', async (turn, change) => {
  vi.useFakeTimers();
  const f = await fixture();
  const text = 'Inspect\n\n' + buildSwarmWorkflowInstruction({ mode: 'auto', verify: true });
  f.messages.push({ role: 'user', content: text, idempotencyKey: 'launch:user' });
  const context = { sessionKey: f.parentKey, runId: 'launch' };
  if (turn === 'correction') await f.hook({ prompt: text }, context);
  const request = f.request.getMockImplementation()!;
  f.request.mockImplementation(async (method, params) => {
    const result = await request(method, params);
    if (method === 'chat.history') {
      if (change === 'expired') vi.setSystemTime(Date.now() + 30 * 60 * 1000 + 1);
      else {
        await f.service.stop();
        if (change === 'restart')
          await f.service.start({
            stateDir: f.root,
            gatewayEvents: { emit: f.emit },
            logger: { error: vi.fn() },
          });
      }
    }
    return result;
  });
  const prompt = await f.hook({ prompt: turn === 'launch' ? text : 'Native correction' }, context);
  expect(prompt.toolsAllow).toEqual([]);
  expect(
    await f.hooks.get('before_agent_finalize')({ ...context, stopHookActive: false }, context),
  ).toBeUndefined();
  expect(f.run).not.toHaveBeenCalled();
});
it('preserves resolved prior context and image details in the task brief, without copying native history', async () => {
  const f = await fixture();
  const text =
    'Implement the above design from this image\n\n' +
    buildSwarmWorkflowInstruction({ mode: 'auto', verify: true });
  f.messages.push(
    { role: 'assistant', content: 'Build a settings page with two columns.' },
    {
      role: 'user',
      idempotencyKey: 'image:user',
      content: [
        { type: 'image', data: 'native-only' },
        { type: 'text', text },
      ],
    },
  );
  const result = await f.hook(
    { prompt: text, messages: f.messages },
    { sessionKey: f.parentKey, runId: 'image' },
  );
  expect(result.toolsAllow).toBeUndefined();
  const goal =
    'Build the agreed two-column settings page. The supplied image has a blue sidebar and a white content area.';
  await f.tool.execute('call-1', { goal, mode: 'auto', sourceRequestId: 'image:user' });
  const flows = ((await f.request('swarmWorkflow.list', { parentKeys: [f.parentKey] })) as any)
    .flows;
  expect(flows[0].goal).toBe(goal);
  expect(JSON.stringify(flows)).not.toContain('native-only');
  f.messages.push({ role: 'user', content: 'New request', idempotencyKey: 'later:user' });
  await expect(
    f.tool.execute('stale', { goal, mode: 'auto', sourceRequestId: 'image:user' }),
  ).rejects.toThrow('no longer current');
});
it('does not start tasks when stable admission identity or parent permissions are unavailable', async () => {
  const f = await fixture();
  const text = 'Inspect\n\n' + buildSwarmWorkflowInstruction({ mode: 'review', verify: true });
  const result = await f.hook({ currentUserMessage: text }, { sessionKey: f.parentKey });
  expect(result.prependSystemContext).toContain('could not be confirmed');
  const list = (await f.request('swarmWorkflow.list', { parentKeys: [f.parentKey] })) as any;
  expect(list.flows).toHaveLength(0);
  f.parent.permissionMode = 'unknown';
  await expect(
    f.request('swarmWorkflow.start', {
      parentKey: f.parentKey,
      requestId: 'a',
      goal: 'goal',
      mode: 'auto',
    }),
  ).rejects.toThrow();
});
it('rejects control through a different parent and preserves flow state on service reload', async () => {
  const f = await fixture();
  const started = (await f.request('swarmWorkflow.start', {
    parentKey: f.parentKey,
    requestId: 'once',
    goal: 'goal',
    mode: 'auto',
  })) as any;
  await expect(
    f.request('swarmWorkflow.control', {
      parentKeys: ['agent:main:justdo:other'],
      id: started.id,
      revision: started.revision,
      action: 'stop',
    }),
  ).rejects.toThrow();
  await f.service.stop();
  await f.service.start({
    stateDir: f.root,
    gatewayEvents: { emit: f.emit },
    logger: { error: vi.fn() },
  });
  const list = (await f.request('swarmWorkflow.list', { parentKeys: [f.parentKey] })) as any;
  expect(list.flows[0].id).toBe(started.id);
});

it('authorizes detail by parent and preserves the exact dispatch outside list polling', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  await f.request('swarmWorkflow.start', {
    parentKey: f.parentKey,
    requestId: 'detail',
    goal: 'Inspect',
    mode: 'auto',
  });
  const list = (await f.request('swarmWorkflow.list', { parentKeys: [f.parentKey] })) as any;
  const params = { parentKeys: [f.parentKey], id: list.flows[0].id, nodeId: 'plan' };
  expect(await f.request('swarmWorkflow.detail', params)).toMatchObject({ submission: 'not_sent' });
  await expect(
    f.request('swarmWorkflow.detail', { ...params, parentKeys: ['agent:main:justdo:foreign'] }),
  ).rejects.toThrow();
  await expect(
    f.request('swarmWorkflow.detail', { ...params, sourceId: 'not-a-dependency' }),
  ).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(1600);
  const detail = (await f.request('swarmWorkflow.detail', params)) as any;
  expect(detail.submission).toBe('submitted');
  expect(detail.dispatch.message).toBe(f.run.mock.calls[0][0].message);
  const refreshed = (await f.request('swarmWorkflow.list', { parentKeys: [f.parentKey] })) as any;
  expect(refreshed.flows[0].nodes[0]).not.toHaveProperty('dispatch');
});

it('scopes submission tools to native worker runs and allows correcting rejected fields before a durable handoff', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const factory = f.toolFactories.find(factory => factory.contextVersion === 2);
  expect(factory.create({ sessionKey: f.parentKey })).toBeNull();
  expect(
    factory.create({ sessionKey: 'agent:main:subagent:swarm-workflow-forged-task-1' }),
  ).toBeNull();
  await f.request('swarmWorkflow.start', {
    parentKey: f.parentKey,
    requestId: 'receipt-test',
    goal: 'Inspect',
    mode: 'auto',
  });
  await vi.advanceTimersByTimeAsync(1600);
  f.wait.mockResolvedValueOnce({
    status: 'ok',
    endedAt: Date.now(),
    terminalReply: {
      disposition: 'visible',
      text: JSON.stringify({
        tasks: [
          {
            id: 'inspect',
            title: 'Inspect',
            task: 'Inspect code',
            access: 'read',
            deps: [],
            batch: null,
          },
        ],
      }),
    },
  });
  await vi.advanceTimersByTimeAsync(1600);
  const worker = f.run.mock.calls[1][0];
  const guard = vi.fn();
  const tool = factory
    .create({ sessionKey: worker.sessionKey, assertInvocationCurrent: guard })
    .find((tool: any) => tool.name === 'swarm_workflow_complete');
  const context = {
    sessionKey: worker.sessionKey,
    runId: worker.idempotencyKey,
    toolCallId: 'submit-1',
  };
  const before = f.hooks.get('before_tool_call');
  expect(before({ toolName: tool.name, params: {} }, { ...context, runId: 'stale' })).toMatchObject(
    { block: true },
  );
  expect(
    (await tool.execute(context.toolCallId, { summary: 'Fake', evidence: ['file'] })).details
      .accepted,
  ).toBe(false);
  before({ toolName: tool.name, params: {} }, context);
  expect(
    (
      await tool.execute(context.toolCallId, {
        summary: 'Result',
        evidence: ['file'],
        nodeId: 'foreign',
      })
    ).details.accepted,
  ).toBe(false);
  before({ toolName: tool.name, params: {} }, context);
  expect(
    (await tool.execute(context.toolCallId, { summary: 'Result', evidence: [] })).details.accepted,
  ).toBe(false);
  before({ toolName: tool.name, params: {} }, context);
  expect(
    (await tool.execute(context.toolCallId, { summary: 'Result', evidence: ['file.ts:10'] }))
      .details.accepted,
  ).toBe(true);
  expect(guard).toHaveBeenCalled();
  expect(f.run).toHaveBeenCalledTimes(2);
  f.wait.mockResolvedValueOnce({
    status: 'ok',
    endedAt: Date.now(),
    terminalReply: { disposition: 'visible', text: '我已完成核对。' },
  });
  await vi.advanceTimersByTimeAsync(1600);
  const result = (await f.request('swarmWorkflow.list', { parentKeys: [f.parentKey] })) as any;
  expect(result.flows[0].nodes.find((node: any) => node.id === 'task-1').status).toBe('done');
  expect(f.run).toHaveBeenCalledTimes(3);
  const verify = f.run.mock.calls[2][0];
  const verifyTool = factory
    .create({ sessionKey: verify.sessionKey, assertInvocationCurrent: guard })
    .find((tool: any) => tool.name === 'swarm_workflow_verify');
  const verifyContext = {
    sessionKey: verify.sessionKey,
    runId: verify.idempotencyKey,
    toolCallId: 'verify-1',
  };
  before({ toolName: verifyTool.name, params: {} }, verifyContext);
  expect(
    (
      await verifyTool.execute('verify-1', {
        passed: true,
        summary: 'Checked',
        evidence: ['test passed'],
      })
    ).details.accepted,
  ).toBe(true);
  f.wait.mockResolvedValueOnce({
    status: 'ok',
    endedAt: Date.now(),
    terminalReply: { disposition: 'visible', text: '自然语言验收说明，无需 JSON。' },
  });
  await vi.advanceTimersByTimeAsync(1600);
  expect(f.run).toHaveBeenCalledTimes(4);
});
it('shares the active Gateway service with separately registered specialist tools without transferring lifecycle ownership', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  f.agents.push({ id: 'reviewer', name: 'Reviewer' });
  f.config.plugins.entries['swarm-workflow'].config.availableAgentIds.push('reviewer');
  const goal = 'Use reviewer to inspect code.';
  await f.request('swarmWorkflow.start', {
    parentKey: f.parentKey,
    requestId: 'specialist',
    goal,
    mode: 'auto',
  });
  await vi.advanceTimersByTimeAsync(1600);
  f.wait.mockResolvedValueOnce({
    status: 'ok',
    endedAt: Date.now(),
    terminalReply: {
      disposition: 'visible',
      text: JSON.stringify({
        tasks: [
          {
            id: 'inspect',
            title: 'Inspect',
            task: 'Inspect code',
            access: 'read',
            deps: [],
            batch: null,
            agentId: 'reviewer',
            agentRequest: goal,
          },
        ],
      }),
    },
  });
  await vi.advanceTimersByTimeAsync(1600);
  const worker = f.run.mock.calls[1][0];
  expect(worker.sessionKey).toMatch(/^agent:reviewer:/);
  const registry = f.registerAgent();
  await registry.service.stop();
  expect(await f.request('swarmWorkflow.health', {})).toMatchObject({ ready: true });
  const guard = vi.fn();
  const tool = registry.tools
    .find(value => value.contextVersion === 2)
    .create({ sessionKey: worker.sessionKey, assertInvocationCurrent: guard })
    .find((value: any) => value.name === 'swarm_workflow_complete');
  const context = {
    sessionKey: worker.sessionKey,
    runId: worker.idempotencyKey,
    toolCallId: 'specialist-result',
  };
  expect(
    registry.hooks.get('before_tool_call')({ toolName: tool.name, params: {} }, context),
  ).toBeUndefined();
  expect(
    (await tool.execute(context.toolCallId, { summary: 'Inspected', evidence: ['source.ts:1'] }))
      .details.accepted,
  ).toBe(true);
  expect(guard).toHaveBeenCalled();
  f.wait.mockResolvedValueOnce({
    status: 'ok',
    endedAt: Date.now(),
    terminalReply: { disposition: 'visible', text: 'Inspection complete.' },
  });
  await vi.advanceTimersByTimeAsync(1600);
  const result = (await f.request('swarmWorkflow.list', { parentKeys: [f.parentKey] })) as any;
  expect(result.flows[0].nodes.find((node: any) => node.id === 'task-1').status).toBe('done');
});
it.each([
  { evidence: 'file.ts:10 checked; no source modifications.' },
  { evidence: ['file.ts:10 checked', 'No source modifications.'] },
])(
  'accepts explicit evidence-only submissions and persists canonical receipts: %j',
  async fields => {
    vi.useFakeTimers();
    const f = await fixture();
    await f.request('swarmWorkflow.start', {
      parentKey: f.parentKey,
      requestId: 'evidence-only',
      goal: 'Inspect',
      mode: 'auto',
    });
    await vi.advanceTimersByTimeAsync(1600);
    f.wait.mockResolvedValueOnce({
      status: 'ok',
      endedAt: Date.now(),
      terminalReply: {
        disposition: 'visible',
        text: JSON.stringify({
          tasks: [
            {
              id: 'inspect',
              title: 'Inspect',
              task: 'Inspect code',
              access: 'read',
              deps: [],
              batch: null,
            },
          ],
        }),
      },
    });
    await vi.advanceTimersByTimeAsync(1600);
    const worker = f.run.mock.calls[1][0];
    const factory = f.toolFactories.find(value => value.contextVersion === 2);
    const tool = factory
      .create({ sessionKey: worker.sessionKey, assertInvocationCurrent: vi.fn() })
      .find((value: any) => value.name === 'swarm_workflow_complete');
    const context = {
      sessionKey: worker.sessionKey,
      runId: worker.idempotencyKey,
      toolCallId: 'evidence-result',
    };
    const before = f.hooks.get('before_tool_call');
    before({ toolName: tool.name, params: fields }, context);
    expect((await tool.execute(context.toolCallId, fields)).details.accepted).toBe(true);
    const revision = ((await f.request('swarmWorkflow.list', { parentKeys: [f.parentKey] })) as any)
      .flows[0].revision;
    before({ toolName: tool.name, params: fields }, context);
    expect((await tool.execute(context.toolCallId, fields)).details.accepted).toBe(true);
    expect(
      ((await f.request('swarmWorkflow.list', { parentKeys: [f.parentKey] })) as any).flows[0]
        .revision,
    ).toBe(revision);
    f.wait.mockResolvedValueOnce({
      status: 'ok',
      endedAt: Date.now(),
      terminalReply: { disposition: 'visible', text: 'Natural-language report.' },
    });
    await vi.advanceTimersByTimeAsync(1600);
    const result = ((await f.request('swarmWorkflow.list', { parentKeys: [f.parentKey] })) as any)
      .flows[0];
    const node = result.nodes.find((value: any) => value.id === 'task-1');
    expect(node.status).toBe('done');
    expect(JSON.parse(node.result).summary).toContain('file.ts:10 checked');
    expect(JSON.parse(node.result).evidence).toEqual(
      typeof fields.evidence === 'string' ? [fields.evidence] : fields.evidence,
    );
    const verify = f.run.mock.calls[2][0];
    const verifyTool = factory
      .create({ sessionKey: verify.sessionKey, assertInvocationCurrent: vi.fn() })
      .find((value: any) => value.name === 'swarm_workflow_verify');
    const verifyContext = {
      sessionKey: verify.sessionKey,
      runId: verify.idempotencyKey,
      toolCallId: 'verify-result',
    };
    for (const verdict of [
      { evidence: 'Checked result' },
      { passed: 'true', evidence: 'Checked result' },
    ]) {
      before({ toolName: verifyTool.name, params: verdict }, verifyContext);
      expect((await verifyTool.execute(verifyContext.toolCallId, verdict)).details.accepted).toBe(
        false,
      );
    }
    before({ toolName: verifyTool.name, params: {} }, verifyContext);
    expect(
      (
        await verifyTool.execute(verifyContext.toolCallId, {
          passed: false,
          evidence: 'Missing test',
        })
      ).details.accepted,
    ).toBe(true);
  },
);
it('continues a prematurely ended task in the same session with only submission tools after native settlement', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  await f.request('swarmWorkflow.start', {
    parentKey: f.parentKey,
    requestId: 'correction',
    goal: 'Inspect',
    mode: 'auto',
  });
  await vi.advanceTimersByTimeAsync(1600);
  f.wait.mockResolvedValueOnce({
    status: 'ok',
    endedAt: Date.now(),
    terminalReply: {
      disposition: 'visible',
      text: JSON.stringify({
        tasks: [
          {
            id: 'inspect',
            title: 'Inspect',
            task: 'Inspect code',
            access: 'read',
            deps: [],
            batch: null,
          },
        ],
      }),
    },
  });
  await vi.advanceTimersByTimeAsync(1600);
  const worker = f.run.mock.calls[1][0];
  const factory = f.toolFactories.find(value => value.contextVersion === 2);
  const tool = factory
    .create({ sessionKey: worker.sessionKey, assertInvocationCurrent: vi.fn() })
    .find((value: any) => value.name === 'swarm_workflow_complete');
  const context = {
    sessionKey: worker.sessionKey,
    runId: worker.idempotencyKey,
    toolCallId: 'completion',
  };
  const before = f.hooks.get('before_tool_call');
  before({ toolName: tool.name, params: {} }, context);
  const rejected = await tool.execute(context.toolCallId, { evidence: [] });
  expect(rejected.details.accepted).toBe(false);
  const event = {
    runId: context.runId,
    sessionKey: context.sessionKey,
    stopHookActive: false,
    messages: [
      { role: 'toolResult', toolName: tool.name, isError: true, content: rejected.content },
    ],
  };
  const finalize = f.hooks.get('before_agent_finalize');
  expect(await finalize(event, context)).toBeUndefined();
  expect((await f.hook({}, context)).toolsAllow).toEqual([
    'swarm_workflow_complete',
    'swarm_workflow_block',
  ]);
  for (const name of [
    'exec',
    'read',
    'write',
    'sessions_spawn',
    'skills_read',
    'skills_search',
    'progress_card',
  ])
    expect(before({ toolName: name }, context)).toMatchObject({ block: true });
  const list = ((await f.request('swarmWorkflow.list', { parentKeys: [f.parentKey] })) as any)
    .flows[0];
  expect(list.nodes.find((node: any) => node.id === 'task-1')).not.toHaveProperty(
    'submissionRepair',
  );
  expect(f.run).toHaveBeenCalledTimes(2);
  f.wait.mockResolvedValueOnce({
    status: 'ok',
    endedAt: Date.now(),
    terminalReply: { disposition: 'visible', text: 'Submitted.' },
  });
  await vi.advanceTimersByTimeAsync(1600);
  expect(f.run).toHaveBeenCalledTimes(3);
  const repair = f.run.mock.calls[2][0];
  expect(repair.sessionKey).toBe(context.sessionKey);
  expect(repair.idempotencyKey).not.toBe(context.runId);
  expect(repair.message).toContain(rejected.details.error);
  expect(repair.message).toContain('Do not repeat the task');
  const repairContext = { ...context, runId: repair.idempotencyKey };
  expect((await f.hook({}, repairContext)).toolsAllow).toEqual([
    'swarm_workflow_complete',
    'swarm_workflow_block',
  ]);
  expect(before({ toolName: 'exec' }, repairContext)).toMatchObject({ block: true });
  expect(
    before(
      { toolName: 'exec', toolKind: 'code_mode_exec', toolInputKind: 'javascript' },
      repairContext,
    ),
  ).toBeUndefined();
  expect(before({ toolName: 'wait', toolKind: 'code_mode_wait' }, repairContext)).toBeUndefined();
  for (const toolName of ['tool_search', 'tool_describe', 'tool_call']) {
    expect(before({ toolName }, repairContext)).toBeUndefined();
  }
  expect(before({ toolName: 'write' }, repairContext)).toMatchObject({ block: true });
  expect(
    before({ toolName: 'exec', params: { toolKind: 'code_mode_exec' } }, repairContext),
  ).toMatchObject({ block: true });
  expect(before({ toolName: 'wait' }, repairContext)).toMatchObject({ block: true });
  const repairTool = factory
    .create({ sessionKey: repair.sessionKey, assertInvocationCurrent: vi.fn() })
    .find((value: any) => value.name === 'swarm_workflow_complete');
  before({ toolName: repairTool.name, params: {} }, repairContext);
  expect(
    (
      await repairTool.execute(context.toolCallId, {
        summary: 'Inspection complete',
        evidence: ['file.ts:10'],
      })
    ).details.accepted,
  ).toBe(true);
  expect(await finalize({ ...event, runId: repair.idempotencyKey }, repairContext)).toBeUndefined();
  f.wait.mockResolvedValueOnce({
    status: 'ok',
    endedAt: Date.now(),
    terminalReply: { disposition: 'visible', text: 'Submitted.' },
  });
  await vi.advanceTimersByTimeAsync(1600);
  expect(f.run).toHaveBeenCalledTimes(4);
});

async function verificationFixture() {
  vi.useFakeTimers();
  const f = await fixture();
  await f.request('swarmWorkflow.start', {
    parentKey: f.parentKey,
    requestId: 'settled-verification',
    goal: 'Inspect',
    mode: 'auto',
  });
  await vi.advanceTimersByTimeAsync(1600);
  f.wait.mockResolvedValueOnce({
    status: 'ok',
    endedAt: Date.now(),
    terminalReply: {
      disposition: 'visible',
      text: JSON.stringify({
        tasks: [
          {
            id: 'inspect',
            title: 'Inspect',
            task: 'Inspect code',
            access: 'read',
            deps: [],
            batch: null,
          },
        ],
      }),
    },
  });
  await vi.advanceTimersByTimeAsync(1600);
  const worker = f.run.mock.calls[1][0];
  const factory = f.toolFactories.find(value => value.contextVersion === 2);
  const tool = factory
    .create({ sessionKey: worker.sessionKey, assertInvocationCurrent: vi.fn() })
    .find((value: any) => value.name === 'swarm_workflow_complete');
  const context = {
    sessionKey: worker.sessionKey,
    runId: worker.idempotencyKey,
    toolCallId: 'worker-complete',
  };
  f.hooks.get('before_tool_call')({ toolName: tool.name }, context);
  expect(
    (await tool.execute(context.toolCallId, { evidence: ['file inspected'] })).details.accepted,
  ).toBe(true);
  f.wait.mockResolvedValueOnce({
    status: 'ok',
    endedAt: Date.now(),
    terminalReply: { disposition: 'visible', text: 'Work submitted.' },
  });
  await vi.advanceTimersByTimeAsync(1600);
  return { f, worker, factory, verify: f.run.mock.calls[2][0] };
}
it('hands verified evidence to the tool-free delivery without result-reading instructions', async () => {
  const { f, factory, verify } = await verificationFixture();
  expect(verify.disableTools).toBe(false);
  expect(verify.message).toContain('swarm_workflow_results(nodeId, cursor)');
  const tool = factory
    .create({ sessionKey: verify.sessionKey, assertInvocationCurrent: vi.fn() })
    .find((value: any) => value.name === 'swarm_workflow_verify');
  const context = {
    sessionKey: verify.sessionKey,
    runId: verify.idempotencyKey,
    toolCallId: 'verify-delivery-evidence',
  };
  f.hooks.get('before_tool_call')({ toolName: tool.name }, context);
  const evidence = ['reports/checked-result.md: verified deliverable; external integration untested'];
  expect((await tool.execute(context.toolCallId, {
    passed: true,
    summary: 'Inspection complete with the stated limitation',
    evidence,
  })).details.accepted).toBe(true);
  f.wait.mockResolvedValueOnce({
    status: 'ok',
    endedAt: Date.now(),
    terminalReply: { disposition: 'visible', text: 'Verified.' },
  });
  await vi.advanceTimersByTimeAsync(1600);
  const delivery = f.run.mock.calls[3][0];
  const prompt = JSON.parse(delivery.message);
  expect(delivery.disableTools).toBe(true);
  expect(delivery.deliver).toBe(false);
  expect(delivery.extraSystemPrompt).toContain('This final-answer stage has no tools');
  expect(delivery.extraSystemPrompt).toContain('Return a visible final answer directly');
  expect(prompt.instruction).toBe(delivery.extraSystemPrompt);
  expect(prompt.inputs.find((input: any) => input.id === 'task-1')).toEqual({
    id: 'task-1',
    summaryPreview: 'file inspected',
    resultReference: { nodeId: 'task-1' },
  });
  expect(JSON.parse(prompt.inputs.find((input: any) => input.id === 'verify').result)).toMatchObject({
    passed: true,
    summary: 'Inspection complete with the stated limitation',
    evidence,
  });
  expect(delivery.message).not.toContain('swarm_workflow_results');
  expect(delivery.extraSystemPrompt).toContain('without inventing contents');
});
it('continues a blocked verifier through owned operator input and requires a fresh native submission', async () => {
  const { f, factory, verify, worker } = await verificationFixture();
  const oldContext = {
    sessionKey: verify.sessionKey,
    runId: verify.idempotencyKey,
    toolCallId: 'old-verdict',
  };
  const oldTool = factory
    .create({ sessionKey: verify.sessionKey, assertInvocationCurrent: vi.fn() })
    .find((tool: any) => tool.name === 'swarm_workflow_verify');
  f.hooks.get('before_tool_call')({ toolName: oldTool.name }, oldContext);
  await oldTool.execute(oldContext.toolCallId, {
    passed: false,
    evidence: ['Missing human decision'],
  });
  f.wait.mockResolvedValueOnce({ status: 'ok', endedAt: Date.now() });
  await vi.advanceTimersByTimeAsync(1600);
  const flow = ((await f.request('swarmWorkflow.list', { parentKeys: [f.parentKey] })) as any)
    .flows[0];
  const detail = (await f.request('swarmWorkflow.detail', {
    parentKeys: [f.parentKey],
    id: flow.id,
    nodeId: 'verify',
  })) as any;
  expect(detail).toMatchObject({
    revision: flow.revision,
    canContinue: true,
    canNote: true,
    canRetry: true,
  });
  const params = {
    parentKeys: [f.parentKey],
    id: flow.id,
    nodeId: 'verify',
    revision: detail.revision,
    intervention: {
      id: 'human-decision',
      action: 'continue',
      text: 'Use the supplied acceptance criteria and inspect again',
    },
  };
  await expect(
    f.request('swarmWorkflow.intervene', { ...params, parentKeys: ['agent:main:justdo:foreign'] }),
  ).rejects.toThrow('does not belong');
  await expect(
    f.request('swarmWorkflow.intervene', { ...params, revision: detail.revision - 1 }),
  ).rejects.toThrow('revision');
  f.parent.permissionMode = 'full';
  await expect(f.request('swarmWorkflow.intervene', params)).rejects.toThrow('permissions');
  f.parent.permissionMode = 'workspace';
  await f.request('swarmWorkflow.intervene', params);
  await f.request('swarmWorkflow.intervene', params);
  await vi.advanceTimersByTimeAsync(1600);
  const resumed = f.run.mock.calls[3][0];
  expect(resumed.sessionKey).toBe(verify.sessionKey);
  expect(resumed.idempotencyKey).not.toBe(verify.idempotencyKey);
  expect(resumed.message).toBe(params.intervention.text);
  expect(resumed.extraSystemPrompt).toContain('Prior submissions do not complete this new run');
  expect(resumed.extraSystemPrompt).toContain('swarm_workflow_verify');
  expect(resumed.extraSystemPrompt).toContain('read-only');
  const context = { ...oldContext, runId: resumed.idempotencyKey, toolCallId: 'new-verdict' };
  expect(f.hooks.get('before_tool_call')({ toolName: 'exec' }, context)).toBeUndefined();
  expect(f.hooks.get('before_tool_call')({ toolName: oldTool.name }, oldContext)).toMatchObject({
    block: true,
  });
  f.hooks.get('before_tool_call')({ toolName: oldTool.name }, context);
  expect(
    (
      await oldTool.execute(context.toolCallId, {
        passed: true,
        evidence: ['Criteria independently verified'],
      })
    ).details.accepted,
  ).toBe(true);
  f.wait.mockResolvedValueOnce({ status: 'ok', endedAt: Date.now() });
  await vi.advanceTimersByTimeAsync(1600);
  const updated = ((await f.request('swarmWorkflow.list', { parentKeys: [f.parentKey] })) as any)
    .flows[0];
  expect(updated.nodes.find((n: any) => n.kind === 'work')).toMatchObject({
    status: 'done',
    attempt: 1,
    sessionKey: worker.sessionKey,
  });
  expect(updated.nodes.find((n: any) => n.kind === 'verify')).toMatchObject({
    status: 'done',
    attempt: 2,
  });
  expect(updated.nodes.find((n: any) => n.kind === 'verify')).not.toHaveProperty('interventions');
  const history = (await f.request('swarmWorkflow.detail', {
    parentKeys: [f.parentKey],
    id: flow.id,
    nodeId: 'verify',
  })) as any;
  expect(history.interventions).toHaveLength(1);
});

it('repairs a missing verification submission after isolated finalization skips the finalize hook', async () => {
  const { f, worker, factory, verify } = await verificationFixture();
  const error =
    'Invalid arguments for tool "openclaw:swarm-workflow:swarm_workflow_verify": passed: must have required property passed';
  f.nodeMessages.push({
    role: 'toolResult',
    toolName: 'tool_call',
    isError: true,
    runId: verify.idempotencyKey,
    content: [{ type: 'text', text: error }],
  });
  f.wait.mockResolvedValueOnce({
    status: 'ok',
    endedAt: Date.now(),
    terminalReply: {
      disposition: 'visible',
      text: 'The submission failed. Please submit it later.',
    },
  });
  await vi.advanceTimersByTimeAsync(1600);
  expect(f.getSessionMessages).toHaveBeenCalledWith({ sessionKey: verify.sessionKey, limit: 64 });
  expect(f.run).toHaveBeenCalledTimes(4);
  const repair = f.run.mock.calls[3][0];
  expect(repair.sessionKey).toBe(verify.sessionKey);
  expect(repair.idempotencyKey).not.toBe(verify.idempotencyKey);
  expect(repair.message).toContain(JSON.stringify(error));
  expect(repair.message).toContain('Do not repeat the task');
  const context = {
    sessionKey: repair.sessionKey,
    runId: repair.idempotencyKey,
    toolCallId: 'verify-corrected',
  };
  expect((await f.hook({}, context)).toolsAllow).toEqual([
    'swarm_workflow_verify',
    'swarm_workflow_block',
  ]);
  expect(f.hooks.get('before_tool_call')({ toolName: 'exec' }, context)).toMatchObject({
    block: true,
  });
  const tool = factory
    .create({ sessionKey: repair.sessionKey, assertInvocationCurrent: vi.fn() })
    .find((value: any) => value.name === 'swarm_workflow_verify');
  f.hooks.get('before_tool_call')({ toolName: tool.name }, context);
  expect(
    (
      await tool.execute(context.toolCallId, {
        passed: true,
        evidence: ['Acceptance criteria checked'],
      })
    ).details.accepted,
  ).toBe(true);
  f.wait.mockResolvedValueOnce({
    status: 'ok',
    endedAt: Date.now(),
    terminalReply: { disposition: 'visible', text: 'Verified.' },
  });
  await vi.advanceTimersByTimeAsync(1600);
  const current = ((await f.request('swarmWorkflow.list', { parentKeys: [f.parentKey] })) as any)
    .flows[0];
  expect(current.nodes.find((node: any) => node.kind === 'work')).toMatchObject({
    sessionKey: worker.sessionKey,
    status: 'done',
    attempt: 1,
  });
  expect(current.nodes.find((node: any) => node.kind === 'verify')).toMatchObject({
    status: 'done',
    attempt: 1,
  });
  expect(f.run).toHaveBeenCalledTimes(5);
  expect(f.run.mock.calls[4][0].message).toContain('Produce the final user-facing answer');
});

it('refreshes the concrete submission error on the next correction without replaying the assigned task', async () => {
  const { f, verify } = await verificationFixture();
  f.nodeMessages.push({
    role: 'toolResult',
    toolName: 'swarm_workflow_verify',
    isError: true,
    runId: verify.idempotencyKey,
    content: 'passed is required',
  });
  f.wait.mockResolvedValueOnce({
    status: 'ok',
    endedAt: Date.now(),
    terminalReply: { disposition: 'visible', text: 'Submission rejected.' },
  });
  await vi.advanceTimersByTimeAsync(1600);
  const first = f.run.mock.calls[3][0];
  expect(first.message).toContain('passed is required');
  f.nodeMessages.push({
    role: 'toolResult',
    toolName: 'swarm_workflow_verify',
    isError: true,
    runId: first.idempotencyKey,
    content: 'evidence must contain non-empty strings',
  });
  f.wait.mockResolvedValueOnce({
    status: 'ok',
    endedAt: Date.now(),
    terminalReply: { disposition: 'visible', text: 'A different field was rejected.' },
  });
  await vi.advanceTimersByTimeAsync(1600);
  const second = f.run.mock.calls[4][0];
  expect(second.message).toContain('evidence must contain non-empty strings');
  expect(second.message).not.toContain('passed is required');
  expect(second.sessionKey).toBe(verify.sessionKey);
  expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  expect(f.getSessionMessages).toHaveBeenCalledTimes(2);
  expect(f.run).toHaveBeenCalledTimes(5);
});

it.each(['stop', 'permission-change'])(
  'does not admit a correction if %s happens during native history lookup',
  async action => {
    const { f, verify } = await verificationFixture();
    f.getSessionMessages.mockImplementationOnce(async () => {
      if (action === 'stop') {
        const current = (
          (await f.request('swarmWorkflow.list', { parentKeys: [f.parentKey] })) as any
        ).flows[0];
        await f.request('swarmWorkflow.control', {
          parentKeys: [f.parentKey],
          id: current.id,
          revision: current.revision,
          action: 'stop',
        });
      } else f.parent.permissionMode = 'read-only';
      return { messages: [] };
    });
    f.wait.mockResolvedValueOnce({
      status: 'ok',
      endedAt: Date.now(),
      terminalReply: { disposition: 'visible', text: 'No submission.' },
    });
    await vi.advanceTimersByTimeAsync(1600);
    const current = ((await f.request('swarmWorkflow.list', { parentKeys: [f.parentKey] })) as any)
      .flows[0];
    expect(current.status).toBe(action === 'stop' ? 'cancelled' : 'blocked');
    expect(current.nodes.find((node: any) => node.sessionKey === verify.sessionKey).status).toBe(
      action === 'stop' ? 'cancelled' : 'failed',
    );
    expect(
      current.nodes.find((node: any) => node.sessionKey === verify.sessionKey).endedAt,
    ).toBeGreaterThan(0);
    expect(f.run).toHaveBeenCalledTimes(3);
  },
);

it('does not request submission correction for stale, cancelled or policy-revoked runs', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const flow = (await f.request('swarmWorkflow.start', {
    parentKey: f.parentKey,
    requestId: 'correction-scope',
    goal: 'Inspect',
    mode: 'auto',
  })) as any;
  await vi.advanceTimersByTimeAsync(1600);
  f.wait.mockResolvedValueOnce({
    status: 'ok',
    endedAt: Date.now(),
    terminalReply: {
      disposition: 'visible',
      text: JSON.stringify({
        tasks: [
          {
            id: 'inspect',
            title: 'Inspect',
            task: 'Inspect code',
            access: 'read',
            deps: [],
            batch: null,
          },
        ],
      }),
    },
  });
  await vi.advanceTimersByTimeAsync(1600);
  const worker = f.run.mock.calls[1][0];
  const context = { sessionKey: worker.sessionKey, runId: worker.idempotencyKey };
  const event = { ...context, stopHookActive: false };
  const finalize = f.hooks.get('before_agent_finalize');
  expect(await finalize({ ...event, runId: 'foreign' }, context)).toBeUndefined();
  expect(await finalize({ ...event, sessionKey: 'foreign' }, context)).toBeUndefined();
  expect(await finalize(event, { ...context, runId: 'foreign' })).toBeUndefined();
  expect(await finalize({ ...event, stopHookActive: true }, context)).toBeUndefined();
  f.parent.permissionMode = 'full';
  expect(await finalize(event, context)).toBeUndefined();
  f.parent.permissionMode = 'workspace';
  const current = ((await f.request('swarmWorkflow.list', { parentKeys: [f.parentKey] })) as any)
    .flows[0];
  await f.request('swarmWorkflow.control', {
    parentKeys: [f.parentKey],
    id: flow.id,
    revision: current.revision,
    action: 'stop',
  });
  expect(await finalize(event, context)).toBeUndefined();
});

it('rejects cancelled, expired and revoked submission authority before mutating workflow state', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  await f.request('swarmWorkflow.start', {
    parentKey: f.parentKey,
    requestId: 'cancel-test',
    goal: 'Inspect',
    mode: 'auto',
  });
  await vi.advanceTimersByTimeAsync(1600);
  f.wait.mockResolvedValueOnce({
    status: 'ok',
    endedAt: Date.now(),
    terminalReply: {
      disposition: 'visible',
      text: JSON.stringify({
        tasks: [
          {
            id: 'inspect',
            title: 'Inspect',
            task: 'Inspect',
            deps: [],
            access: 'read',
            batch: null,
          },
        ],
      }),
    },
  });
  await vi.advanceTimersByTimeAsync(1600);
  const worker = f.run.mock.calls[1][0];
  const factory = f.toolFactories.find(factory => factory.contextVersion === 2);
  const guard = vi.fn();
  const tool = factory
    .create({ sessionKey: worker.sessionKey, assertInvocationCurrent: guard })
    .find((item: any) => item.name === 'swarm_workflow_complete');
  const before = f.hooks.get('before_tool_call');
  const context = {
    sessionKey: worker.sessionKey,
    runId: worker.idempotencyKey,
    toolCallId: 'call',
  };
  const fields = { summary: 'Result', evidence: ['file'] };
  const abort = new AbortController();
  before({ toolName: tool.name, params: {} }, { ...context, abortSignal: abort.signal });
  abort.abort();
  expect((await tool.execute('call', fields)).details.accepted).toBe(false);
  before({ toolName: tool.name, params: {} }, context);
  await vi.advanceTimersByTimeAsync(31000);
  expect((await tool.execute('call', fields)).details.accepted).toBe(false);
  before({ toolName: tool.name, params: {} }, context);
  guard.mockImplementationOnce(() => {
    throw new Error('revoked');
  });
  expect((await tool.execute('call', fields)).details.accepted).toBe(false);
  before({ toolName: tool.name, params: {} }, context);
  f.parent.permissionMode = 'read-only';
  expect((await tool.execute('call', fields)).details.accepted).toBe(false);
  const result = (await f.request('swarmWorkflow.list', { parentKeys: [f.parentKey] })) as any;
  expect(result.flows[0].nodes.find((node: any) => node.id === 'task-1').status).toBe('running');
  expect(f.run).toHaveBeenCalledTimes(2);
});
