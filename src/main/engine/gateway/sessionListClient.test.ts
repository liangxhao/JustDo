import { describe, expect, it, vi } from 'vitest';

import { bindPluginGatewayClient, runWithPluginRequestBinding } from './pluginRequestBinding';
import { SessionListClient } from './sessionListClient';
import type { GatewayClientLike } from './types';

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness() {
  const first = deferred();
  const request = vi.fn().mockReturnValue(first.promise);
  const native = { request, start: vi.fn(), stop: vi.fn() };
  const client = new SessionListClient(native as GatewayClientLike);
  return { client, native, first, request };
}

describe('session list request sharing', () => {
  it('does not join plugin-bound reads to ordinary or other plugin requests', async () => {
    const h = harness();
    const client = bindPluginGatewayClient(h.client);
    const ordinary = client.request('sessions.list', {});
    const expected = {
      pluginId: 'plugin-a', registrationId: '11111111-1111-4111-8111-111111111111', processId: 123,
      gatewayMethods: [],
    };
    const assertCurrent = vi.fn();
    const owned = runWithPluginRequestBinding(expected, assertCurrent, () =>
      client.request('sessions.list', {}));
    const sameOwner = runWithPluginRequestBinding(expected, assertCurrent, () =>
      client.request('sessions.list', {}));
    const other = '22222222-2222-4222-8222-222222222222';
    runWithPluginRequestBinding({ ...expected, registrationId: other }, assertCurrent, () =>
      client.request('sessions.list', {}));
    expect(owned).not.toBe(ordinary);
    expect(sameOwner).not.toBe(owned);
    expect(h.request).toHaveBeenCalledTimes(4);
    expect(h.request.mock.calls[1]).toEqual(['plugin-a.app.dispatch', {
      registrationId: expected.registrationId, processId: 123, method: 'sessions.list', params: {},
    }, undefined]);
    expect(h.request.mock.calls[2][1].registrationId).toBe(expected.registrationId);
    expect(h.request.mock.calls[3][1].registrationId).toBe(other);
    expect(assertCurrent).toHaveBeenCalledTimes(3);
    h.first.resolve({ sessions: [] });
    await Promise.all([ordinary, owned, sameOwner]);
    runWithPluginRequestBinding(expected, () => { throw new Error('retired'); }, () => {
      expect(() => client.request('sessions.list', {})).toThrow('retired');
    });
    expect(h.request).toHaveBeenCalledTimes(4);
  });
  it('keeps a successful read when its diagnostic logger fails', async () => {
    const h = harness();
    const log = vi.spyOn(console, 'info').mockImplementation(() => { throw new Error('logger unavailable'); });
    try {
      const first = h.client.request('sessions.list', {});
      const second = h.client.request('sessions.list', {});
      h.first.resolve({ sessions: [] });
      await expect(first).resolves.toEqual({ sessions: [] });
      await expect(second).resolves.toEqual({ sessions: [] });
    } finally { log.mockRestore(); }
  });

  it('joins identical parallel reads and forgets their settled result', async () => {
    const h = harness();
    const first = h.client.request('sessions.list', { limit: 500, offset: 0 });
    const second = h.client.request('sessions.list', { offset: 0, limit: 500, search: undefined });
    expect(second).toBe(first);
    expect(h.request).toHaveBeenCalledOnce();
    h.first.resolve({ sessions: [] });
    await first;
    await h.client.request('sessions.list', { limit: 500, offset: 0 });
    expect(h.request).toHaveBeenCalledTimes(2);
  });

  it('keeps projection, archive, pagination, search, and timeout policies separate', () => {
    const h = harness();
    for (const params of [
      { limit: 500 }, { limit: 500, rowMode: 'compact' },
      { limit: 500, archived: 'all' }, { limit: 500, offset: 500 },
      { limit: 500, search: 'another' },
    ]) h.client.request('sessions.list', params);
    h.client.request('sessions.list', { limit: 500 }, { timeoutMs: 100 });
    expect(h.request).toHaveBeenCalledTimes(6);
    h.first.resolve({ sessions: [] });
  });

  it('never shares caller-cancellable reads', () => {
    const h = harness();
    const signal = new AbortController().signal;
    h.client.request('sessions.list', {}, { signal });
    h.client.request('sessions.list', {}, { signal });
    expect(h.request).toHaveBeenCalledTimes(2);
    h.first.resolve({ sessions: [] });
  });

  it('starts a fresh read after native invalidation without letting old completion evict it', async () => {
    const h = harness();
    const next = deferred();
    h.request.mockReturnValueOnce(h.first.promise).mockReturnValue(next.promise);
    const old = h.client.request('sessions.list', {});
    h.client.invalidateSessionLists();
    const fresh = h.client.request('sessions.list', {});
    h.first.resolve({ sessions: [{ key: 'old' }] });
    await old;
    expect(h.client.request('sessions.list', {})).toBe(fresh);
    next.resolve({ sessions: [{ key: 'current' }] });
    await fresh;
    expect(h.request).toHaveBeenCalledTimes(2);
  });

  it('invalidates both before and after mutations, including reads started during a pending mutation', async () => {
    const h = harness();
    const mutation = deferred();
    h.request.mockImplementation((method: string) => method === 'sessions.create' ? mutation.promise : h.first.promise);
    h.client.request('sessions.list', {});
    const creating = h.client.request('sessions.create', { key: 'new' });
    const during = h.client.request('sessions.list', {});
    mutation.resolve({ ok: true });
    await creating;
    expect(h.client.request('sessions.list', {})).not.toBe(during);
    expect(h.request).toHaveBeenCalledTimes(4);
    h.first.resolve({ sessions: [] });
  });

  it('releases a failed read so the next request can recover', async () => {
    const h = harness();
    const failed = h.client.request('sessions.list', {});
    const rejection = expect(failed).rejects.toThrow('disconnected');
    h.first.reject(new Error('disconnected'));
    await rejection;
    h.request.mockResolvedValue({ sessions: [] });
    await h.client.request('sessions.list', {});
    expect(h.request).toHaveBeenCalledTimes(2);
  });

  it('delegates lifecycle and never shares reads across different clients', () => {
    const h = harness();
    const other = new SessionListClient(h.native as GatewayClientLike);
    h.client.start();
    const old = h.client.request('sessions.list', {});
    expect(other.request('sessions.list', {})).not.toBe(old);
    h.client.stop();
    expect(h.client.request('sessions.list', {})).not.toBe(old);
    expect(h.native.start).toHaveBeenCalledOnce();
    expect(h.native.stop).toHaveBeenCalledOnce();
    h.first.resolve({ sessions: [] });
  });
});
