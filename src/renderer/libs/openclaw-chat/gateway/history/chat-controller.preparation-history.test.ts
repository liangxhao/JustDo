import { afterEach, expect, test, vi } from 'vitest';

import { ChatController } from '../chat-controller';
import { sendQueuedInput } from '../input/chat-queued-input';
import { HISTORY_PREPARATION_TIMEOUT_MS } from './history-preparation';

const sessionKey = 'agent:main:justdo:preparing-history';
const messages = [{ role: 'assistant', content: 'Previously saved history', timestamp: 1 }];
const snapshot = { sessionId: 'native-history', messages };
const pending = (code = 'agent-database-inspection-pending', agentId = 'main') => Object.assign(
  new Error('Native preparation refusal'),
  { gatewayCode: 'UNAVAILABLE', retryable: code === 'agent-database-inspection-pending', details: { code, agentId } },
);

function fixture(read: () => Promise<unknown>, options: ConstructorParameters<typeof ChatController>[0] = {}) {
  vi.useFakeTimers();
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const request = vi.fn((method: string) => method === 'chat.history' ? read() : Promise.resolve({}));
  const controller = new ChatController({ initialHistoryRetryDelaysMs: [], ...options });
  const client = { request, stop: vi.fn(), generation: 1 };
  controller.state.client = client as never;
  controller.state.connected = true;
  controller.state.sessionKey = sessionKey;
  return { controller, client, request, error };
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

test('waits beyond thirty seconds for only the selected preparation and restores its native history', async () => {
  let prepared = false;
  const { controller, request, error } = fixture(() => prepared ? Promise.resolve(snapshot) : Promise.reject(pending()));
  controller.state.chatMessages = messages;
  controller.state.currentSessionId = snapshot.sessionId;
  controller.state.initialHistoryReady = true;
  const loading = controller.loadHistory();
  await vi.advanceTimersByTimeAsync(31_000);
  expect(controller.state.chatLoading).toBe(true);
  expect(controller.state.historyPreparationPending).toBe(true);
  expect(controller.state.historyReadFailed).toBe(false);
  expect(controller.state.initialHistoryReady).toBe(false);
  expect(controller.state.chatMessages).toEqual(messages);
  expect(error).not.toHaveBeenCalled();
  await expect(controller.sendMessage('must wait')).rejects.toThrow();
  await expect(controller.sendSideQuestion('must wait', 'side-run')).rejects.toThrow();
  await expect(sendQueuedInput(controller.state, 'must wait', [], sessionKey)).rejects.toThrow();
  expect(request.mock.calls.some(([method]) => method === 'chat.send')).toBe(false);
  prepared = true;
  await vi.advanceTimersByTimeAsync(8_000);
  expect(await loading).toBe(true);
  expect(controller.state.chatMessages).toEqual(messages);
  expect(controller.state.initialHistoryReady).toBe(true);
  expect(controller.state.historyPreparationPending).not.toBe(true);
  expect(request.mock.calls.filter(([method]) => method === 'chat.history').length).toBeLessThanOrEqual(9);
  expect(request.mock.calls.some(([method]) => method === 'sessions.messages.subscribe')).toBe(true);
  controller.disconnect();
});

test.each([
  pending('agent-database-inspection-failed'),
  pending('agent-database-ownership-mismatch'),
  pending('agent-database-inspection-pending', 'other-agent'),
  Object.assign(new Error('same pending words'), { gatewayCode: 'UNAVAILABLE', retryable: true }),
])('does not retry a refusal without exact target pending evidence: %s', async failure => {
  const { controller, request } = fixture(() => Promise.reject(failure));
  expect(await controller.loadHistory()).toBe(false);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(request).toHaveBeenCalledOnce();
  expect(controller.state.historyReadFailed).toBe(true);
  expect(controller.state.historyPreparationPending).toBe(false);
  expect(controller.state.historyPreparationTimedOut).toBe(false);
  controller.disconnect();
});

test('coalesces pending reloads and leaves a stable retryable preparation notice at the deadline', async () => {
  let prepared = false;
  const { controller, request, error } = fixture(() => prepared ? Promise.resolve(snapshot) : Promise.reject(pending()));
  const loading = controller.loadHistory();
  await vi.advanceTimersByTimeAsync(0);
  for (let count = 0; count < 20; count++) await controller.loadHistory(true);
  await vi.advanceTimersByTimeAsync(HISTORY_PREPARATION_TIMEOUT_MS - 1_000);
  (controller as unknown as { scheduleDeferredHistoryReload(key: string, reason: string): void })
    .scheduleDeferredHistoryReload(sessionKey, 'session-message');
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await loading).toBe(false);
  expect(controller.state.chatLoading).toBe(false);
  expect(controller.state.historyReadFailed).toBe(true);
  expect(controller.state.historyPreparationPending).toBe(false);
  expect(controller.state.historyPreparationTimedOut).toBe(true);
  expect(error).not.toHaveBeenCalled();
  const calls = request.mock.calls.length;
  await vi.advanceTimersByTimeAsync(20_000);
  expect(request).toHaveBeenCalledTimes(calls);
  expect(request.mock.calls.filter(([method]) => method === 'chat.history').length).toBeLessThan(20);
  prepared = true;
  expect(await controller.loadHistory()).toBe(true);
  expect(controller.state.historyPreparationTimedOut).toBe(false);
  controller.disconnect();
});

