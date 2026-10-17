import { expect, test, vi } from 'vitest';

import { ChatController } from './chat-controller';

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
