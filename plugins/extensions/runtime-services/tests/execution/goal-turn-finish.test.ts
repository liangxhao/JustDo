import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { afterEach, expect, test, vi } from 'vitest';

import { registerGoalResultPolicy } from '../../execution/goal-result-policy';

type Middleware = Parameters<OpenClawPluginApi['registerAgentToolResultMiddleware']>[0];
type Result = Parameters<Middleware>[0]['result'];
type Factory = Extract<Parameters<OpenClawPluginApi['registerTool']>[0], { contextVersion: 2 }>;
type Context = Parameters<Factory['create']>[0];
const identity = { runtime: 'openclaw' as const, agentId: 'main', sessionKey: 'agent:main:finish-fixture', sessionId: 'session', runId: 'auto-run' };
const input = { goalId: 'goal', reply: 'none' };
const response = () => ({ session: { key: identity.sessionKey, sessionId: identity.sessionId, agentId: identity.agentId,
  lifecycleRevision: 'revision', goal: { id: input.goalId, status: 'complete' },
  goalContinuation: { lastAccepted: { runId: identity.runId, goalId: input.goalId, predecessorRunId: 'previous', continuationTurns: 1, acceptedAt: 2 } },
} });
afterEach(() => vi.useRealTimers());

function fixture() {
  let factory!: Factory;
  let middleware!: Middleware;
  let current = true;
  let invocationCurrent = true;
  const controller = new AbortController();
  const request = vi.fn().mockResolvedValue(response());
  const activeEntry = () => ({ sessionId: identity.sessionId, goal: { id: input.goalId, status: 'active' } });
  const getSessionEntry = vi.fn<() => ReturnType<typeof activeEntry> | undefined>().mockImplementation(activeEntry);
  const resolveStorePath = vi.fn((store: string | undefined) => store ?? '/controlled/default-store');
  const registerTool = vi.fn((value: Factory) => { factory = value; });
  const assertInvocationCurrent = vi.fn(() => { if (!invocationCurrent) throw new Error('Invocation retired'); });
  registerGoalResultPolicy({
    lifecycle: { signal: controller.signal, runInBackgroundContext: (run: () => unknown) => { if (!current) throw new Error('Registration retired'); return run(); } },
    runtime: { gateway: { request }, agent: { session: { getSessionEntry, resolveStorePath } } }, registerTool,
    registerAgentToolResultMiddleware: (handler: Middleware) => { middleware = handler; },
  } as unknown as OpenClawPluginApi);
  const create = (overrides: Partial<Context> = {}) => factory.create({ ...identity, assertInvocationCurrent, ...overrides });
  const tool = (overrides: Partial<Context> = {}) => {
    const value = create(overrides);
    if (!value || Array.isArray(value)) throw new Error('Expected one finish tool');
    return value;
  };
  const produce = async (args: Record<string, unknown> = input, overrides?: Partial<Context>) => ({
    toolName: 'finish_goal_turn', toolCallId: 'finish', args, result: await tool(overrides).execute('finish', args),
  });
  return { request, controller, registerTool, create, tool, produce, assertInvocationCurrent, getSessionEntry, resolveStorePath, activeEntry,
    retire: () => { current = false; },
    retireInvocation: () => { invocationCurrent = false; },
    run: (event: Parameters<Middleware>[0], context: Parameters<Middleware>[1] = identity) => middleware(event, context),
  };
}

function wrapper(inner: Result) {
  const tool = { id: 'openclaw:runtime-services:finish_goal_turn', source: 'openclaw', sourceName: 'runtime-services',
    name: 'finish_goal_turn', label: 'Finish Goal turn', description: 'Finish an automatic bookkeeping turn', input: '{goalId:string,reply:"none"}' };
  const model = { tool: { id: tool.id, name: tool.name, source: tool.source }, result: inner };
  return { toolName: 'tool_call', toolCallId: 'outer', args: { id: tool.id, args: input },
    result: { content: [{ type: 'text' as const, text: JSON.stringify(model) }], details: { tool, result: inner } } };
}