test.each(['disconnect', 'close', 'generation'] as const)('cancels a pending owner on %s without retrying it', async action => {
  const { controller, client, request } = fixture(() => Promise.reject(pending()));
  const loading = controller.loadHistory();
  await vi.advanceTimersByTimeAsync(0);
  if (action === 'disconnect') controller.disconnect();
  if (action === 'close') (controller as unknown as { handleClose(): void }).handleClose();
  if (action === 'generation') client.generation++;
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await loading).toBe(false);
  expect(request.mock.calls.filter(([method]) => method === 'chat.history')).toHaveLength(1);
  expect(controller.state.historyReadFailed).not.toBe(true);
  controller.disconnect();
});

test('cancels A to B to A preparation and loads the newly selected A immediately', async () => {
  let prepared = false;
  const { controller, request } = fixture(() => prepared ? Promise.resolve(snapshot) : Promise.reject(pending()));
  const oldRead = controller.loadHistory();
  await vi.advanceTimersByTimeAsync(0);
  prepared = true;
  const toB = controller.switchSession('agent:other:justdo:b');
  const toA = controller.switchSession(sessionKey);
  await vi.advanceTimersByTimeAsync(0);
  await Promise.all([toA, toB]);
  expect(await oldRead).toBe(false);
  expect(controller.state.sessionKey).toBe(sessionKey);
  expect(controller.state.initialHistoryReady).toBe(true);
  expect(controller.state.chatMessages).toEqual(messages);
  const calls = request.mock.calls.length;
  await vi.advanceTimersByTimeAsync(8_000);
  expect(request).toHaveBeenCalledTimes(calls);
  controller.disconnect();
});

test('reestablishes the target message subscription before the successful snapshot', async () => {
  let ready = false;
  const order: string[] = [];
  const { controller, request } = fixture(() => Promise.resolve(snapshot));
  request.mockImplementation((method: string) => {
    order.push(method);
    if (method === 'sessions.messages.subscribe') return ready ? Promise.resolve({}) : Promise.reject(pending());
    if (method === 'chat.history') return ready ? Promise.resolve(snapshot) : Promise.reject(pending());
    return Promise.resolve({});
  });
  const loading = controller.loadHistory();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(order).toEqual(['chat.history', 'sessions.messages.subscribe']);
  ready = true;
  await vi.advanceTimersByTimeAsync(2_000);
  expect(await loading).toBe(true);
  expect(order.indexOf('chat.history', 1)).toBeGreaterThan(order.lastIndexOf('sessions.messages.subscribe'));
  expect((controller as unknown as { subscribedMessageSessionKey: string }).subscribedMessageSessionKey).toBe(sessionKey);
  controller.disconnect();
});

test.each(['generation', 'abort'] as const)('does not subscribe after an old unsubscribe await loses %s', async action => {
  const { controller, client, request } = fixture(() => Promise.resolve(snapshot));
  const internal = controller as unknown as {
    subscribedMessageSessionKey: string | null;
    syncMessageSessionSubscription(key: string, options?: { signal: AbortSignal }): Promise<boolean>;
  };
  internal.subscribedMessageSessionKey = 'agent:main:justdo:previous';
  let release!: () => void;
  request.mockImplementation(method => method === 'sessions.messages.unsubscribe'
    ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve({}));
  const readController = new AbortController();
  const subscribing = internal.syncMessageSessionSubscription(sessionKey, { signal: readController.signal });
  if (action === 'generation') client.generation++;
  else readController.abort();
  release();
  expect(await subscribing).toBe(false);
  expect(request.mock.calls.map(([method]) => method)).toEqual(['sessions.messages.unsubscribe']);
  controller.disconnect();
});

test('does not send old subscription ACK cleanup on a successor socket generation', async () => {
  const { controller, client, request } = fixture(() => Promise.resolve(snapshot));
  const internal = controller as unknown as {
    subscribedMessageSessionKey: string | null;
    syncMessageSessionSubscription(key: string): Promise<boolean>;
  };
  let release!: () => void;
  let subscriptions = 0;
  request.mockImplementation(method => method === 'sessions.messages.subscribe' && subscriptions++ === 0
    ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve({}));
  const oldSubscription = internal.syncMessageSessionSubscription(sessionKey);
  client.generation++;
  controller.state.sessionKey = 'agent:main:justdo:successor';
  expect(await internal.syncMessageSessionSubscription(controller.state.sessionKey)).toBe(true);
  release();
  expect(await oldSubscription).toBe(false);
  expect(internal.subscribedMessageSessionKey).toBe(controller.state.sessionKey);
  expect(request.mock.calls.some(([method]) => method === 'sessions.messages.unsubscribe')).toBe(false);
  controller.disconnect();
});

