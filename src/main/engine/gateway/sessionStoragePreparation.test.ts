import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { t } from '../../core/i18n';
import {
  SESSION_STORAGE_PREPARATION_TIMEOUT_MS,
  waitForSessionStorageReadiness,
} from './sessionStoragePreparation';
import type { GatewayClientLike } from './types';

const sessionKey = 'agent:main:conversation:storage-preparation';
const agentId = 'main';
const unavailable = (details?: unknown, retryable = false) => Object.assign(
  new Error('Session access facts are unavailable'),
  { code: 'UNAVAILABLE', gatewayCode: 'UNAVAILABLE', details, retryable },
);
const pending = () => unavailable({ code: 'agent-database-inspection-pending', agentId }, true);

function harness() {
  const request = vi.fn<GatewayClientLike['request']>().mockResolvedValue({ session: null });
  let current = true;
  const controller = new AbortController();
  const wait = () => waitForSessionStorageReadiness({
    client: { request }, sessionKey, agentId, signal: controller.signal,
    isCurrent: () => current,
  });
  return { request, controller, wait, retire: () => { current = false; } };
}

describe('native session storage preparation before creation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T00:00:00Z'));
  });

  afterEach(() => {
    const timers = vi.getTimerCount();
    vi.clearAllTimers();
    vi.useRealTimers();
    expect(timers).toBe(0);
  });

  it.each([
    { session: null },
    { session: { key: sessionKey } },
    { session: { key: sessionKey, agentId } },
  ])('accepts an exact native read without another delay: %j', async result => {
    const h = harness();
    h.request.mockResolvedValue(result);
    await expect(h.wait()).resolves.toBeUndefined();
    expect(h.request).toHaveBeenCalledExactlyOnceWith('sessions.describe', { key: sessionKey, agentId }, {
      signal: expect.any(AbortSignal), timeoutMs: SESSION_STORAGE_PREPARATION_TIMEOUT_MS,
    });
  });

  it('waits on read-only unstructured failures with bounded exponential backoff', async () => {
    const h = harness();
    const times: number[] = [];
    const startedAt = Date.now();
    h.request.mockImplementation(async () => {
      times.push(Date.now() - startedAt);
      if (times.length <= 5) throw unavailable();
      return { session: null };
    });
    const result = h.wait();
    await vi.advanceTimersByTimeAsync(23_000);
    await expect(result).resolves.toBeUndefined();
    expect(times).toEqual([0, 1_000, 3_000, 7_000, 15_000, 23_000]);
    expect(h.request.mock.calls.every(([method]) => method === 'sessions.describe')).toBe(true);
  });

  it.each([
    pending(),
    unavailable(undefined, true),
    unavailable({ reason: 'startup-sidecars', method: 'sessions.describe' }, true),
  ])('waits for the same native target preparation: %j', async error => {
    const h = harness();
    h.request.mockRejectedValueOnce(error);
    const result = h.wait();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toBeUndefined();
    expect(h.request).toHaveBeenCalledTimes(2);
  });

  it.each([
    unavailable({ code: 'agent-database-inspection-failed', agentId }),
    unavailable({ code: 'agent-database-ownership-mismatch', agentId }),
    unavailable({ code: 'ownership-mismatch', agentId }),
    unavailable({ code: 'SESSION_ACCESS_CHANGED', agentId }),
    unavailable({ code: 'SESSION_ACCESS_REFRESHING', agentId }),
    unavailable({ code: 'unrecognized-failure', agentId }),
    unavailable({ code: 'agent-database-inspection-pending', agentId: 'other' }, true),
    unavailable({ code: 'agent-database-inspection-pending' }, true),
    unavailable({ code: 'agent-database-inspection-pending', agentId }, false),
    unavailable({ agentId: 'other' }),
    unavailable([]),
    Object.assign(new Error('local unavailable'), { code: 'UNAVAILABLE' }),
    Object.assign(new Error('forbidden'), { code: 'FORBIDDEN', gatewayCode: 'FORBIDDEN' }),
    new Error('disconnected'),
  ])('retains fatal or unauthenticated failure without repeating the read: %j', async error => {
    const h = harness();
    h.request.mockRejectedValue(error);
    await expect(h.wait()).rejects.toBe(error);
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it.each([
    {}, { session: undefined }, { session: [] },
    { session: { key: 'agent:other:conversation:storage-preparation' } },
    { session: { key: sessionKey, agentId: 'other' } },
    { session: { key: sessionKey, agentId: undefined } },
    Object.create({ session: null }) as Record<string, unknown>,
  ])('rejects malformed or mismatched readiness evidence: %j', async result => {
    const h = harness();
    h.request.mockResolvedValue(result);
    await expect(h.wait()).rejects.toThrow(t('sessionStoragePreparationChanged'));
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it('bounds the complete wait including a request that ignores cancellation', async () => {
    const h = harness();
    let reply!: (value: Record<string, unknown>) => void;
    h.request.mockImplementation(() => new Promise(resolve => { reply = resolve; }));
    const observed = h.wait().catch(error => error);
    await vi.advanceTimersByTimeAsync(SESSION_STORAGE_PREPARATION_TIMEOUT_MS);
    expect(await observed).toEqual(new Error(t('sessionStoragePreparationTimeout')));
    expect(h.request.mock.calls[0][2]?.signal?.aborted).toBe(true);
    reply({ session: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it('does not restart the total deadline on each pending reply', async () => {
    const h = harness();
    h.request.mockRejectedValue(pending());
    const observed = h.wait().catch(error => error);
    await vi.advanceTimersByTimeAsync(SESSION_STORAGE_PREPARATION_TIMEOUT_MS);
    expect(await observed).toEqual(new Error(t('sessionStoragePreparationTimeout')));
    const count = h.request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.request).toHaveBeenCalledTimes(count);
  });

  it.each(['request', 'backoff'] as const)('cancels immediately during %s', async phase => {
    const h = harness();
    if (phase === 'request') h.request.mockImplementation(() => new Promise(() => {}));
    else h.request.mockRejectedValue(pending());
    const observed = h.wait().catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    const reason = new Error('Stopped by the user');
    h.controller.abort(reason);
    expect(await observed).toBe(reason);
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it.each(['request', 'backoff'] as const)('retires a changed owner during %s', async phase => {
    const h = harness();
    if (phase === 'request') h.request.mockImplementation(() => new Promise(() => {}));
    else h.request.mockRejectedValue(pending());
    const observed = h.wait().catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    h.retire();
    await vi.advanceTimersByTimeAsync(250);
    expect(await observed).toEqual(new Error(t('sessionStoragePreparationChanged')));
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it('rejects cancellation or ownership changes before the first read', async () => {
    const stopped = harness();
    stopped.controller.abort();
    await expect(stopped.wait()).rejects.toHaveProperty('name', 'AbortError');
    expect(stopped.request).not.toHaveBeenCalled();
    const retired = harness();
    retired.retire();
    await expect(retired.wait()).rejects.toThrow(t('sessionStoragePreparationChanged'));
    expect(retired.request).not.toHaveBeenCalled();
  });

  it('checks ownership again when the read resolves before the owner timer', async () => {
    const h = harness();
    h.request.mockImplementation(async () => {
      h.retire();
      return { session: null };
    });
    await expect(h.wait()).rejects.toThrow(t('sessionStoragePreparationChanged'));
    expect(h.request).toHaveBeenCalledTimes(1);
  });
});
