// @vitest-environment jsdom
import type { DailyTokenUsageResult } from '@shared/openclaw/usage';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import UsageDashboard from './UsageDashboard';

vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => key, getLanguage: () => 'en' },
}));
afterEach(cleanup);
const daily = [
  { date: '2026-09-29', input: 20, output: 50, cacheRead: 60, cacheWrite: 20, totalTokens: 150 },
];
const snapshot: DailyTokenUsageResult = {
  success: true,
  daily,
  totalTokens: 150,
  activity: {
    sessionCount: 2,
    userMessages: 3,
    assistantMessages: 5,
    errors: 0,
    toolCalls: 9,
    byModel: [
      { name: 'small', totalTokens: 20 },
      { name: 'large', totalTokens: 130 },
    ],
    byProvider: [{ name: 'provider', totalTokens: 150 }],
    byAgent: [],
    tools: [{ name: 'read', count: 9 }],
  },
};
describe('usage dashboard', () => {
  it('uses all input tokens as the cache denominator and exposes each daily category', () => {
    render(<UsageDashboard daily={daily} snapshot={snapshot} />);
    expect(screen.getByText('60.0%')).toBeTruthy();
    const chart = screen.getByRole('group', { name: 'usageStatsChartLabel' });
    expect(within(chart).getByRole('button').getAttribute('aria-label')).toContain(
      'usageStatsCacheWrite: 20',
    );
    fireEvent.click(screen.getByRole('button', { name: 'usageStatsTotalView' }));
    expect(
      screen.getByRole('button', { name: 'usageStatsTotalView' }).getAttribute('aria-pressed'),
    ).toBe('true');
  });
  it('sorts rankings by usage and switches between native dimensions', () => {
    render(<UsageDashboard daily={daily} snapshot={snapshot} />);
    const rows = document.querySelectorAll('.usage-rank-row');
    expect(rows[0].textContent).toContain('large');
    fireEvent.click(screen.getByRole('button', { name: 'usageStatsbyProvider' }));
    expect(screen.getByText('provider')).toBeTruthy();
    expect(screen.queryByText('large')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'usageStatsbyAgent' }));
    expect(screen.getByText('usageStatsEmpty')).toBeTruthy();
  });
  it('keeps unavailable activity distinct from zero usage', () => {
    render(
      <UsageDashboard
        daily={[]}
        snapshot={{ success: true, totalTokens: 0, activityError: 'offline' }}
      />,
    );
    expect(screen.getByRole('status').textContent).toBe('usageStatsActivityUnavailable');
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/NaN|Infinity/);
    expect(screen.queryByText('usageStatsErrors')).toBeNull();
  });
});
