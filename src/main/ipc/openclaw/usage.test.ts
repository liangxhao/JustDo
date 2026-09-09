import { describe, expect, it, vi } from 'vitest';

const { handle } = vi.hoisted(() => ({ handle: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: { handle } }));

import type { OpenClawRuntimeAdapter } from '../../engine';
import {
  normalizeDailyTokenUsage,
  normalizeUsageActivity,
  normalizeUsageCacheInfo,
  registerOpenClawUsageHandlers,
} from './usage';

describe('usage overview', () => {
  it('retains refreshing activity status and strips cost and transcript fields', async () => {
    const cacheStatus = { status: 'refreshing', cachedFiles: 1, pendingFiles: 2, staleFiles: 0 };
    const request = vi
      .fn()
      .mockImplementation((method: string) =>
        Promise.resolve(
          method === 'usage.cost'
            ? {
                daily: [],
                totals: { totalTokens: 42, totalCost: 5 },
                cacheStatus: { ...cacheStatus, status: 'fresh' },
              }
            : {
                aggregates: {
                  sessionCount: 12,
                  byModel: [
                    {
                      provider: 'provider',
                      model: 'model',
                      totals: { totalTokens: 42, totalCost: 5 },
                    },
                  ],
                },
                cacheStatus,
                sessions: [{ content: 'private transcript' }],
              },
        ),
      );
    registerOpenClawUsageHandlers({
      getRuntime: () =>
        ({ getGatewayClient: () => ({ request }) }) as unknown as OpenClawRuntimeAdapter,
    });
    const result = await handle.mock.calls.at(-1)![1](null, {
      days: 7,
      timeZone: 'Asia/Shanghai',
      utcOffset: 'UTC+8',
    });
    expect(result.cacheStatus).toEqual(cacheStatus);
    expect(result.activity.sessionCount).toBe(12);
    expect(result.activity.byModel).toEqual([{ name: 'provider / model', totalTokens: 42 }]);
    expect(result).not.toHaveProperty('totalCost');
    expect(result).not.toHaveProperty('sessions');
  });

  it('uses all-session aggregates instead of the limited session list', () => {
    const result = normalizeUsageActivity({
      sessionCount: 1200,
      messages: { user: 9, assistant: 10, errors: 2 },
      tools: { totalCalls: 12, tools: [{ name: 'read', count: 12 }] },
      latency: { count: 2, avgMs: 1500 },
      byModel: [
        { provider: 'a', model: 'shared', totals: { totalTokens: 20 } },
        { provider: 'b', model: 'shared', totals: { totalTokens: 30 } },
      ],
    });
    expect(result.sessionCount).toBe(1200);
    expect(result.byModel.map(row => row.name)).toEqual(['b / shared', 'a / shared']);
    expect(result.averageLatencyMs).toBe(1500);
    expect(normalizeUsageActivity({}).averageLatencyMs).toBeUndefined();
  });

  it('requests identical calendar ranges and keeps token data when activity fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T18:00:00Z'));
    try {
      const request = vi.fn().mockImplementation((method: string) =>
        method === 'usage.cost'
          ? Promise.resolve({
              daily: [],
              totals: { totalTokens: 42 },
              updatedAt: 123,
            })
          : Promise.reject(new Error('unavailable')),
      );
      registerOpenClawUsageHandlers({
        getRuntime: () =>
          ({ getGatewayClient: () => ({ request }) }) as unknown as OpenClawRuntimeAdapter,
      });
      const handler = handle.mock.calls.at(-1)![1];
      const result = await handler(null, {
        days: 7,
        timeZone: 'Asia/Shanghai',
        utcOffset: 'UTC+8',
      });
      expect(request.mock.calls[0][1]).toEqual({
        startDate: '2026-09-03',
        endDate: '2026-09-09',
        agentScope: 'all',
        mode: 'specific',
        timeZone: 'Asia/Shanghai',
        utcOffset: 'UTC+8',
      });
      expect(request.mock.calls[1][1]).toEqual({
        ...request.mock.calls[0][1],
        groupBy: 'instance',
        limit: 1,
        includeContextWeight: false,
      });
      expect(result).toMatchObject({
        success: true,
        totalTokens: 42,
        activityError: expect.any(String),
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('normalizeDailyTokenUsage', () => {
  it('keeps valid Gateway daily usage fields', () => {
    expect(
      normalizeDailyTokenUsage([
        {
          date: '2026-07-17',
          input: 100,
          output: 20,
          cacheRead: 30,
          cacheWrite: 5,
          totalTokens: 155,
        },
      ]),
    ).toEqual([
      {
        date: '2026-07-17',
        input: 100,
        output: 20,
        cacheRead: 30,
        cacheWrite: 5,
        totalTokens: 155,
      },
    ]);
  });

  it('drops malformed entries and clamps invalid counters to zero', () => {
    expect(
      normalizeDailyTokenUsage([
        null,
        { date: 'not-a-date', totalTokens: 10 },
        { date: '2026-07-16', input: -1, output: Number.NaN, totalTokens: 4 },
      ]),
    ).toEqual([
      {
        date: '2026-07-16',
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 4,
      },
    ]);
  });
});

describe('normalizeUsageCacheInfo', () => {
  it('keeps a valid refreshing cache status', () => {
    expect(
      normalizeUsageCacheInfo({
        status: 'refreshing',
        cachedFiles: 201,
        pendingFiles: 420,
        staleFiles: 420,
        refreshedAt: 123,
      }),
    ).toEqual({
      status: 'refreshing',
      cachedFiles: 201,
      pendingFiles: 420,
      staleFiles: 420,
      refreshedAt: 123,
    });
  });

  it('rejects an unknown cache status', () => {
    expect(normalizeUsageCacheInfo({ status: 'unknown' })).toBeUndefined();
  });
});