test('registers an explicit finish request whose factory cannot claim completion or terminate by itself', async () => {
  const f = fixture();
  expect(f.registerTool).toHaveBeenCalledWith(expect.objectContaining({ contextVersion: 2 }), { name: 'finish_goal_turn' });
  expect(f.tool().parameters).toMatchObject({ additionalProperties: false, required: ['goalId', 'reply'] });
  const event = await f.produce();
  expect(event.result).not.toHaveProperty('terminate');
  expect(event.result.details).toMatchObject({ status: 'unconfirmed', goalId: 'goal', reply: 'none', invocation: {
    agentId: identity.agentId, sessionKey: identity.sessionKey, sessionId: identity.sessionId,
  } });
  expect(f.assertInvocationCurrent).toHaveBeenCalled();
  expect(f.request).not.toHaveBeenCalled();
});

test.each(['missing-goal', 'complete', 'paused', 'blocked', 'budget_limited', 'empty-goal-id', 'wrong-session', 'read-failed', 'unknown-identity', 'unknown-authority'])(
  'hides the finish tool from fresh model discovery when public session metadata is %s', change => {
    const f = fixture();
    let overrides: Partial<Context> = {};
    const entry = f.activeEntry();
    if (change === 'missing-goal') f.getSessionEntry.mockReturnValue({ sessionId: identity.sessionId } as typeof entry);
    else if (['complete', 'paused', 'blocked', 'budget_limited'].includes(change)) f.getSessionEntry.mockReturnValue({ ...entry, goal: { ...entry.goal, status: change } });
    else if (change === 'empty-goal-id') f.getSessionEntry.mockReturnValue({ ...entry, goal: { ...entry.goal, id: '' } });
    else if (change === 'wrong-session') f.getSessionEntry.mockReturnValue({ ...entry, sessionId: 'successor' });
    else if (change === 'read-failed') f.getSessionEntry.mockImplementation(() => { throw new Error('Read unavailable'); });
    else if (change === 'unknown-identity') overrides = { sessionId: undefined };
    else overrides = { assertInvocationCurrent: undefined };
    expect(f.create(overrides)).toBeNull();
    expect(f.request).not.toHaveBeenCalled();
  },
);

test('reads the configured store with exact factory identity and latest public metadata', () => {
  const f = fixture();
  expect(f.create({ runtimeConfig: { session: { store: '/controlled/runtime-store' } }, config: { session: { store: '/controlled/fallback-store' } } })).not.toBeNull();
  expect(f.resolveStorePath).toHaveBeenLastCalledWith('/controlled/runtime-store', { agentId: identity.agentId });
  expect(f.getSessionEntry).toHaveBeenLastCalledWith({ agentId: identity.agentId, sessionKey: identity.sessionKey,
    storePath: '/controlled/runtime-store', readConsistency: 'latest' });
  expect(f.create({ config: { session: { store: '/controlled/config-store' } } })).not.toBeNull();
  expect(f.resolveStorePath).toHaveBeenLastCalledWith('/controlled/config-store', { agentId: identity.agentId });
});

test.each(['registration', 'invocation'])('hides a factory retired during the %s metadata read', owner => {
  const f = fixture();
  f.getSessionEntry.mockImplementationOnce(() => {
    if (owner === 'registration') f.retire();
    else f.retireInvocation();
    return f.activeEntry();
  });
  expect(f.create()).toBeNull();
  expect(f.getSessionEntry).toHaveBeenCalledOnce();
});

test('a tool admitted while the Goal is active remains callable after completion in the same attempt', async () => {
  const f = fixture();
  const admitted = f.tool();
  f.getSessionEntry.mockReturnValue({ ...f.activeEntry(), goal: { id: input.goalId, status: 'complete' } });
  const event = { toolName: admitted.name, toolCallId: 'finish-after-update', args: input,
    result: await admitted.execute('finish-after-update', input) };
  expect((await f.run(event))?.result.terminate).toBe(true);
  expect(f.getSessionEntry).toHaveBeenCalledOnce();
  expect(f.create()).toBeNull();
});

test.each(['direct', 'tool_call'])('authorizes only the explicit %s request after exact automatic completion proof', async kind => {
  const f = fixture();
  const direct = await f.produce();
  const event = kind === 'direct' ? direct : wrapper(direct.result);
  const before = structuredClone(event);
  const output = await f.run(event);
  expect(output?.result.terminate).toBe(true);
  const result = kind === 'direct' ? output!.result : (output!.result.details as { result: Result }).result;
  expect(result.terminate).toBe(true);
  expect(result.details).toMatchObject({ status: 'finished', goalId: 'goal', reply: 'none' });
  expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(result.details);
  if (kind === 'tool_call') {
    const model = JSON.parse((output!.result.content[0] as { text: string }).text);
    expect(model.result).toEqual(result);
    expect((output!.result.details as { tool: unknown }).tool).toEqual((event.result.details as { tool: unknown }).tool);
  }
  expect(event).toEqual(before);
  expect(f.request).toHaveBeenCalledExactlyOnceWith('sessions.describe', { key: identity.sessionKey, agentId: identity.agentId }, { scopes: ['operator.read'], timeoutMs: 1500 });
});

