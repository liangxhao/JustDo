import { AsyncLocalStorage } from 'node:async_hooks';

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { afterEach, expect, test, vi } from 'vitest';

import { registerGoalResultPolicy } from '../../execution/goal-result-policy';

type Middleware = Parameters<OpenClawPluginApi['registerAgentToolResultMiddleware']>[0];
type ToolResult = Parameters<Middleware>[0]['result'];
afterEach(() => vi.useRealTimers());
const context = { runtime: 'openclaw' as const, agentId: 'main', sessionKey: 'agent:main:goal-fixture', sessionId: 'native-session', runId: 'automatic-run' };
const goal = { id: 'goal', status: 'complete', note: 'The requested result was delivered.', objective: 'Prepare a result', continuationTurns: 1 };
const originalInstruction = 'Continue this turn and provide the requested visible final response.';
const payload = () => ({ status: 'updated', goal: { ...goal }, nextAction: originalInstruction });
const jsonResult = (details: Record<string, unknown>): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(details, null, 2) }], details });
const response = () => ({ session: {
  key: context.sessionKey, sessionId: context.sessionId, agentId: context.agentId, lifecycleRevision: 'revision', goal: { ...goal },
  goalContinuation: { lastAccepted: { runId: context.runId, goalId: goal.id, predecessorRunId: 'predecessor', continuationTurns: 1, acceptedAt: 3 } },
} });
const direct = () => ({ toolCallId: 'call', toolName: 'update_goal', args: { status: 'complete', note: goal.note }, result: jsonResult(payload()) });
function nested() {
  const inner = jsonResult(payload());
  const tool = { id: 'openclaw:core:update_goal', source: 'openclaw', sourceName: 'core', name: 'update_goal', label: 'Update Goal', description: 'Native tool', input: '{ status: string }' };
  return {
    toolCallId: 'outer-call', toolName: 'tool_call', args: { id: tool.id, args: { status: 'complete', note: goal.note } },
    result: {
      ...jsonResult({ tool: { id: tool.id, name: tool.name, source: tool.source }, result: inner }),
      details: { tool, result: inner },
    },
  };
}

function fixture() {
  const ambient = new AsyncLocalStorage<string>();
  const controller = new AbortController();
  let current = true;
  let read = response();
  let middleware!: Middleware;
  const request = vi.fn(async () => {
    expect(ambient.getStore()).toBe('registration-gateway');
    return read;
  });
  const register = vi.fn((handler: Middleware) => { middleware = handler; });
  const registerTool = vi.fn();
  ambient.run('registration', () => registerGoalResultPolicy({
    lifecycle: {
      signal: controller.signal,
      runInBackgroundContext: <T>(run: () => T) => {
        if (!current) throw new Error('Registration quiesced');
        return ambient.run('registration-gateway', run);
      },
    },
    runtime: { gateway: { request } }, registerAgentToolResultMiddleware: register, registerTool,
  } as unknown as OpenClawPluginApi));
  return {
    request, register, registerTool, controller,
    setResponse: (value: ReturnType<typeof response>) => { read = value; },
    quiesce: () => { current = false; },
    run: (event = direct(), ctx: Parameters<Middleware>[1] = context) => ambient.run('unrelated-gateway', () => middleware(event, ctx)),
  };
}

test('registers a narrowly scoped native result policy without a global admission hook', () => {
  expect(fixture().register).toHaveBeenCalledWith(expect.any(Function), {
    runtimes: ['openclaw'], matcher: ['update_goal', 'finish_goal_turn', 'tool_call'],
  });
});

test('changes only nextAction after an exact native automatic completion and preserves the original result', async () => {
  const f = fixture();
  const event = direct();
  event.result = { ...event.result, terminate: true } as ToolResult;
  const before = structuredClone(event);
  const result = await f.run(event);
  const details = result?.result.details as ReturnType<typeof payload>;
  expect(details.nextAction).toContain('finish_goal_turn');
  expect(details.nextAction).toContain('separate tool_call');
  expect(details.nextAction).toContain('If a requested result has not been delivered');
  expect(details).toEqual({ ...payload(), nextAction: expect.any(String) });
  expect(result?.result).toEqual({ ...event.result, details, content: [{ type: 'text', text: JSON.stringify(details, null, 2) }] });
  expect(result?.result).toHaveProperty('terminate', true);
  expect(f.request).toHaveBeenCalledExactlyOnceWith('sessions.describe', { key: context.sessionKey, agentId: context.agentId }, { scopes: ['operator.read'], timeoutMs: 1500 });
  expect(event).toEqual(before);
});

test('a successful update alone never authorizes termination before the model chooses whether another answer is owed', async () => {
  const output = await fixture().run();
  expect(output?.result).not.toHaveProperty('terminate');
  expect(output?.result.details).toMatchObject({ status: 'updated', goal });
});

test('updates both native Tool Search envelope copies while preserving all catalog and Goal fields', async () => {
  const f = fixture();
  const event = nested();
  const before = structuredClone(event);
  const output = await f.run(event as unknown as ReturnType<typeof direct>);
  const details = output?.result.details as typeof event.result.details;
  const model = JSON.parse((output!.result.content[0] as { text: string }).text);
  const inner = details.result.details as ReturnType<typeof payload>;
  expect(inner.nextAction).toContain('finish_goal_turn');
  expect(details.tool).toEqual(event.result.details.tool);
  expect(inner).toEqual({ ...payload(), nextAction: expect.any(String) });
  expect(JSON.parse((details.result.content[0] as { text: string }).text)).toEqual(inner);
  expect(model).toEqual({ tool: { id: details.tool.id, name: details.tool.name, source: details.tool.source }, result: details.result });
  expect(event).toEqual(before);
});

