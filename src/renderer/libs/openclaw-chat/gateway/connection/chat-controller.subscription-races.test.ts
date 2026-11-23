import { expect, test, vi } from 'vitest';

import { ChatController } from '../chat-controller';

function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(request: ReturnType<typeof vi.fn>) {
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  const internals = controller as unknown as {
    subscribedMessageSessionKey: string | null;
    syncMessageSessionSubscription(key: string): Promise<boolean>;
  };
  return { controller, internals };
}

test('returning to A during unsubscribe does not reuse A readiness or subscribe stale B', async () => {
  const unsubscribeAck = deferred();
  const subscribeAck = deferred();
  const request = vi.fn((method: string) =>
    method === 'sessions.messages.unsubscribe' ? unsubscribeAck.promise : subscribeAck.promise,
  );
  const { controller, internals } = fixture(request);
  controller.state.sessionKey = 'B';
  internals.subscribedMessageSessionKey = 'A';
  const toB = internals.syncMessageSessionSubscription('B');
  controller.state.sessionKey = 'A';
  expect(controller.isInitialDispatchReady('A')).toBe(false);
  const toA = internals.syncMessageSessionSubscription('A');
  expect(controller.isInitialDispatchReady('A')).toBe(false);
  unsubscribeAck.resolve({});
  expect(await toB).toBe(false);
  subscribeAck.resolve({});
  expect(await toA).toBe(true);
  expect(controller.isInitialDispatchReady('A')).toBe(true);
  expect(request.mock.calls).toEqual([
    ['sessions.messages.unsubscribe', { key: 'A' }],
    ['sessions.messages.subscribe', { key: 'A' }],
  ]);
});

test.each([false, true])('stale A acknowledgement cannot remove returning A (new ACK first: %s)', async newerFirst => {
  const oldAck = deferred();
  const newAck = deferred();
  let aRequests = 0;
  const request = vi.fn((method: string, params: { key: string }) => {
    if (method === 'sessions.messages.subscribe' && params.key === 'A') {
      return ++aRequests === 1 ? oldAck.promise : newAck.promise;
    }
    return Promise.resolve({});
  });
  const { controller, internals } = fixture(request);
  controller.state.sessionKey = 'A';
  const oldA = internals.syncMessageSessionSubscription('A');
  controller.state.sessionKey = 'B';
  expect(await internals.syncMessageSessionSubscription('B')).toBe(true);
  controller.state.sessionKey = 'A';
  const newA = internals.syncMessageSessionSubscription('A');
  await vi.waitFor(() => expect(aRequests).toBe(2));
  if (newerFirst) {
    newAck.resolve({});
    expect(await newA).toBe(true);
  }
  oldAck.resolve({});
  expect(await oldA).toBe(false);
  expect(request).not.toHaveBeenCalledWith('sessions.messages.unsubscribe', { key: 'A' });
  if (!newerFirst) {
    expect(controller.isInitialDispatchReady('A')).toBe(false);
    newAck.resolve({});
    expect(await newA).toBe(true);
  }
  expect(controller.isInitialDispatchReady('A')).toBe(true);
});

test('a stale subscription to an abandoned key is still removed', async () => {
  const oldAck = deferred();
  const request = vi.fn((method: string, params: { key: string }) =>
    method === 'sessions.messages.subscribe' && params.key === 'A'
      ? oldAck.promise : Promise.resolve({}),
  );
  const { controller, internals } = fixture(request);
  controller.state.sessionKey = 'A';
  const oldA = internals.syncMessageSessionSubscription('A');
  controller.state.sessionKey = 'B';
  expect(await internals.syncMessageSessionSubscription('B')).toBe(true);
  oldAck.resolve({});
  expect(await oldA).toBe(false);
  expect(request).toHaveBeenCalledWith('sessions.messages.unsubscribe', { key: 'A' });
  expect(controller.isInitialDispatchReady('B')).toBe(true);
});

