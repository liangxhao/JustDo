import { describe, expect, it } from 'vitest';

import { fillDailyTokenUsage, shouldPollUsageStats } from './UsageStatsTab';

describe('fillDailyTokenUsage', () => {
  it('fills missing local calendar days with zero usage', () => {
    const result = fillDailyTokenUsage(
      [
        {
          date: '2026-07-16',
          input: 8,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 10,
        },
      ],
      3,
      new Date(2026, 6, 17, 18),
    );

    expect(result.map(entry => [entry.date, entry.totalTokens])).toEqual([
      ['2026-07-15', 0],
      ['2026-07-16', 10],
      ['2026-07-17', 0],
    ]);
  });
});

describe('shouldPollUsageStats', () => {
  it('polls until OpenClaw reports a fresh cache', () => {
    expect(
      shouldPollUsageStats({
        status: 'refreshing',
        cachedFiles: 201,
        pendingFiles: 420,
        staleFiles: 420,
      }),
    ).toBe(true);
    expect(
      shouldPollUsageStats({
        status: 'fresh',
        cachedFiles: 621,
        pendingFiles: 0,
        staleFiles: 0,
      }),
    ).toBe(false);
    expect(shouldPollUsageStats()).toBe(false);
  });
});
