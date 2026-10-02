import { describe, expect, it } from 'vitest';

import {
  contextUsageMatchesSession,
  resolveContextUsageDisplay,
  resolveContextUsageLimit,
} from './contextUsageRefresh';

describe('resolveContextUsageLimit', () => {
  it('uses the last prompt budget instead of the advertised model window', () => {
    const limit = resolveContextUsageLimit(
      { contextTokens: 200_000, promptBudgetTokens: 100_000 },
      300_000,
    );
    expect(limit).toEqual({ contextTokens: 100_000, fromLastPrompt: true });
    expect(resolveContextUsageDisplay(80_000, limit.contextTokens).percentage).toBe(80);
  });

  it('falls back to native context then configured model for an invalid budget', () => {
    expect(
      resolveContextUsageLimit({ contextTokens: 200_000, promptBudgetTokens: NaN }, 300_000),
    ).toEqual({ contextTokens: 200_000, fromLastPrompt: false });
    expect(resolveContextUsageLimit({ contextTokens: null }, 300_000)).toEqual({
      contextTokens: 300_000,
      fromLastPrompt: false,
    });
    expect(
      resolveContextUsageLimit({ contextTokens: 0, promptBudgetTokens: -1 }, Infinity),
    ).toEqual({ contextTokens: 0, fromLastPrompt: false });
  });
});

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
    expect(contextUsageMatchesSession('agent:main:justdo:session-1', 'session-1', 'main')).toBe(
      true,
    );
    expect(contextUsageMatchesSession('justdo:session-2', 'session-1', 'main')).toBe(false);
  });
});
