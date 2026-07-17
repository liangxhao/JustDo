import { describe, expect, it } from 'vitest';

import { normalizeDailyTokenUsage, normalizeUsageCacheInfo } from './usage';

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
