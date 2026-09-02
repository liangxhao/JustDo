import { describe, expect, it } from 'vitest';

import type { CoworkSessionSummary } from '@/features/cowork/coworkTypes';
import {
  DEFAULT_COLLAPSED_SESSION_DATE_GROUP_KEYS,
  getSessionDateGroupKey,
  groupSessionsByDate,
  sumSessionDetailTokenUsage,
} from '@/features/cowork/sessionPresentation';

const summary = (id: string, updatedAt: number, pinned = false): CoworkSessionSummary => ({
  id,
  title: id,
  status: 'idle',
  pinned,
  createdAt: updatedAt,
  updatedAt,
});

describe('sumSessionDetailTokenUsage', () => {
  it('provides the fallback total when the provider does not report one', () => {
    expect(
      sumSessionDetailTokenUsage({
        input: 20_307,
        output: 2_424,
        cacheRead: 161_664,
        cacheWrite: 0,
      }),
    ).toBe(184_395);
  });
});

describe('session date grouping', () => {
  const now = new Date(2026, 0, 31, 0, 15).getTime();

  it('collapses every older date group by default', () => {
    expect(DEFAULT_COLLAPSED_SESSION_DATE_GROUP_KEYS).toEqual([
      'previous7Days',
      'previous30Days',
      'earlier',
    ]);
  });

  it('uses local calendar days across month boundaries', () => {
    expect(
      getSessionDateGroupKey(summary('today', new Date(2026, 0, 31, 0, 1).getTime()), now),
    ).toBe('today');
    expect(
      getSessionDateGroupKey(summary('yesterday', new Date(2026, 0, 30, 23, 59).getTime()), now),
    ).toBe('yesterday');
    expect(getSessionDateGroupKey(summary('seven', new Date(2026, 0, 24, 12).getTime()), now)).toBe(
      'previous7Days',
    );
    expect(getSessionDateGroupKey(summary('thirty', new Date(2026, 0, 1, 12).getTime()), now)).toBe(
      'previous30Days',
    );
    expect(
      getSessionDateGroupKey(summary('earlier', new Date(2025, 11, 31, 12).getTime()), now),
    ).toBe('earlier');
  });

  it('recognizes yesterday across a year boundary', () => {
    expect(
      getSessionDateGroupKey(
        summary('last-year', new Date(2025, 11, 31, 23, 59).getTime()),
        new Date(2026, 0, 1, 0, 1).getTime(),
      ),
    ).toBe('yesterday');
  });

  it('keeps pinned sessions first and sorts each group by activity', () => {
    const groups = groupSessionsByDate(
      [
        summary('older-today', new Date(2026, 0, 31, 8).getTime()),
        summary('pinned', new Date(2025, 0, 1).getTime(), true),
        summary('newer-today', new Date(2026, 0, 31, 9).getTime()),
      ],
      new Date(2026, 0, 31, 12).getTime(),
    );

    expect(groups.map(group => group.key)).toEqual(['pinned', 'today']);
    expect(groups[1].sessions.map(session => session.id)).toEqual(['newer-today', 'older-today']);
  });
});