test('retains notifications arriving after the successful retry snapshot was dispatched', async () => {
  let release!: (result: unknown) => void;
  let reads = 0;
  const { controller, request } = fixture(() => {
    if (++reads === 1) return Promise.reject(pending());
    if (reads === 2) return new Promise(resolve => { release = resolve; });
    return Promise.resolve(snapshot);
  });
  const loading = controller.loadHistory();
  await vi.advanceTimersByTimeAsync(1_000);
  await controller.loadHistory(true);
  release(snapshot);
  expect(await loading).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(request.mock.calls.filter(([method]) => method === 'chat.history')).toHaveLength(3);
  controller.disconnect();
});

test('does not commit hydrated history after the same client advances its transport generation', async () => {
  const { controller, client, request } = fixture(() => Promise.resolve(snapshot));
  controller.state.chatMessages = messages;
  let release!: (result: unknown) => void;
  let reads = 0;
  request.mockImplementation(method => {
    if (method === 'chat.history') return ++reads === 1 ? Promise.reject(pending()) : Promise.resolve({
      sessionId: snapshot.sessionId,
      messages: [{ role: 'assistant', content: 'Truncated new snapshot', __openclaw: { id: 'new-answer', truncated: true } }],
    });
    if (method === 'chat.message.get') return new Promise(resolve => { release = resolve; });
    return Promise.resolve({});
  });
  const loading = controller.loadHistory();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(request.mock.calls.some(([method]) => method === 'chat.message.get')).toBe(true);
  client.generation++;
  release({ ok: true, message: { role: 'assistant', content: 'Complete stale snapshot', __openclaw: { id: 'new-answer' } } });
  expect(await loading).toBe(false);
  expect(controller.state.chatMessages).toEqual(messages);
  expect(controller.state.historyReadFailed).not.toBe(true);
  controller.disconnect();
});

test.each([true, false])('manual preparation retry establishes expected initial readiness only from this native snapshot: %s', async freshHasTask => {
  const task = { role: 'user', content: '[Subagent Context] You are running as a subagent (depth 1/1).\n[Subagent Task]\nFixture task' };
  let prepared = false;
  const { controller } = fixture(() => prepared ? Promise.resolve({
    sessionId: snapshot.sessionId,
    messages: freshHasTask ? [task, ...messages] : messages,
  }) : Promise.reject(pending()), { expectInitialHistory: true });
  controller.state.chatMessages = [task];
  const loading = controller.loadHistory();
  await vi.advanceTimersByTimeAsync(HISTORY_PREPARATION_TIMEOUT_MS);
  expect(await loading).toBe(false);
  expect(controller.state.historyPreparationTimedOut).toBe(true);
  prepared = true;
  await controller.loadHistory(true);
  expect(controller.state.initialHistoryReady).toBe(freshHasTask);
  expect(controller.state.historyPreparationTimedOut).toBe(false);
  controller.disconnect();
});

test.each([false, true])('bounds the actual initial-history flow and cannot borrow old task readiness on manual retry (cached=%s)', async hasCachedTask => {
  const task = { role: 'user', content: '[Subagent Context] You are running as a subagent (depth 1/1).\n[Subagent Task]\nOld fixture task' };
  let prepared = false;
  const { controller, request } = fixture(() => prepared ? Promise.resolve(snapshot) : Promise.reject(pending()), {
    expectInitialHistory: true, initialHistoryRetryDelaysMs: [100, 300, 900],
  });
  const initializing = controller.switchSession(sessionKey);
  await vi.advanceTimersByTimeAsync(0);
  if (hasCachedTask) controller.state.chatMessages = [task];
  await vi.advanceTimersByTimeAsync(HISTORY_PREPARATION_TIMEOUT_MS);
  await initializing;
  expect(controller.state.historyPreparationTimedOut).toBe(true);
  expect(controller.state.historyReadFailed).toBe(true);
  expect(controller.state.initialHistoryReady).toBe(false);
  const calls = request.mock.calls.length;
  await vi.advanceTimersByTimeAsync(5_000);
  expect(request).toHaveBeenCalledTimes(calls);
  prepared = true;
  await controller.loadHistory(true);
  expect(controller.state.initialHistoryReady).toBe(false);
  if (!hasCachedTask) expect(controller.state.historyReadFailed).toBe(false);
  controller.disconnect();
});

test('does not borrow a cached task when the same initialization recovers before its deadline', async () => {
  const task = { role: 'user', content: '[Subagent Context] You are running as a subagent (depth 1/1).\n[Subagent Task]\nOld fixture task' };
  let prepared = false;
  const { controller } = fixture(() => prepared ? Promise.resolve(snapshot) : Promise.reject(pending()), {
    expectInitialHistory: true, initialHistoryRetryDelaysMs: [100, 300, 900],
  });
  const initializing = controller.switchSession(sessionKey);
  await vi.advanceTimersByTimeAsync(0);
  controller.state.chatMessages = [task];
  prepared = true;
  await vi.advanceTimersByTimeAsync(5_000);
  await initializing;
  expect(controller.state.initialHistoryReady).toBe(false);
  expect(controller.state.historyPreparationTimedOut).toBe(false);
  controller.disconnect();
});