test('entering a local placeholder releases the previous subscription while a native selection can proceed', async () => {
  const unsubscribeAck = deferred();
  const request = vi.fn((method: string) => {
    if (method === 'sessions.messages.unsubscribe') return unsubscribeAck.promise;
    if (method === 'chat.history') return Promise.resolve({ sessionId: 'durable', messages: [] });
    return Promise.resolve({});
  });
  const { controller, internals } = fixture(request);
  const previousKey = 'agent:main:justdo:previous';
  const placeholderKey = 'agent:main:justdo:temp-draft';
  const nativeKey = 'agent:main:justdo:prepared';
  controller.state.sessionKey = previousKey;
  internals.subscribedMessageSessionKey = previousKey;

  const toPlaceholder = controller.switchSession(placeholderKey, { localPlaceholder: true });
  expect(request.mock.calls).toEqual([['sessions.messages.unsubscribe', { key: previousKey }]]);
  expect(controller.isInitialDispatchReady(placeholderKey)).toBe(false);
  await controller.switchSession(nativeKey);
  expect(controller.isInitialDispatchReady(nativeKey)).toBe(true);

  unsubscribeAck.resolve({});
  await toPlaceholder;
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    'sessions.messages.unsubscribe',
    'sessions.messages.subscribe',
    'chat.history',
  ]);
  expect(controller.isInitialDispatchReady(nativeKey)).toBe(true);
});

test('a native subscription whose key matches a local placeholder is retired on a late ACK', async () => {
  const subscribeAck = deferred();
  const request = vi.fn((method: string) => {
    if (method === 'sessions.messages.subscribe') return subscribeAck.promise;
    if (method === 'chat.history') return Promise.resolve({ sessionId: 'native-session', messages: [] });
    return Promise.resolve({});
  });
  const { controller, internals } = fixture(request);
  const sessionKey = 'agent:main:justdo:temp-draft';
  controller.state.sessionKey = sessionKey;
  const nativeSubscription = internals.syncMessageSessionSubscription(sessionKey);

  await controller.switchSession(sessionKey, { localPlaceholder: true });
  expect(controller.isInitialDispatchReady(sessionKey)).toBe(false);
  subscribeAck.resolve({});
  expect(await nativeSubscription).toBe(false);
  expect(request.mock.calls).toEqual([
    ['sessions.messages.subscribe', { key: sessionKey }],
    ['sessions.messages.unsubscribe', { key: sessionKey }],
  ]);

  await controller.switchSession(sessionKey);
  expect(controller.isInitialDispatchReady(sessionKey)).toBe(true);
  expect(controller.state.currentSessionId).toBe('native-session');
});

test('keeps an active local draft separate from a native transcript with the same key', async () => {
  const historyMessage = { role: 'user', content: 'Native history' };
  const request = vi.fn((method: string) => Promise.resolve(
    method === 'chat.history' ? { sessionId: 'native-session', messages: [historyMessage] } : {},
  ));
  const { controller } = fixture(request);
  const key = 'agent:main:justdo:temp-draft';
  await controller.switchSession(key);
  expect(controller.state.chatMessages).toEqual([historyMessage]);

  await controller.switchSession(key, { localPlaceholder: true });
  controller.setPendingUserMessage('Local draft');
  const { handleEvent } = controller as unknown as {
    handleEvent(event: { event: string; payload: unknown }): void;
  };
  handleEvent.call(controller, {
    event: 'sessions.changed',
    payload: { sessionKey: key, reason: 'reset', sessionId: 'new-native-session' },
  });
  expect(controller.state.currentSessionId).toBeNull();
  expect(controller.state.chatMessages).toEqual([]);
  expect(controller.state.pendingUserMessage?.text).toBe('Local draft');

  await controller.switchSession(key);
  expect(controller.state.currentSessionId).toBe('native-session');
  expect(controller.state.chatMessages).toEqual([historyMessage]);
  expect(controller.state.pendingUserMessage).toBeNull();

  controller.clearSending(key, undefined, { localPlaceholder: true });
  await controller.switchSession('agent:main:justdo:failed-preparation', {
    promoteFromSessionKey: key,
  });
  expect(controller.state.pendingUserMessage).toBeNull();
  expect(controller.state.chatSending).toBe(false);
});
