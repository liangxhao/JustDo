import { afterEach, expect, test, vi } from 'vitest';

import type { GatewayClientLike } from '../../engine/gateway/types';
import { createExternalAgentHistoryReader } from './externalAgentHistoryReader';

const identity = { sessionKey: 'agent:main:external:fixture', nativeSessionId: 'native-1', lifecycleRevision: 'rev-1' };

function setup() {
  const request = vi.fn(async () => ({ session: {
    key: identity.sessionKey, sessionId: identity.nativeSessionId, lifecycleRevision: identity.lifecycleRevision,
  } }));
  const client = { request } as unknown as GatewayClientLike;
  let currentClient: GatewayClientLike | null = client;
  let generation = 1;
  const fetchSessionHistoryByKey = vi.fn(async () => ({ sessionKey: identity.sessionKey, messages: [{ role: 'user', content: 'hello' }] }));
  const runtime = { getGatewayClient: () => currentClient, getGatewayClientGeneration: () => generation, fetchSessionHistoryByKey };
  let currentRuntime: typeof runtime | null = runtime;
  return { request, fetchSessionHistoryByKey, runtime,
    setClient: (value: GatewayClientLike | null) => { currentClient = value; },
    setRuntime: (value: typeof runtime | null) => { currentRuntime = value; },
    replaceGeneration: () => { generation += 1; },
    read: createExternalAgentHistoryReader(() => currentRuntime, 100),
  };
}

afterEach(() => vi.useRealTimers());

test('reads one exact authenticated snapshot with identity checks on both sides', async () => {
  const h = setup();
  expect(await h.read(identity)).toEqual({ messages: [{ role: 'user', content: 'hello' }] });
  expect(h.request).toHaveBeenCalledTimes(2);
  expect(h.request).toHaveBeenCalledWith('sessions.describe', { key: identity.sessionKey }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(h.fetchSessionHistoryByKey).toHaveBeenCalledWith(identity.sessionKey, undefined, {
    forceFullSnapshot: true, signal: expect.any(AbortSignal),
  });
});

test('an unavailable Gateway does not initiate a history read', async () => {
  const h = setup();
  h.setClient(null);
  await expect(h.read(identity)).rejects.toThrow('Gateway is unavailable');
  expect(h.request).not.toHaveBeenCalled();
  expect(h.fetchSessionHistoryByKey).not.toHaveBeenCalled();
});

test('changed native incarnation rejects the snapshot instead of returning another history', async () => {
  const h = setup();
  h.request.mockResolvedValueOnce({ session: { key: identity.sessionKey, sessionId: 'replacement', lifecycleRevision: identity.lifecycleRevision } });
  await expect(h.read(identity)).rejects.toThrow('identity changed');
  expect(h.fetchSessionHistoryByKey).not.toHaveBeenCalled();
});

test('a lifecycle change during the read rejects its result', async () => {
  const h = setup();
  h.fetchSessionHistoryByKey.mockImplementationOnce(async () => {
    h.request.mockResolvedValue({ session: { key: identity.sessionKey, sessionId: identity.nativeSessionId, lifecycleRevision: 'rev-2' } });
    return { sessionKey: identity.sessionKey, messages: [] };
  });
  await expect(h.read(identity)).rejects.toThrow('identity changed');
});

test('a transport generation change rejects a snapshot even when the client object is reused', async () => {
  const h = setup();
  h.fetchSessionHistoryByKey.mockImplementationOnce(async () => {
    h.replaceGeneration();
    return { sessionKey: identity.sessionKey, messages: [] };
  });
  await expect(h.read(identity)).rejects.toThrow('Gateway changed');
  expect(h.request).toHaveBeenCalledTimes(1);
});

test('a runtime replacement rejects the old snapshot', async () => {
  const h = setup();
  h.fetchSessionHistoryByKey.mockImplementationOnce(async () => {
    h.setRuntime({ ...h.runtime });
    return { sessionKey: identity.sessionKey, messages: [] };
  });
  await expect(h.read(identity)).rejects.toThrow('Gateway changed');
});

test('a different resolved key is never accepted as an alias', async () => {
  const h = setup();
  h.fetchSessionHistoryByKey.mockResolvedValueOnce({ sessionKey: 'other-key', messages: [] });
  await expect(h.read(identity)).rejects.toThrow('snapshot is unavailable');
});

test('a stalled history read times out and late completion performs no further native lookup', async () => {
  vi.useFakeTimers();
  const h = setup();
  let finish!: (result: { sessionKey: string; messages: [] }) => void;
  h.fetchSessionHistoryByKey.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const outcome = expect(h.read(identity)).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(100);
  await outcome;
  finish({ sessionKey: identity.sessionKey, messages: [] });
  await Promise.resolve();
  expect(h.request).toHaveBeenCalledTimes(1);
});
