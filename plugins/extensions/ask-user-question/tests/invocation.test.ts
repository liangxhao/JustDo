import { expect, test, vi } from 'vitest';

vi.mock('openclaw/plugin-sdk/session-store-runtime', () => ({
  getSessionEntry: vi.fn(),
}));

import plugin, { type AskUserInvocation,AskUserQuestionManager } from '../index';

const question = {
  id: 'choice',
  question: 'Which result?',
  options: [{ id: 'one', label: 'First' }],
};
const logger = { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() };
const invocation = (toolCallId: string, guard = () => {}): AskUserInvocation => ({
  source: {
    sessionKey: 'agent:main:subagent:worker',
    nativeSessionId: 'exact-child-incarnation',
    agentId: 'main',
    toolCallId,
    runId: 'native-run',
  },
  assertCurrent: guard,
});

test('parallel child invocations retain exact origins and resolve only their own frozen request', async () => {
  const manager = new AskUserQuestionManager(logger);
  manager.setGatewayEventEmitter(vi.fn());
  const first = manager.request([question], { mode: 'required' }, invocation('call-one'));
  const second = manager.request([question], { mode: 'required' }, invocation('call-two'));
  const [one, two] = manager.list();
  expect(one.source.toolCallId).toBe('call-one');
  expect(two.source.toolCallId).toBe('call-two');
  expect(() => manager.resolve(one.requestId, 'cancel', undefined, two.source)).toThrow(
    'source changed',
  );
  expect(manager.list()).toHaveLength(2);
  manager.resolve(one.requestId, 'cancel', undefined, one.source);
  await expect(first).resolves.toEqual({ status: 'cancelled' });
  expect(manager.list()).toEqual([two]);
  manager.resolve(two.requestId, 'submit', { choice: { selected: ['one'] } }, two.source);
  await expect(second).resolves.toMatchObject({ status: 'answered' });
});

test('aborting one tool call in the same Native incarnation cannot cancel or late-answer its sibling', async () => {
  const manager = new AskUserQuestionManager(logger);
  const events = vi.fn();
  manager.setGatewayEventEmitter(events);
  const abort = new AbortController();
  const first = manager.request([question], { mode: 'required' }, invocation('call-aborted'), abort.signal);
  const second = manager.request([question], { mode: 'required' }, invocation('call-survives'));
  const [one, two] = manager.list();
  abort.abort();
  await expect(first).resolves.toEqual({ status: 'cancelled' });
  expect(manager.list()).toEqual([two]);
  expect(() => manager.resolve(one.requestId, 'submit', { choice: { selected: ['one'] } }, one.source))
    .toThrow('no longer waiting');
  expect(manager.list()).toEqual([two]);
  manager.resolve(two.requestId, 'submit', { choice: { selected: ['one'] } }, two.source);
  await expect(second).resolves.toMatchObject({ status: 'answered' });
  expect(() => manager.resolve(two.requestId, 'cancel', undefined, two.source))
    .toThrow('no longer waiting');
  expect(events.mock.calls.filter(([name]) => name === 'resolved').map(([, payload]) => payload))
    .toEqual([
      { requestId: one.requestId, status: 'cancelled' },
      { requestId: two.requestId, status: 'answered' },
    ]);
});

test('retired Native invocation cannot accept an answer or later select timeout defaults', async () => {
  vi.useFakeTimers();
  try {
    let current = true;
    const manager = new AskUserQuestionManager(logger);
    manager.setGatewayEventEmitter(vi.fn());
    const pending = manager.request(
      [{ ...question, defaultOptionIds: ['one'] }],
      {
        mode: 'timeout',
        timeoutMinutes: 1,
        onTimeout: 'use-defaults',
      },
      invocation('call', () => {
        if (!current) throw new Error('retired');
      }),
    );
    const request = manager.list()[0];
    current = false;
    expect(() =>
      manager.resolve(
        request.requestId,
        'submit',
        { choice: { selected: ['one'] } },
        request.source,
      ),
    ).toThrow('retired');
    await expect(pending).resolves.toEqual({ status: 'cancelled' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(manager.list()).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

test('factory admits a real V2 child identity without using a key prefix as authority', () => {
  const tools = vi.fn();
  plugin.register({
    pluginConfig: {},
    logger,
    registerService: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerTool: tools,
    on: vi.fn(),
  } as never);
  const factory = tools.mock.calls[0][0];
  expect(factory.contextVersion).toBe(2);
  expect(
    factory.create({
      sessionKey: 'agent:main:subagent:worker',
      sessionId: 'native',
      assertInvocationCurrent: () => {},
    }),
  ).toMatchObject({ name: 'ask_user_question' });
  expect(
    factory.create({
      sessionKey: 'agent:main:justdo:source',
      sessionId: 'native',
    }),
  ).toBeNull();
  expect(() =>
    factory.create({
      sessionKey: 'agent:main:justdo:source',
      sessionId: 'native',
      assertInvocationCurrent: () => {
        throw new Error('not admitted');
      },
    }),
  ).toThrow('not admitted');
});
