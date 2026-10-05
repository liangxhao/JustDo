import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { buildSync } from 'esbuild';
import { afterEach, expect, it, vi } from 'vitest';

import { buildSwarmInstruction } from '../../../src/shared/cowork/swarm';
const requireNative = createRequire(import.meta.url);
const code = buildSync({
  entryPoints: [path.resolve('openclaw-extensions/swarm-flow/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  external: ['openclaw/plugin-sdk/*'],
}).outputFiles[0].text;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0)) await action();
  vi.useRealTimers();
});
async function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flow-plugin-'));
  const parentKey = 'agent:main:justdo:parent';
  const parent = { sessionId: 'native-parent', sessionRoot: root, permissionMode: 'workspace' };
  const methods = new Map<string, any>();
  const messages: Array<Record<string, unknown>> = [];
  const nodeMessages: Array<Record<string, unknown>> = [];
  const getSessionMessages = vi.fn(async (_params: any) => ({ messages: nodeMessages }));
  const agents = [{ id: 'main', name: 'Main' }];
  const config = { plugins: { entries: { 'swarm-flow': { config: { availableAgentIds: ['main'] } } } } };
  let tool: any;
  const toolFactories: any[] = [];
  const wait = vi.fn(async (_params: any): Promise<any> => ({ status: 'pending' }));
  const hooks = new Map<string, any>();
  let service: any;
  const moduleBox = { exports: {} as any };
  vm.runInNewContext(code, {
    module: moduleBox,
    exports: moduleBox.exports,
    setTimeout,
    clearTimeout,
    Date,
    process,
    require: (name: string) =>
      name === 'openclaw/plugin-sdk/session-store-runtime'
        ? {
            getSessionEntry: ({ sessionKey }: any) =>
              sessionKey === parentKey ? parent : undefined,
          }
        : requireNative(name),
  });
  const request = vi.fn(async (method: string, params: any) => {
    if (method === 'agents.list') return { agents };
    if (method === 'chat.history') return { messages };
    if (methods.has(method))
      return new Promise((resolve, reject) =>
        methods.get(method)({
          params,
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
    runtime: {
      config: { current: () => config },
      gateway: { request },
      subagent: { run, waitForRun: wait, getSessionMessages },
    },
    registerService: (s: any) => {
      service = s;
    },
    registerGatewayMethod: (name: string, fn: any) => methods.set(name, fn),
    registerTool: (factory: any) => { toolFactories.push(factory); if (typeof factory === 'function') tool = factory({ sessionKey: parentKey }); },
    on: (name: string, fn: any) => hooks.set(name, fn),
  };
  moduleBox.exports.default.register(api);
  await service.start({ stateDir: root, logger: { error: vi.fn() } });
  cleanup.push(async () => {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  });
  const registerAgent = () => {
    const agentHooks = new Map<string, any>();
    const agentTools: any[] = [];
    let agentService: any;
    moduleBox.exports.default.register({
      ...api,
      registerGatewayMethod: vi.fn(),
      registerService: (value: any) => { agentService = value; },
      registerTool: (value: any) => agentTools.push(value),
      on: (name: string, fn: any) => agentHooks.set(name, fn),
    });
    return { hooks: agentHooks, tools: agentTools, service: agentService };
  };
  return { root, parent, parentKey, request, run, messages, nodeMessages, getSessionMessages, agents, config, tool, toolFactories, hooks, wait, hook: hooks.get('before_prompt_build'), service, registerAgent };
}
it.each(['full', 'workspace', 'guarded', 'read-only'])('inherits explicit %s permissions and the project for inspection and verification stages', async mode => {
  vi.useFakeTimers();
  const f = await fixture();
  f.parent.permissionMode = mode;
  await f.request('swarmFlow.start', { parentKey: f.parentKey, requestId: 'permission-' + mode, goal: 'Inspect', mode: 'auto' });
  await vi.advanceTimersByTimeAsync(1600);
  f.wait.mockResolvedValueOnce({ status: 'ok', endedAt: Date.now(), terminalReply: { disposition: 'visible', text: JSON.stringify({ tasks: [{ id: 'inspect', title: 'Inspect', task: 'Inspect code without modifications', access: 'read', deps: [] }] }) } });
  await vi.advanceTimersByTimeAsync(1600);
  const worker = f.run.mock.calls[1][0];
  expect(JSON.parse(worker.message)).toMatchObject({ access: 'read', accessInstruction: expect.stringContaining('Do not modify source files') });
  const factory = f.toolFactories.find(value => value.contextVersion === 2);
  const tool = factory.create({ sessionKey: worker.sessionKey, assertInvocationCurrent: vi.fn() }).find((value: any) => value.name === 'swarm_flow_complete');
  f.hooks.get('before_tool_call')({ toolName: tool.name, params: {} }, { sessionKey: worker.sessionKey, runId: worker.idempotencyKey, toolCallId: 'done' });
  expect((await tool.execute('done', { summary: 'Inspected', evidence: ['source.ts:1'] })).details.accepted).toBe(true);
  f.wait.mockResolvedValueOnce({ status: 'ok', endedAt: Date.now(), terminalReply: { disposition: 'visible', text: 'Checked.' } });
  await vi.advanceTimersByTimeAsync(1600);
  const creates = f.request.mock.calls.filter(([method]) => method === 'sessions.create').map(([, params]) => params);
  expect(creates).toHaveLength(3);
  for (const params of creates) expect(params).toMatchObject({ permissionMode: mode, cwd: f.root });
  expect(creates[2].key).toMatch(/-verify$/);
});
it.each(['native', 'product'])('rechecks %s agent availability before dispatch and blocks instead of replacing its identity', async source => {
  vi.useFakeTimers();
  const f = await fixture();
  await f.request('swarmFlow.start', { parentKey: f.parentKey, requestId: 'once', goal: 'Inspect', mode: 'auto' });
  if (source === 'native') f.agents.splice(0);
  else f.config.plugins.entries['swarm-flow'].config.availableAgentIds.splice(0);
  await vi.advanceTimersByTimeAsync(1600);
  const result = await f.request('swarmFlow.list', { parentKeys: [f.parentKey] }) as any;
  expect(result.flows[0].status).toBe('blocked');
  expect(result.flows[0].nodes[0].error).toContain('no longer available');
  expect(f.run).not.toHaveBeenCalled();
});
it('resolves only the exact current admitted message for the embedded runtime', async () => {
  const f = await fixture();
  const content = 'Inspect\n\n' + buildSwarmInstruction({ mode: 'auto', verify: true });
  f.messages.push({ role: 'user', content, idempotencyKey: 'old:user' });
  const event = { prompt: content, messages: [] };
  const context = { sessionKey: f.parentKey, runId: 'current', inputProvenance: { kind: 'external_user' } };
  expect((await f.hook(event, context)).prependSystemContext).toContain('could not be confirmed');
  expect((await f.request('swarmFlow.list', { parentKeys: [f.parentKey] }) as any).flows).toHaveLength(0);
  f.messages.push({ role: 'user', content, idempotencyKey: 'current:user' });
  expect((await f.hook(event, context)).toolsAllow).toEqual(['swarm_flow_start']);
  await f.tool.execute('call-1', { goal: 'Inspect', mode: 'auto', sourceRequestId: 'current:user' });
  await f.tool.execute('call-2', { goal: 'Inspect', mode: 'auto', sourceRequestId: 'current:user' });
  await f.tool.execute('call-3', { goal: 'Inspect', mode: 'auto' });
  expect((await f.request('swarmFlow.list', { parentKeys: [f.parentKey] }) as any).flows).toHaveLength(1);
});
it('intersects the native roster with live product admission before creating or dispatching work', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  f.agents.push({ id: 'reviewer', name: 'Reviewer' }, { id: 'deleted', name: 'Deleted' });
  f.config.plugins.entries['swarm-flow'].config.availableAgentIds.push('reviewer');
  await f.request('swarmFlow.start', { parentKey: f.parentKey, requestId: 'roster', goal: 'Inspect', mode: 'auto' });
  await vi.advanceTimersByTimeAsync(1600);
  const prompt = JSON.parse(f.run.mock.calls[0][0].message);
  expect(prompt.availableAgents.map((agent: any) => agent.id)).toEqual(['main', 'reviewer']);
  f.config.plugins.entries['swarm-flow'].config.availableAgentIds.splice(0);
  await expect(f.request('swarmFlow.start', { parentKey: f.parentKey, requestId: 'new', goal: 'New task', mode: 'auto' })).rejects.toThrow('main agent is unavailable');
});
it('requests a self-contained brief in the parent conversation before admitting a durable flow', async () => {
  const f = await fixture();
  const text = 'Inspect project\n\n' + buildSwarmInstruction({ mode: 'auto', verify: true });
  const context = { sessionKey: f.parentKey, inputProvenance: { kind: 'external_user' } };
  const event = {
    prompt: text,
    currentUserMessage: text,
    currentUserMessageId: 'admitted-user-1',
    messages: [],
  };
  const instruction = await f.hook(event, context);
  expect(instruction.toolsAllow).toEqual(['swarm_flow_start']);
  expect(instruction.prependSystemContext).toContain('current attachments');
  expect(instruction.prependSystemContext).toContain('self-contained goal');
  await f.hook(event, context);
  expect((await f.request('swarmFlow.list', { parentKeys: [f.parentKey] }) as any).flows).toHaveLength(0);
  f.messages.push({ role: 'user', content: text, idempotencyKey: 'admitted-user-1' });
  await f.tool.execute('call-1', { goal: 'Inspect project', mode: 'auto', sourceRequestId: 'admitted-user-1' });
  const listed = (await f.request('swarmFlow.list', { parentKeys: [f.parentKey] })) as any;
  expect(listed.flows).toHaveLength(1);
  expect(listed.flows[0].nodes[0].kind).toBe('plan');
  expect(
    await f.hook({ ...event, currentUserMessage: 'Normal follow-up' }, context),
  ).toBeUndefined();
  expect(
    await f.hook(event, { ...context, inputProvenance: { kind: 'inter_session' } }),
  ).toBeUndefined();
  expect(f.request.mock.calls.some(([method]) => method.startsWith('workboard'))).toBe(false);
});
it('preserves resolved prior context and image details in the task brief, without copying native history', async () => {
  const f = await fixture();
  const text = 'Implement the above design from this image\n\n' + buildSwarmInstruction({ mode: 'auto', verify: true });
  f.messages.push({ role: 'assistant', content: 'Build a settings page with two columns.' }, {
    role: 'user', idempotencyKey: 'image:user', content: [{ type: 'image', data: 'native-only' }, { type: 'text', text }],
  });
  const result = await f.hook({ prompt: text, messages: f.messages }, { sessionKey: f.parentKey, runId: 'image' });
  expect(result.toolsAllow).toEqual(['swarm_flow_start']);
  const goal = 'Build the agreed two-column settings page. The supplied image has a blue sidebar and a white content area.';
  await f.tool.execute('call-1', { goal, mode: 'auto', sourceRequestId: 'image:user' });
  const flows = (await f.request('swarmFlow.list', { parentKeys: [f.parentKey] }) as any).flows;
  expect(flows[0].goal).toBe(goal);
  expect(JSON.stringify(flows)).not.toContain('native-only');
  f.messages.push({ role: 'user', content: 'New request', idempotencyKey: 'later:user' });
  await expect(f.tool.execute('stale', { goal, mode: 'auto', sourceRequestId: 'image:user' })).rejects.toThrow('no longer current');
});
it('does not start tasks when stable admission identity or parent permissions are unavailable', async () => {
  const f = await fixture();
  const text = 'Inspect\n\n' + buildSwarmInstruction({ mode: 'review', verify: true });
  const result = await f.hook({ currentUserMessage: text }, { sessionKey: f.parentKey });
  expect(result.prependSystemContext).toContain('could not be confirmed');
  const list = (await f.request('swarmFlow.list', { parentKeys: [f.parentKey] })) as any;
  expect(list.flows).toHaveLength(0);
  f.parent.permissionMode = 'unknown';
  await expect(
    f.request('swarmFlow.start', {
      parentKey: f.parentKey,
      requestId: 'a',
      goal: 'goal',
      mode: 'auto',
    }),
  ).rejects.toThrow();
});
it('rejects control through a different parent and preserves flow state on service reload', async () => {
  const f = await fixture();
  const started = (await f.request('swarmFlow.start', {
    parentKey: f.parentKey,
    requestId: 'once',
    goal: 'goal',
    mode: 'auto',
  })) as any;
  await expect(
    f.request('swarmFlow.control', {
      parentKeys: ['agent:main:justdo:other'],
      id: started.id,
      revision: started.revision,
      action: 'stop',
    }),
  ).rejects.toThrow();
  await f.service.stop();
  await f.service.start({ stateDir: f.root, logger: { error: vi.fn() } });
  const list = (await f.request('swarmFlow.list', { parentKeys: [f.parentKey] })) as any;
  expect(list.flows[0].id).toBe(started.id);
});

it('authorizes detail by parent and preserves the exact dispatch outside list polling', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  await f.request('swarmFlow.start', { parentKey: f.parentKey, requestId: 'detail', goal: 'Inspect', mode: 'auto' });
  const list = await f.request('swarmFlow.list', { parentKeys: [f.parentKey] }) as any;
  const params = { parentKeys: [f.parentKey], id: list.flows[0].id, nodeId: 'plan' };
  expect(await f.request('swarmFlow.detail', params)).toMatchObject({ submission: 'not_sent' });
  await expect(f.request('swarmFlow.detail', { ...params, parentKeys: ['agent:main:justdo:foreign'] })).rejects.toThrow();
  await expect(f.request('swarmFlow.detail', { ...params, sourceId: 'not-a-dependency' })).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(1600);
  const detail = await f.request('swarmFlow.detail', params) as any;
  expect(detail.submission).toBe('submitted');
  expect(detail.dispatch.message).toBe(f.run.mock.calls[0][0].message);
  const refreshed = await f.request('swarmFlow.list', { parentKeys: [f.parentKey] }) as any;
  expect(refreshed.flows[0].nodes[0]).not.toHaveProperty('dispatch');
});

it('scopes submission tools to native worker runs and allows correcting rejected fields before a durable handoff', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const factory = f.toolFactories.find(factory => factory.contextVersion === 2);
  expect(factory.create({ sessionKey: f.parentKey })).toBeNull();
  expect(factory.create({ sessionKey: 'agent:main:subagent:swarm-flow-forged-task-1' })).toBeNull();
  await f.request('swarmFlow.start', { parentKey: f.parentKey, requestId: 'receipt-test', goal: 'Inspect', mode: 'auto' });
  await vi.advanceTimersByTimeAsync(1600);
  f.wait.mockResolvedValueOnce({ status: 'ok', endedAt: Date.now(), terminalReply: { disposition: 'visible', text: JSON.stringify({ tasks: [{ id: 'inspect', title: 'Inspect', task: 'Inspect code', access: 'read', deps: [] }] }) } });
  await vi.advanceTimersByTimeAsync(1600);
  const worker = f.run.mock.calls[1][0];
  const guard = vi.fn();
  const tool = factory.create({ sessionKey: worker.sessionKey, assertInvocationCurrent: guard }).find((tool: any) => tool.name === 'swarm_flow_complete');
  const context = { sessionKey: worker.sessionKey, runId: worker.idempotencyKey, toolCallId: 'submit-1' };
  const before = f.hooks.get('before_tool_call');
  expect(before({ toolName: tool.name, params: {} }, { ...context, runId: 'stale' })).toMatchObject({ block: true });
  expect((await tool.execute(context.toolCallId, { summary: 'Fake', evidence: ['file'] })).details.accepted).toBe(false);
  before({ toolName: tool.name, params: {} }, context);
  expect((await tool.execute(context.toolCallId, { summary: 'Result', evidence: ['file'], nodeId: 'foreign' })).details.accepted).toBe(false);
  before({ toolName: tool.name, params: {} }, context);
  expect((await tool.execute(context.toolCallId, { summary: 'Result', evidence: [] })).details.accepted).toBe(false);
  before({ toolName: tool.name, params: {} }, context);
  expect((await tool.execute(context.toolCallId, { summary: 'Result', evidence: ['file.ts:10'] })).details.accepted).toBe(true);
  expect(guard).toHaveBeenCalled();
  expect(f.run).toHaveBeenCalledTimes(2);
  f.wait.mockResolvedValueOnce({ status: 'ok', endedAt: Date.now(), terminalReply: { disposition: 'visible', text: '我已完成核对。' } });
  await vi.advanceTimersByTimeAsync(1600);
  const result = await f.request('swarmFlow.list', { parentKeys: [f.parentKey] }) as any;
  expect(result.flows[0].nodes.find((node: any) => node.id === 'task-1').status).toBe('done');
  expect(f.run).toHaveBeenCalledTimes(3);
  const verify = f.run.mock.calls[2][0];
  const verifyTool = factory.create({ sessionKey: verify.sessionKey, assertInvocationCurrent: guard }).find((tool: any) => tool.name === 'swarm_flow_verify');
  const verifyContext = { sessionKey: verify.sessionKey, runId: verify.idempotencyKey, toolCallId: 'verify-1' };
  before({ toolName: verifyTool.name, params: {} }, verifyContext);
  expect((await verifyTool.execute('verify-1', { passed: true, summary: 'Checked', evidence: ['test passed'] })).details.accepted).toBe(true);
  f.wait.mockResolvedValueOnce({ status: 'ok', endedAt: Date.now(), terminalReply: { disposition: 'visible', text: '自然语言验收说明，无需 JSON。' } });
  await vi.advanceTimersByTimeAsync(1600);
  expect(f.run).toHaveBeenCalledTimes(4);
});
it('shares the active Gateway service with separately registered specialist tools without transferring lifecycle ownership', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  f.agents.push({ id: 'reviewer', name: 'Reviewer' });
  f.config.plugins.entries['swarm-flow'].config.availableAgentIds.push('reviewer');
  const goal = 'Use reviewer to inspect code.';
  await f.request('swarmFlow.start', { parentKey: f.parentKey, requestId: 'specialist', goal, mode: 'auto' });
  await vi.advanceTimersByTimeAsync(1600);
  f.wait.mockResolvedValueOnce({ status: 'ok', endedAt: Date.now(), terminalReply: { disposition: 'visible', text: JSON.stringify({ tasks: [{ id: 'inspect', title: 'Inspect', task: 'Inspect code', access: 'read', deps: [], agentId: 'reviewer', agentRequest: goal }] }) } });
  await vi.advanceTimersByTimeAsync(1600);
  const worker = f.run.mock.calls[1][0];
  expect(worker.sessionKey).toMatch(/^agent:reviewer:/);
  const registry = f.registerAgent();
  await registry.service.stop();
  expect(await f.request('swarmFlow.health', {})).toMatchObject({ ready: true });
  const guard = vi.fn();
  const tool = registry.tools.find(value => value.contextVersion === 2).create({ sessionKey: worker.sessionKey, assertInvocationCurrent: guard }).find((value: any) => value.name === 'swarm_flow_complete');
  const context = { sessionKey: worker.sessionKey, runId: worker.idempotencyKey, toolCallId: 'specialist-result' };
  expect(registry.hooks.get('before_tool_call')({ toolName: tool.name, params: {} }, context)).toBeUndefined();
  expect((await tool.execute(context.toolCallId, { summary: 'Inspected', evidence: ['source.ts:1'] })).details.accepted).toBe(true);
  expect(guard).toHaveBeenCalled();
  f.wait.mockResolvedValueOnce({ status: 'ok', endedAt: Date.now(), terminalReply: { disposition: 'visible', text: 'Inspection complete.' } });
  await vi.advanceTimersByTimeAsync(1600);
  const result = await f.request('swarmFlow.list', { parentKeys: [f.parentKey] }) as any;
  expect(result.flows[0].nodes.find((node: any) => node.id === 'task-1').status).toBe('done');
});
it.each([{ evidence: 'file.ts:10 checked; no source modifications.' }, { evidence: ['file.ts:10 checked', 'No source modifications.'] }])('accepts explicit evidence-only submissions and persists canonical receipts: %j', async fields => {
  vi.useFakeTimers();
  const f = await fixture();
  await f.request('swarmFlow.start', { parentKey: f.parentKey, requestId: 'evidence-only', goal: 'Inspect', mode: 'auto' });
  await vi.advanceTimersByTimeAsync(1600);
  f.wait.mockResolvedValueOnce({ status: 'ok', endedAt: Date.now(), terminalReply: { disposition: 'visible', text: JSON.stringify({ tasks: [{ id: 'inspect', title: 'Inspect', task: 'Inspect code', access: 'read', deps: [] }] }) } });
  await vi.advanceTimersByTimeAsync(1600);
  const worker = f.run.mock.calls[1][0];
  const factory = f.toolFactories.find(value => value.contextVersion === 2);
  const tool = factory.create({ sessionKey: worker.sessionKey, assertInvocationCurrent: vi.fn() }).find((value: any) => value.name === 'swarm_flow_complete');
  const context = { sessionKey: worker.sessionKey, runId: worker.idempotencyKey, toolCallId: 'evidence-result' };
  const before = f.hooks.get('before_tool_call');
  before({ toolName: tool.name, params: fields }, context);
  expect((await tool.execute(context.toolCallId, fields)).details.accepted).toBe(true);
  const revision = (await f.request('swarmFlow.list', { parentKeys: [f.parentKey] }) as any).flows[0].revision;
  before({ toolName: tool.name, params: fields }, context);
  expect((await tool.execute(context.toolCallId, fields)).details.accepted).toBe(true);
  expect((await f.request('swarmFlow.list', { parentKeys: [f.parentKey] }) as any).flows[0].revision).toBe(revision);
  f.wait.mockResolvedValueOnce({ status: 'ok', endedAt: Date.now(), terminalReply: { disposition: 'visible', text: 'Natural-language report.' } });
  await vi.advanceTimersByTimeAsync(1600);
  const result = (await f.request('swarmFlow.list', { parentKeys: [f.parentKey] }) as any).flows[0];
  const node = result.nodes.find((value: any) => value.id === 'task-1');
  expect(node.status).toBe('done');
  expect(JSON.parse(node.result).summary).toContain('file.ts:10 checked');
  expect(JSON.parse(node.result).evidence).toEqual(typeof fields.evidence === 'string' ? [fields.evidence] : fields.evidence);
  const verify = f.run.mock.calls[2][0];
  const verifyTool = factory.create({ sessionKey: verify.sessionKey, assertInvocationCurrent: vi.fn() }).find((value: any) => value.name === 'swarm_flow_verify');
  const verifyContext = { sessionKey: verify.sessionKey, runId: verify.idempotencyKey, toolCallId: 'verify-result' };
  for (const verdict of [{ evidence: 'Checked result' }, { passed: 'true', evidence: 'Checked result' }]) {
    before({ toolName: verifyTool.name, params: verdict }, verifyContext);
    expect((await verifyTool.execute(verifyContext.toolCallId, verdict)).details.accepted).toBe(false);
  }
  before({ toolName: verifyTool.name, params: {} }, verifyContext);
  expect((await verifyTool.execute(verifyContext.toolCallId, { passed: false, evidence: 'Missing test' })).details.accepted).toBe(true);
});
it('continues a prematurely ended task in the same session with only submission tools after native settlement', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  await f.request('swarmFlow.start', { parentKey: f.parentKey, requestId: 'correction', goal: 'Inspect', mode: 'auto' });
  await vi.advanceTimersByTimeAsync(1600);
  f.wait.mockResolvedValueOnce({ status: 'ok', endedAt: Date.now(), terminalReply: { disposition: 'visible', text: JSON.stringify({ tasks: [{ id: 'inspect', title: 'Inspect', task: 'Inspect code', access: 'read', deps: [] }] }) } });
  await vi.advanceTimersByTimeAsync(1600);
  const worker = f.run.mock.calls[1][0];
  const factory = f.toolFactories.find(value => value.contextVersion === 2);
  const tool = factory.create({ sessionKey: worker.sessionKey, assertInvocationCurrent: vi.fn() }).find((value: any) => value.name === 'swarm_flow_complete');
  const context = { sessionKey: worker.sessionKey, runId: worker.idempotencyKey, toolCallId: 'completion' };
  const before = f.hooks.get('before_tool_call');
  before({ toolName: tool.name, params: {} }, context);
  const rejected = await tool.execute(context.toolCallId, { evidence: [] });
  expect(rejected.details.accepted).toBe(false);
  const event = { runId: context.runId, sessionKey: context.sessionKey, stopHookActive: false, messages: [{ role: 'toolResult', toolName: tool.name, isError: true, content: rejected.content }] };
  const finalize = f.hooks.get('before_agent_finalize');
  expect(finalize(event, context)).toBeUndefined();
  expect((await f.hook({}, context)).toolsAllow).toEqual(['swarm_flow_complete', 'swarm_flow_block']);
  for (const name of ['exec', 'read', 'write', 'sessions_spawn']) expect(before({ toolName: name }, context)).toMatchObject({ block: true });
  const list = (await f.request('swarmFlow.list', { parentKeys: [f.parentKey] }) as any).flows[0];
  expect(list.nodes.find((node: any) => node.id === 'task-1')).not.toHaveProperty('submissionRepair');
  expect(f.run).toHaveBeenCalledTimes(2);
  f.wait.mockResolvedValueOnce({ status: 'ok', endedAt: Date.now(), terminalReply: { disposition: 'visible', text: 'Submitted.' } });
  await vi.advanceTimersByTimeAsync(1600);
  expect(f.run).toHaveBeenCalledTimes(3);
  const repair = f.run.mock.calls[2][0];
  expect(repair.sessionKey).toBe(context.sessionKey);
  expect(repair.idempotencyKey).not.toBe(context.runId);
  expect(repair.message).toContain(rejected.details.error);
  expect(repair.message).toContain('Do not repeat the task');
  const repairContext = { ...context, runId: repair.idempotencyKey };
  expect((await f.hook({}, repairContext)).toolsAllow).toEqual(['swarm_flow_complete', 'swarm_flow_block']);
  expect(before({ toolName: 'exec' }, repairContext)).toMatchObject({ block: true });
  const repairTool = factory.create({ sessionKey: repair.sessionKey, assertInvocationCurrent: vi.fn() }).find((value: any) => value.name === 'swarm_flow_complete');
  before({ toolName: repairTool.name, params: {} }, repairContext);
  expect((await repairTool.execute(context.toolCallId, { summary: 'Inspection complete', evidence: ['file.ts:10'] })).details.accepted).toBe(true);
  expect(finalize({ ...event, runId: repair.idempotencyKey }, repairContext)).toBeUndefined();
  f.wait.mockResolvedValueOnce({ status: 'ok', endedAt: Date.now(), terminalReply: { disposition: 'visible', text: 'Submitted.' } });
  await vi.advanceTimersByTimeAsync(1600);
  expect(f.run).toHaveBeenCalledTimes(4);
});

async function verificationFixture() {
  vi.useFakeTimers();
  const f = await fixture();
  await f.request('swarmFlow.start', { parentKey: f.parentKey, requestId: 'settled-verification', goal: 'Inspect', mode: 'auto' });
  await vi.advanceTimersByTimeAsync(1600);
  f.wait.mockResolvedValueOnce({ status: 'ok', endedAt: Date.now(), terminalReply: { disposition: 'visible', text: JSON.stringify({ tasks: [{ id: 'inspect', title: 'Inspect', task: 'Inspect code', access: 'read', deps: [] }] }) } });
  await vi.advanceTimersByTimeAsync(1600);
  const worker = f.run.mock.calls[1][0];
  const factory = f.toolFactories.find(value => value.contextVersion === 2);
  const tool = factory.create({ sessionKey: worker.sessionKey, assertInvocationCurrent: vi.fn() }).find((value: any) => value.name === 'swarm_flow_complete');
  const context = { sessionKey: worker.sessionKey, runId: worker.idempotencyKey, toolCallId: 'worker-complete' };
  f.hooks.get('before_tool_call')({ toolName: tool.name }, context);
  expect((await tool.execute(context.toolCallId, { evidence: ['file inspected'] })).details.accepted).toBe(true);
  f.wait.mockResolvedValueOnce({ status: 'ok', endedAt: Date.now(), terminalReply: { disposition: 'visible', text: 'Work submitted.' } });
  await vi.advanceTimersByTimeAsync(1600);
  return { f, worker, factory, verify: f.run.mock.calls[2][0] };
}
it('continues a blocked verifier through owned operator input and requires a fresh native submission', async () => {
  const { f, factory, verify, worker } = await verificationFixture();
  const oldContext = { sessionKey: verify.sessionKey, runId: verify.idempotencyKey, toolCallId: 'old-verdict' };
  const oldTool = factory.create({ sessionKey: verify.sessionKey, assertInvocationCurrent: vi.fn() }).find((tool: any) => tool.name === 'swarm_flow_verify');
  f.hooks.get('before_tool_call')({ toolName: oldTool.name }, oldContext);
  await oldTool.execute(oldContext.toolCallId, { passed: false, evidence: ['Missing human decision'] });
  f.wait.mockResolvedValueOnce({ status: 'ok', endedAt: Date.now() });
  await vi.advanceTimersByTimeAsync(1600);
  const flow = (await f.request('swarmFlow.list', { parentKeys: [f.parentKey] }) as any).flows[0];
  const detail = await f.request('swarmFlow.detail', { parentKeys: [f.parentKey], id: flow.id, nodeId: 'verify' }) as any;
  expect(detail).toMatchObject({ revision: flow.revision, canContinue: true, canNote: true, canRetry: true });
  const params = { parentKeys: [f.parentKey], id: flow.id, nodeId: 'verify', revision: detail.revision,
    intervention: { id: 'human-decision', action: 'continue', text: 'Use the supplied acceptance criteria and inspect again' } };
  await expect(f.request('swarmFlow.intervene', { ...params, parentKeys: ['agent:main:justdo:foreign'] })).rejects.toThrow('does not belong');
  await expect(f.request('swarmFlow.intervene', { ...params, revision: detail.revision - 1 })).rejects.toThrow('revision');
  f.parent.permissionMode = 'full';
  await expect(f.request('swarmFlow.intervene', params)).rejects.toThrow('permissions');
  f.parent.permissionMode = 'workspace';
  await f.request('swarmFlow.intervene', params);
  await f.request('swarmFlow.intervene', params);
  await vi.advanceTimersByTimeAsync(1600);
  const resumed = f.run.mock.calls[3][0];
  expect(resumed.sessionKey).toBe(verify.sessionKey);
  expect(resumed.idempotencyKey).not.toBe(verify.idempotencyKey);
  expect(JSON.parse(resumed.message).humanInput[0].text).toContain('acceptance criteria');
  const context = { ...oldContext, runId: resumed.idempotencyKey, toolCallId: 'new-verdict' };
  expect(f.hooks.get('before_tool_call')({ toolName: 'exec' }, context)).toBeUndefined();
  expect(f.hooks.get('before_tool_call')({ toolName: oldTool.name }, oldContext)).toMatchObject({ block: true });
  f.hooks.get('before_tool_call')({ toolName: oldTool.name }, context);
  expect((await oldTool.execute(context.toolCallId, { passed: true, evidence: ['Criteria independently verified'] })).details.accepted).toBe(true);
  f.wait.mockResolvedValueOnce({ status: 'ok', endedAt: Date.now() });
  await vi.advanceTimersByTimeAsync(1600);
  const updated = (await f.request('swarmFlow.list', { parentKeys: [f.parentKey] }) as any).flows[0];
  expect(updated.nodes.find((n: any) => n.kind === 'work')).toMatchObject({ status: 'done', attempt: 1, sessionKey: worker.sessionKey });
  expect(updated.nodes.find((n: any) => n.kind === 'verify')).toMatchObject({ status: 'done', attempt: 2 });
  expect(updated.nodes.find((n: any) => n.kind === 'verify')).not.toHaveProperty('interventions');
  const history = await f.request('swarmFlow.detail', { parentKeys: [f.parentKey], id: flow.id, nodeId: 'verify' }) as any;
  expect(history.interventions).toHaveLength(1);
});

it('repairs a missing verification submission after isolated finalization skips the finalize hook', async () => {
  const { f, worker, factory, verify } = await verificationFixture();
  const error = 'Invalid arguments for tool "openclaw:swarm-flow:swarm_flow_verify": passed: must have required property passed';
  f.nodeMessages.push({ role: 'toolResult', toolName: 'tool_call', isError: true, runId: verify.idempotencyKey, content: [{ type: 'text', text: error }] });
  f.wait.mockResolvedValueOnce({ status: 'ok', endedAt: Date.now(), terminalReply: { disposition: 'visible', text: 'The submission failed. Please submit it later.' } });
  await vi.advanceTimersByTimeAsync(1600);
  expect(f.getSessionMessages).toHaveBeenCalledWith({ sessionKey: verify.sessionKey, limit: 64 });
  expect(f.run).toHaveBeenCalledTimes(4);
  const repair = f.run.mock.calls[3][0];
  expect(repair.sessionKey).toBe(verify.sessionKey);
  expect(repair.idempotencyKey).not.toBe(verify.idempotencyKey);
  expect(repair.message).toContain(JSON.stringify(error));
  expect(repair.message).toContain('Do not repeat the task');
  const context = { sessionKey: repair.sessionKey, runId: repair.idempotencyKey, toolCallId: 'verify-corrected' };
  expect((await f.hook({}, context)).toolsAllow).toEqual(['swarm_flow_verify', 'swarm_flow_block']);
  expect(f.hooks.get('before_tool_call')({ toolName: 'exec' }, context)).toMatchObject({ block: true });
  const tool = factory.create({ sessionKey: repair.sessionKey, assertInvocationCurrent: vi.fn() }).find((value: any) => value.name === 'swarm_flow_verify');
  f.hooks.get('before_tool_call')({ toolName: tool.name }, context);
  expect((await tool.execute(context.toolCallId, { passed: true, evidence: ['Acceptance criteria checked'] })).details.accepted).toBe(true);
  f.wait.mockResolvedValueOnce({ status: 'ok', endedAt: Date.now(), terminalReply: { disposition: 'visible', text: 'Verified.' } });
  await vi.advanceTimersByTimeAsync(1600);
  const current = (await f.request('swarmFlow.list', { parentKeys: [f.parentKey] }) as any).flows[0];
  expect(current.nodes.find((node: any) => node.kind === 'work')).toMatchObject({ sessionKey: worker.sessionKey, status: 'done', attempt: 1 });
  expect(current.nodes.find((node: any) => node.kind === 'verify')).toMatchObject({ status: 'done', attempt: 1 });
  expect(f.run).toHaveBeenCalledTimes(5);
  expect(f.run.mock.calls[4][0].message).toContain('Produce the final user-facing answer');
});

it('refreshes the concrete submission error on the next correction without replaying the assigned task', async () => {
  const { f, verify } = await verificationFixture();
  f.nodeMessages.push({ role: 'toolResult', toolName: 'swarm_flow_verify', isError: true, runId: verify.idempotencyKey, content: 'passed is required' });
  f.wait.mockResolvedValueOnce({ status: 'ok', endedAt: Date.now(), terminalReply: { disposition: 'visible', text: 'Submission rejected.' } });
  await vi.advanceTimersByTimeAsync(1600);
  const first = f.run.mock.calls[3][0];
  expect(first.message).toContain('passed is required');
  f.nodeMessages.push({ role: 'toolResult', toolName: 'swarm_flow_verify', isError: true, runId: first.idempotencyKey, content: 'evidence must contain non-empty strings' });
  f.wait.mockResolvedValueOnce({ status: 'ok', endedAt: Date.now(), terminalReply: { disposition: 'visible', text: 'A different field was rejected.' } });
  await vi.advanceTimersByTimeAsync(1600);
  const second = f.run.mock.calls[4][0];
  expect(second.message).toContain('evidence must contain non-empty strings');
  expect(second.message).not.toContain('passed is required');
  expect(second.sessionKey).toBe(verify.sessionKey);
  expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  expect(f.getSessionMessages).toHaveBeenCalledTimes(2);
  expect(f.run).toHaveBeenCalledTimes(5);
});

it.each(['stop', 'permission-change'])('does not admit a correction if %s happens during native history lookup', async action => {
  const { f, verify } = await verificationFixture();
  f.getSessionMessages.mockImplementationOnce(async () => {
    if (action === 'stop') {
      const current = (await f.request('swarmFlow.list', { parentKeys: [f.parentKey] }) as any).flows[0];
      await f.request('swarmFlow.control', { parentKeys: [f.parentKey], id: current.id, revision: current.revision, action: 'stop' });
    } else f.parent.permissionMode = 'read-only';
    return { messages: [] };
  });
  f.wait.mockResolvedValueOnce({ status: 'ok', endedAt: Date.now(), terminalReply: { disposition: 'visible', text: 'No submission.' } });
  await vi.advanceTimersByTimeAsync(1600);
  const current = (await f.request('swarmFlow.list', { parentKeys: [f.parentKey] }) as any).flows[0];
  expect(current.status).toBe(action === 'stop' ? 'cancelled' : 'blocked');
  expect(current.nodes.find((node: any) => node.sessionKey === verify.sessionKey).status).toBe(action === 'stop' ? 'cancelled' : 'failed');
  expect(current.nodes.find((node: any) => node.sessionKey === verify.sessionKey).endedAt).toBeGreaterThan(0);
  expect(f.run).toHaveBeenCalledTimes(3);
});

it('does not request submission correction for stale, cancelled or policy-revoked runs', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const flow = await f.request('swarmFlow.start', { parentKey: f.parentKey, requestId: 'correction-scope', goal: 'Inspect', mode: 'auto' }) as any;
  await vi.advanceTimersByTimeAsync(1600);
  f.wait.mockResolvedValueOnce({ status: 'ok', endedAt: Date.now(), terminalReply: { disposition: 'visible', text: JSON.stringify({ tasks: [{ id: 'inspect', title: 'Inspect', task: 'Inspect code', access: 'read', deps: [] }] }) } });
  await vi.advanceTimersByTimeAsync(1600);
  const worker = f.run.mock.calls[1][0];
  const context = { sessionKey: worker.sessionKey, runId: worker.idempotencyKey };
  const event = { ...context, stopHookActive: false };
  const finalize = f.hooks.get('before_agent_finalize');
  expect(finalize({ ...event, runId: 'foreign' }, context)).toBeUndefined();
  expect(finalize({ ...event, sessionKey: 'foreign' }, context)).toBeUndefined();
  expect(finalize(event, { ...context, runId: 'foreign' })).toBeUndefined();
  expect(finalize({ ...event, stopHookActive: true }, context)).toBeUndefined();
  f.parent.permissionMode = 'full';
  expect(finalize(event, context)).toBeUndefined();
  f.parent.permissionMode = 'workspace';
  const current = (await f.request('swarmFlow.list', { parentKeys: [f.parentKey] }) as any).flows[0];
  await f.request('swarmFlow.control', { parentKeys: [f.parentKey], id: flow.id, revision: current.revision, action: 'stop' });
  expect(finalize(event, context)).toBeUndefined();
});

it('rejects cancelled, expired and revoked submission authority before mutating workflow state', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  await f.request('swarmFlow.start', { parentKey: f.parentKey, requestId: 'cancel-test', goal: 'Inspect', mode: 'auto' });
  await vi.advanceTimersByTimeAsync(1600);
  f.wait.mockResolvedValueOnce({ status: 'ok', endedAt: Date.now(), terminalReply: { disposition: 'visible', text: JSON.stringify({ tasks: [{ id: 'inspect', title: 'Inspect', task: 'Inspect', deps: [], access: 'read' }] }) } });
  await vi.advanceTimersByTimeAsync(1600);
  const worker = f.run.mock.calls[1][0];
  const factory = f.toolFactories.find(factory => factory.contextVersion === 2);
  const guard = vi.fn();
  const tool = factory.create({ sessionKey: worker.sessionKey, assertInvocationCurrent: guard }).find((item: any) => item.name === 'swarm_flow_complete');
  const before = f.hooks.get('before_tool_call');
  const context = { sessionKey: worker.sessionKey, runId: worker.idempotencyKey, toolCallId: 'call' };
  const fields = { summary: 'Result', evidence: ['file'] };
  const abort = new AbortController();
  before({ toolName: tool.name, params: {} }, { ...context, abortSignal: abort.signal }); abort.abort();
  expect((await tool.execute('call', fields)).details.accepted).toBe(false);
  before({ toolName: tool.name, params: {} }, context); await vi.advanceTimersByTimeAsync(31000);
  expect((await tool.execute('call', fields)).details.accepted).toBe(false);
  before({ toolName: tool.name, params: {} }, context); guard.mockImplementationOnce(() => { throw new Error('revoked'); });
  expect((await tool.execute('call', fields)).details.accepted).toBe(false);
  before({ toolName: tool.name, params: {} }, context); f.parent.permissionMode = 'read-only';
  expect((await tool.execute('call', fields)).details.accepted).toBe(false);
  const result = await f.request('swarmFlow.list', { parentKeys: [f.parentKey] }) as any;
  expect(result.flows[0].nodes.find((node: any) => node.id === 'task-1').status).toBe('running');
  expect(f.run).toHaveBeenCalledTimes(2);
});