test.each(['blocked', 'error', 'failed-tool', 'wrong-args', 'mismatched-content'])(
  'leaves %s results untouched without reading session state', async change => {
    const f = fixture();
    const event = direct();
    if (change === 'blocked') event.result = jsonResult({ ...payload(), goal: { ...goal, status: 'blocked' } });
    else if (change === 'error') event.result = jsonResult({ status: 'error', error: 'Goal changed', nextAction: originalInstruction });
    else if (change === 'failed-tool') Object.assign(event, { isError: true });
    else if (change === 'wrong-args') event.args.status = 'blocked';
    else event.result.content = [{ type: 'text', text: JSON.stringify({ ...payload(), goal: { ...goal, id: 'different' } }) }];
    const before = structuredClone(event);
    expect(await f.run(event)).toBeUndefined();
    expect(f.request).not.toHaveBeenCalled();
    expect(event).toEqual(before);
  },
);

test.each(['missing-receipt', 'other-run', 'other-goal', 'reset', 'wrong-agent', 'missing-revision', 'inactive-goal'])(
  'does not change the completion result when native observation reports %s', async change => {
    const f = fixture();
    const value = response();
    if (change === 'missing-receipt') value.session.goalContinuation = {} as never;
    else if (change === 'other-run') value.session.goalContinuation.lastAccepted.runId = 'old-run';
    else if (change === 'other-goal') value.session.goalContinuation.lastAccepted.goalId = 'different';
    else if (change === 'reset') value.session.sessionId = 'successor';
    else if (change === 'wrong-agent') value.session.agentId = 'other';
    else if (change === 'missing-revision') value.session.lifecycleRevision = '';
    else value.session.goal.status = 'active';
    f.setResponse(value);
    expect(await f.run()).toBeUndefined();
  },
);

test.each(['foreign-tool', 'foreign-source', 'missing-owner', 'mismatched-envelope', 'arbitrary-guest'])(
  'preserves %s wrappers without inspecting arbitrary nested output', async change => {
    const f = fixture();
    const event = nested();
    if (change === 'foreign-tool') event.result.details.tool.id = 'openclaw:other:update_goal';
    else if (change === 'foreign-source') event.result.details.tool.source = 'mcp';
    else if (change === 'missing-owner') delete (event.result.details.tool as Partial<typeof event.result.details.tool>).sourceName;
    else if (change === 'mismatched-envelope') event.result.content = [{ type: 'text', text: JSON.stringify({ tool: event.result.details.tool, result: jsonResult({ ...payload(), goal: { ...goal, id: 'other' } }) }) }];
    else event.toolName = 'exec';
    const before = structuredClone(event);
    expect(await f.run(event as unknown as ReturnType<typeof direct>)).toBeUndefined();
    expect(f.request).not.toHaveBeenCalled();
    expect(event).toEqual(before);
  },
);

test('uses no instructions when the read fails or the original registration retires during the read', async () => {
  const f = fixture();
  f.request.mockRejectedValueOnce(new Error('Read unavailable'));
  expect(await f.run()).toBeUndefined();
  f.request.mockImplementationOnce(async () => { f.quiesce(); return response(); });
  expect(await f.run()).toBeUndefined();
  expect(f.controller.signal.aborted).toBe(false);
  expect(await f.run()).toBeUndefined();
  expect(f.request).toHaveBeenCalledTimes(2);
});

test('leaves an executed result untouched when a read stalls and ignores the eventual late reply', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const event = direct();
  const before = structuredClone(event);
  let reply!: (value: ReturnType<typeof response>) => void;
  f.request.mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }));
  const pending = f.run(event);
  await vi.advanceTimersByTimeAsync(1500);
  expect(await pending).toBeUndefined();
  reply(response());
  await Promise.resolve();
  expect(event).toEqual(before);
  expect(vi.getTimerCount()).toBe(0);
});

test('keeps unrelated runtimes, missing run identities and aborted registrations unchanged', async () => {
  const f = fixture();
  expect(await f.run(direct(), { ...context, runtime: 'codex' })).toBeUndefined();
  expect(await f.run(direct(), { ...context, runId: undefined })).toBeUndefined();
  f.controller.abort();
  expect(await f.run()).toBeUndefined();
  expect(f.request).not.toHaveBeenCalled();
});

test.each(['oversized', 'multibyte', 'deep', 'cyclic', 'invalid-json', 'growth-over-limit'])(
  'passes through %s native envelopes rather than expanding or rejecting an executed result', async change => {
    const f = fixture();
    const event = direct();
    if (change === 'invalid-json') event.result.content = [{ type: 'text', text: '{' }];
    else if (change === 'cyclic') (event.result.details as Record<string, unknown>).cycle = event.result.details;
    else {
      let extra: unknown = change === 'multibyte' ? '字'.repeat(30_000) : 'x'.repeat(change === 'growth-over-limit' ? 65_000 : 70_000);
      if (change === 'deep') { extra = {}; for (let depth = 0; depth < 13; depth++) extra = { child: extra }; }
      event.result = jsonResult({ ...payload(), extra });
    }
    expect(await f.run(event)).toBeUndefined();
    expect(f.request).not.toHaveBeenCalled();
  },
);
