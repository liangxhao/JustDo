import { afterEach, describe, expect, test, vi } from 'vitest';

import type { GatewayClientLike } from '../../engine/gateway/types';
import {
  collectUserActivityUsage,
  USER_ACTIVITY_TIME_ZONE,
  USER_ACTIVITY_USAGE_TIMEOUT_MS,
} from './userActivityUsage';

const NOW = Date.parse('2026-11-04T16:05:00Z');
const usage = () => ({
  updatedAt: NOW - 1000,
  cacheStatus: { status: 'fresh' },
  aggregates: {
    costDaily: [{ date: '2026-11-05', input: 10, output: 20, totalTokens: 75 }],
    byCreator: [{ sessionActivity: [{ dates: ['2026-11-05'], sessionCount: 2 }] }],
  },
});
const gateway = (value: unknown) => {
  const request = vi.fn().mockResolvedValue(value);
  return { request, client: { request } as Pick<GatewayClientLike, 'request'> };
};

afterEach(() => vi.useRealTimers());

describe('optional native activity usage', () => {
  test('reads seven Beijing dates across midnight and month boundaries with one aggregate RPC', async () => {
    const source = usage();
    const { client, request } = gateway(source);

    const result = await collectUserActivityUsage(client, { now: NOW });

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith('sessions.usage', {
      startDate: '2026-10-30', endDate: '2026-11-05', agentScope: 'all',
      mode: 'specific', utcOffset: 'UTC+8', timeZone: USER_ACTIVITY_TIME_ZONE,
      groupBy: 'instance', limit: 1, includeContextWeight: false,
    }, { timeoutMs: USER_ACTIVITY_USAGE_TIMEOUT_MS, signal: expect.any(AbortSignal) });
    expect(result?.daily.map(day => day.date)).toEqual([
      '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02',
      '2026-11-03', '2026-11-04', '2026-11-05',
    ]);
    expect(result?.daily.at(-1)).toEqual({
      date: '2026-11-05', sessionCount: 2, inputTokens: 10, outputTokens: 20, totalTokens: 75,
    });
    expect(result?.cacheStatus).toBe('fresh');
    expect(result?.updatedAt).toBe(NOW - 1000);
  });

  test('sums all creator cohorts by date without double counting a repeated date or reading session details', async () => {
    const source = usage();
    source.aggregates.costDaily.push({ date: '2026-10-29', input: 900, output: 900, totalTokens: 1800 });
    source.aggregates.byCreator = [
      { sessionActivity: [{ dates: ['2026-11-04', '2026-11-05', '2026-11-05'], sessionCount: 2 }] },
      { sessionActivity: [
        { dates: ['2026-11-05'], sessionCount: 3 },
        { dates: ['2026-10-29', '2026-11-04'], sessionCount: 1 },
      ] },
    ];
    const response = { ...source, sessions: [{ usage: { totalTokens: 99999 } }],
      aggregates: { ...source.aggregates, byModel: [{ model: 'private-name', totalTokens: 99999 }] } };

    const result = await collectUserActivityUsage(gateway(response).client, { now: NOW });

    expect(result?.daily.at(-2)).toEqual({
      date: '2026-11-04', sessionCount: 3, inputTokens: 0, outputTokens: 0, totalTokens: 0,
    });
    expect(result?.daily.at(-1)?.sessionCount).toBe(5);
    expect(JSON.stringify(result)).not.toContain('private-name');
    expect(JSON.stringify(result)).not.toContain('99999');
    expect(JSON.stringify(response)).toContain('private-name');
  });

  test('fills valid empty aggregates with seven zero days while missing aggregates remain unavailable', async () => {
    const empty = { aggregates: { costDaily: [], byCreator: [] } };

    const result = await collectUserActivityUsage(gateway(empty).client, { now: NOW });

    expect(result?.daily).toHaveLength(7);
    expect(result?.daily.every(day => day.sessionCount === 0 && day.totalTokens === 0)).toBe(true);
    await expect(collectUserActivityUsage(gateway({ aggregates: {} }).client, { now: NOW })).resolves.toBeNull();
  });

  test.each(['partial', 'stale', 'refreshing'])('preserves %s cache state without polling or waiting for fresh data', async status => {
    const source = usage();
    source.cacheStatus.status = status;
    const { client, request } = gateway(source);

    const result = await collectUserActivityUsage(client, { now: NOW });

    expect(result?.cacheStatus).toBe(status);
    expect(request).toHaveBeenCalledOnce();
  });

  test('rejects invalid counts, duplicate token dates and overflow instead of reporting made-up zero usage', async () => {
    const badTokens = usage();
    badTokens.aggregates.costDaily[0].input = Number.NaN;
    const duplicate = usage();
    duplicate.aggregates.costDaily.push({ ...duplicate.aggregates.costDaily[0] });
    const negative = usage();
    negative.aggregates.byCreator[0].sessionActivity[0].sessionCount = -1;
    const overflow = usage();
    overflow.aggregates.byCreator[0].sessionActivity.push({
      dates: ['2026-11-05'], sessionCount: Number.MAX_SAFE_INTEGER,
    });

    for (const source of [badTokens, duplicate, negative, overflow]) {
      await expect(collectUserActivityUsage(gateway(source).client, { now: NOW })).resolves.toBeNull();
    }
  });

  test('bounds unexpected aggregate size and discards invalid optional status and timestamp', async () => {
    const huge = usage();
    huge.aggregates.byCreator = [{ sessionActivity: Array.from({ length: 5000 }, () => ({
      dates: ['2026-11-05'], sessionCount: 1,
    })) }];
    await expect(collectUserActivityUsage(gateway(huge).client, { now: NOW })).resolves.toBeNull();

    const optional = { ...usage(), cacheStatus: { status: 'unknown' }, updatedAt: Number.POSITIVE_INFINITY };
    const result = await collectUserActivityUsage(gateway(optional).client, { now: NOW });
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('cacheStatus');
    expect(result).not.toHaveProperty('updatedAt');
  });

  test('does not contact a gateway when missing, already aborted, or given an invalid clock', async () => {
    const { client, request } = gateway(usage());
    const controller = new AbortController();
    controller.abort();

    await expect(collectUserActivityUsage(null)).resolves.toBeNull();
    await expect(collectUserActivityUsage(client, { signal: controller.signal })).resolves.toBeNull();
    await expect(collectUserActivityUsage(client, { now: Number.NaN })).resolves.toBeNull();
    await expect(collectUserActivityUsage(client, { now: -8_640_000_000_000_000 })).resolves.toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  test('a rejecting gateway remains optional and the timeout timer is cleaned up', async () => {
    vi.useFakeTimers();
    const { client, request } = gateway(null);
    request.mockRejectedValue(new Error('unavailable'));

    await expect(collectUserActivityUsage(client, { now: NOW })).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('times out and aborts a gateway even if its request never settles', async () => {
    vi.useFakeTimers();
    const { client, request } = gateway(null);
    request.mockReturnValue(new Promise(() => {}));

    const pending = collectUserActivityUsage(client, { now: NOW });
    await vi.advanceTimersByTimeAsync(USER_ACTIVITY_USAGE_TIMEOUT_MS);

    await expect(pending).resolves.toBeNull();
    expect(request.mock.calls[0][2].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('external cancellation releases a hanging gateway immediately and cleans up its listener', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const { client, request } = gateway(null);
    request.mockReturnValue(new Promise(() => {}));

    const pending = collectUserActivityUsage(client, { now: NOW, signal: controller.signal });
    controller.abort();

    await expect(pending).resolves.toBeNull();
    expect(request.mock.calls[0][2].signal.aborted).toBe(true);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
});