test.each(['manual', 'unknown-run', 'wrong-goal', 'incomplete', 'missing-receipt', 'reset', 'wrong-key', 'wrong-agent', 'missing-revision'])(
  'keeps the explicit request unconfirmed without termination for %s proof', async change => {
    const f = fixture();
    const event = await f.produce();
    const before = structuredClone(event);
    const read = response();
    let context: Parameters<Middleware>[1] = identity;
    if (change === 'manual') context = { ...identity, runId: 'manual-run' };
    else if (change === 'unknown-run') context = { ...identity, runId: undefined };
    else if (change === 'wrong-goal') read.session.goal.id = 'other';
    else if (change === 'incomplete') read.session.goal.status = 'active';
    else if (change === 'missing-receipt') read.session.goalContinuation = {} as never;
    else if (change === 'reset') read.session.sessionId = 'successor';
    else if (change === 'wrong-key') read.session.key = 'different';
    else if (change === 'wrong-agent') read.session.agentId = 'other';
    else read.session.lifecycleRevision = '';
    f.request.mockResolvedValue(read);
    expect(await f.run(event, context)).toBeUndefined();
    expect(event).toEqual(before);
    expect(event.result.details).toMatchObject({ status: 'unconfirmed', nextAction: expect.stringContaining('not confirmed') });
    expect(event.result).not.toHaveProperty('terminate');
  },
);

test.each(['bad-reply', 'empty-goal', 'oversized-goal', 'extra-args', 'stale-factory', 'stale-invocation', 'aborted-invocation'])(
  'rejects %s at the tool factory without creating a terminal candidate', async change => {
    const f = fixture();
    const admitted = f.tool();
    let args: Record<string, unknown> = input;
    if (change === 'bad-reply') args = { ...input, reply: 'answer' };
    else if (change === 'empty-goal') args = { ...input, goalId: '' };
    else if (change === 'oversized-goal') args = { ...input, goalId: 'g'.repeat(257) };
    else if (change === 'extra-args') args = { ...input, runId: identity.runId };
    else if (change === 'stale-invocation') f.retireInvocation();
    else if (change === 'aborted-invocation') f.controller.abort();
    else f.retire();
    const event = { toolName: admitted.name, toolCallId: 'retained-finish', args, result: await admitted.execute('retained-finish', args) };
    expect(event.result.details).toMatchObject({ status: 'unavailable' });
    expect(event.result).not.toHaveProperty('terminate');
    expect(await f.run(event)).toBeUndefined();
    expect(f.request).not.toHaveBeenCalled();
  },
);

test.each(['foreign-owner', 'foreign-source', 'mismatched-copy', 'guest', 'factory-mismatch', 'failed-tool'])(
  'does not authorize %s finish output', async change => {
    const f = fixture();
    const event = wrapper((await f.produce(input, change === 'factory-mismatch' ? { sessionKey: 'other' } : {})).result);
    if (change === 'foreign-owner') event.result.details.tool.sourceName = 'other';
    else if (change === 'foreign-source') event.result.details.tool.source = 'mcp';
    else if (change === 'mismatched-copy') event.result.content[0].text = '{}';
    else if (change === 'guest') event.toolName = 'exec';
    else if (change === 'failed-tool') Object.assign(event, { isError: true });
    expect(await f.run(event)).toBeUndefined();
    expect(f.request).not.toHaveBeenCalled();
  },
);

test('a failed, stalled or retired native read cannot turn an explicit request into a silent finish', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const event = await f.produce();
  f.request.mockRejectedValueOnce(new Error('Read failed'));
  expect(await f.run(event)).toBeUndefined();
  f.request.mockImplementationOnce(() => new Promise(() => {}));
  const pending = f.run(event);
  await vi.advanceTimersByTimeAsync(1500);
  expect(await pending).toBeUndefined();
  f.request.mockImplementationOnce(async () => { f.retire(); return response(); });
  expect(await f.run(event)).toBeUndefined();
  expect(event.result).not.toHaveProperty('terminate');
  expect(vi.getTimerCount()).toBe(0);
});
