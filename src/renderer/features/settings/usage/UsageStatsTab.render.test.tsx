// @vitest-environment jsdom
import type { DailyTokenUsageResult } from '@shared/openclaw/usage';
import { act, cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import UsageStatsTab from './UsageStatsTab';

vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => key, getLanguage: () => 'en' },
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const installUsage = (getDaily: ReturnType<typeof vi.fn>) => {
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { openclaw: { usage: { getDaily } } },
  });
};

describe('usage statistics loading', () => {
  it('shows an unavailable state instead of reporting zero consumption on failure', async () => {
    installUsage(vi.fn().mockResolvedValue({ success: false, error: 'offline' }));
    render(React.createElement(UsageStatsTab));
    await screen.findByText('usageStatsUnavailable');
    expect(screen.queryByText('0')).toBeNull();
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('does not request another refresh after unmount during a retry delay', async () => {
    vi.useFakeTimers();
    const response: DailyTokenUsageResult = {
      success: true,
      daily: [],
      totalTokens: 0,
      cacheStatus: { status: 'refreshing', cachedFiles: 0, pendingFiles: 1, staleFiles: 0 },
    };
    const getDaily = vi.fn().mockResolvedValue(response);
    installUsage(getDaily);
    const view = render(React.createElement(UsageStatsTab));
    await act(async () => {
      await Promise.resolve();
    });
    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(getDaily).toHaveBeenCalledTimes(1);
  });
});
