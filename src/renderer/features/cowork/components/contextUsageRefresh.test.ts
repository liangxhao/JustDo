import { describe, expect, it } from 'vitest';

import { contextUsageMatchesSession, resolveContextUsageDisplay } from './contextUsageRefresh';

describe('resolveContextUsageDisplay', () => {
  it('keeps displayed usage within the configured context window', () => {
    expect(resolveContextUsageDisplay(250_000, 200_000)).toEqual({
      usedTokens: 200_000,
      percentage: 100,
      overflowed: true,
    });
  });

  it('normalizes invalid negative values', () => {
    expect(resolveContextUsageDisplay(-10, 200_000)).toEqual({
      usedTokens: 0,
      percentage: 0,
      overflowed: false,
    });
  });

  it('accepts compact and agent-qualified aliases for the same managed session', () => {
    expect(contextUsageMatchesSession('justdo:session-1', 'session-1', 'main')).toBe(true);
    expect(
      contextUsageMatchesSession('agent:main:justdo:session-1', 'session-1', 'main'),
    ).toBe(true);
    expect(contextUsageMatchesSession('justdo:session-2', 'session-1', 'main')).toBe(false);
  });
});
