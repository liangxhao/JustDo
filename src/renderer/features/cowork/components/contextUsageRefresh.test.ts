import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CONTEXT_USAGE_FINALIZATION_RETRIES,
  CONTEXT_USAGE_IDLE_RETRY_MS,
  CONTEXT_USAGE_RUNNING_REFRESH_MS,
  getContextUsageRefreshDelay,
  mergeContextUsageSnapshot,
  resolveContextUsageDisplay,
  resolveContextUsageRunState,
  startContextUsageRefresh,
} from './contextUsageRefresh';

afterEach(() => {
  vi.useRealTimers();
});

describe('getContextUsageRefreshDelay', () => {
  it('keeps polling for the duration of an active run', () => {
    expect(getContextUsageRefreshDelay(true, false, 0)).toBe(CONTEXT_USAGE_RUNNING_REFRESH_MS);
  });

  it('only schedules bounded retries when idle refresh needs another attempt', () => {
    expect(getContextUsageRefreshDelay(false, true, 2)).toBe(CONTEXT_USAGE_IDLE_RETRY_MS);
    expect(getContextUsageRefreshDelay(false, false, 2)).toBeNull();
    expect(getContextUsageRefreshDelay(false, true, 0)).toBeNull();
  });
});

describe('mergeContextUsageSnapshot', () => {
  const snapshot = (totalTokens: number, compactionCount: number) => ({
    totalTokens,
    contextTokens: 200_000,
    totalTokensFresh: true,
    compactionCount,
    generationKey: 'gateway-session-1:openai/gpt-5',
  });

  it('does not let estimates or finalized usage move backwards in one generation', () => {
    expect(mergeContextUsageSnapshot(snapshot(15_000, 2), snapshot(10_000, 2))).toEqual(
      snapshot(15_000, 2),
    );
  });

  it('accepts a lower value after context compaction', () => {
    expect(mergeContextUsageSnapshot(snapshot(15_000, 2), snapshot(10_000, 3))).toEqual(
      snapshot(10_000, 3),
    );
  });

  it('ignores a stale snapshot from an older compaction generation', () => {
    expect(mergeContextUsageSnapshot(snapshot(10_000, 3), snapshot(16_000, 2))).toEqual(
      snapshot(10_000, 3),
    );
  });

  it('accepts a lower value after the Gateway session or model changes', () => {
    const previous = snapshot(15_000, 3);
    const resetSession = {
      ...snapshot(8_000, 0),
      generationKey: 'gateway-session-2:openai/gpt-5',
    };
    const switchedModel = {
      ...snapshot(7_000, 0),
      generationKey: 'gateway-session-2:anthropic/claude-sonnet-4',
    };

    expect(mergeContextUsageSnapshot(previous, resetSession)).toEqual(resetSession);
    expect(mergeContextUsageSnapshot(resetSession, switchedModel)).toEqual(switchedModel);
  });

  it('accepts a newer lower estimate after truncation without a compaction', () => {
    const previous = {
      ...snapshot(180_090, 1),
      usageSource: 'estimate' as const,
      usageUpdatedAt: 200,
    };
    const next = {
      ...snapshot(137_444, 1),
      usageSource: 'estimate' as const,
      usageUpdatedAt: 201,
    };

    expect(mergeContextUsageSnapshot(previous, next)).toEqual(next);
  });

  it('accepts newer finalized provider usage below the last live estimate', () => {
    const previous = {
      ...snapshot(147_347, 1),
      usageSource: 'estimate' as const,
      usageUpdatedAt: 200,
    };
    const next = {
      ...snapshot(90_362, 1),
      usageSource: 'reported' as const,
      usageUpdatedAt: 300,
    };

    expect(mergeContextUsageSnapshot(previous, next)).toEqual(next);
  });

  it('rejects an older snapshot even when its token count is higher', () => {
    const current = { ...snapshot(90_362, 1), usageUpdatedAt: 300 };
    const stale = { ...snapshot(211_701, 1), usageUpdatedAt: 200 };

    expect(mergeContextUsageSnapshot(current, stale)).toEqual(current);
  });

  it('accepts newer usage when checkpoint retention shrinks the retained count', () => {
    const previous = { ...snapshot(147_347, 3), usageUpdatedAt: 200 };
    const next = { ...snapshot(90_362, 2), usageUpdatedAt: 300 };

    expect(mergeContextUsageSnapshot(previous, next)).toEqual(next);
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
});

describe('resolveContextUsageRunState', () => {
  it('preserves finalization across idle effect reruns until explicitly cleared', () => {
    const active = resolveContextUsageRunState(
      { sessionId: 'session-1', active: false, pendingFinalization: false },
      'session-1',
      true,
    );
    const firstIdle = resolveContextUsageRunState(active, 'session-1', false);
    const assistantMessageArrived = resolveContextUsageRunState(firstIdle, 'session-1', false);

    expect(firstIdle.pendingFinalization).toBe(true);
    expect(assistantMessageArrived.pendingFinalization).toBe(true);
  });

  it('clears pending finalization for a new run or session', () => {
    const pending = {
      sessionId: 'session-1',
      active: false,
      pendingFinalization: true,
    };

    expect(resolveContextUsageRunState(pending, 'session-1', true).pendingFinalization).toBe(false);
    expect(resolveContextUsageRunState(pending, 'session-2', false).pendingFinalization).toBe(
      false,
    );
  });
});

describe('startContextUsageRefresh', () => {
  const timerOptions = {
    schedule: (callback: () => void, delayMs: number) =>
      setTimeout(callback, delayMs) as unknown as number,
    cancelSchedule: (handle: number) =>
      clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
  };

  it('polls throughout an active run without overlapping requests', async () => {
    vi.useFakeTimers();
    let resolveFirst: ((result: { success: boolean; totalTokens: number }) => void) | undefined;
    const fetchUsage = vi
      .fn<() => Promise<{ success: boolean; totalTokens: number }>>()
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue({ success: true, totalTokens: 20_000 });

    const stop = startContextUsageRefresh({
      isRunActive: true,
      retryAfterSuccess: false,
      fetchUsage,
      onUsage: vi.fn(),
      ...timerOptions,
    });
    await vi.advanceTimersByTimeAsync(CONTEXT_USAGE_RUNNING_REFRESH_MS * 2);
    expect(fetchUsage).toHaveBeenCalledTimes(1);

    resolveFirst?.({ success: true, totalTokens: 10_000 });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(CONTEXT_USAGE_RUNNING_REFRESH_MS);
    expect(fetchUsage).toHaveBeenCalledTimes(2);
    stop();
  });

  it('does not retry a successful idle load unless a run just finished', async () => {
    vi.useFakeTimers();
    const fetchUsage = vi.fn().mockResolvedValue({ success: true, totalTokens: 10_000 });

    startContextUsageRefresh({
      isRunActive: false,
      retryAfterSuccess: false,
      fetchUsage,
      onUsage: vi.fn(),
      ...timerOptions,
    });
    await vi.runAllTimersAsync();
    expect(fetchUsage).toHaveBeenCalledTimes(1);
  });

  it('retries finalization until reported usage replaces the live estimate', async () => {
    vi.useFakeTimers();
    const fetchUsage = vi
      .fn()
      .mockResolvedValueOnce({ success: true, totalTokens: 15_000, usageSource: 'estimate' })
      .mockResolvedValueOnce({ success: true, totalTokens: 14_000, usageSource: 'estimate' })
      .mockResolvedValue({
        success: true,
        totalTokens: 10_000,
        usageSource: 'reported',
        hasActiveRun: false,
      });

    startContextUsageRefresh({
      isRunActive: false,
      retryAfterSuccess: true,
      fetchUsage,
      onUsage: vi.fn(),
      ...timerOptions,
    });
    await vi.runAllTimersAsync();
    expect(fetchUsage).toHaveBeenCalledTimes(3);
  });

  it('waits for authoritative idle state before accepting reported usage', async () => {
    vi.useFakeTimers();
    const fetchUsage = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        totalTokens: 9_000,
        usageSource: 'reported',
        hasActiveRun: true,
      })
      .mockResolvedValue({
        success: true,
        totalTokens: 10_000,
        usageSource: 'reported',
        hasActiveRun: false,
      });

    startContextUsageRefresh({
      isRunActive: false,
      retryAfterSuccess: true,
      fetchUsage,
      onUsage: vi.fn(),
      ...timerOptions,
    });
    await vi.runAllTimersAsync();
    expect(fetchUsage).toHaveBeenCalledTimes(2);
  });

  it('keeps finalizing when a current reported snapshot is rejected by the consumer', async () => {
    vi.useFakeTimers();
    const fetchUsage = vi.fn().mockResolvedValue({
      success: true,
      totalTokens: 10_000,
      usageSource: 'reported',
      hasActiveRun: false,
    });
    const onUsage = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);

    startContextUsageRefresh({
      isRunActive: false,
      retryAfterSuccess: true,
      fetchUsage,
      onUsage,
      ...timerOptions,
    });
    await vi.runAllTimersAsync();
    expect(fetchUsage).toHaveBeenCalledTimes(2);
  });

  it('reports when bounded idle retries are exhausted', async () => {
    vi.useFakeTimers();
    const onIdleComplete = vi.fn();

    startContextUsageRefresh({
      isRunActive: false,
      retryAfterSuccess: true,
      fetchUsage: vi.fn().mockResolvedValue({
        success: true,
        totalTokens: 10_000,
        usageSource: 'reported',
        hasActiveRun: true,
      }),
      onUsage: vi.fn(),
      onIdleComplete,
      ...timerOptions,
    });
    await vi.runAllTimersAsync();
    expect(onIdleComplete).toHaveBeenCalledTimes(1);
  });

  it('bounds finalization retries when reported usage never arrives', async () => {
    vi.useFakeTimers();
    const fetchUsage = vi
      .fn()
      .mockResolvedValue({ success: true, totalTokens: 15_000, usageSource: 'estimate' });

    startContextUsageRefresh({
      isRunActive: false,
      retryAfterSuccess: true,
      fetchUsage,
      onUsage: vi.fn(),
      ...timerOptions,
    });
    await vi.runAllTimersAsync();
    expect(fetchUsage).toHaveBeenCalledTimes(CONTEXT_USAGE_FINALIZATION_RETRIES + 1);
  });

  it('retries an idle success rejected because it belongs to the old model', async () => {
    vi.useFakeTimers();
    const fetchUsage = vi.fn().mockResolvedValue({ success: true, totalTokens: 10_000 });
    const onUsage = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);

    startContextUsageRefresh({
      isRunActive: false,
      retryAfterSuccess: false,
      fetchUsage,
      onUsage,
      ...timerOptions,
    });
    await vi.runAllTimersAsync();
    expect(fetchUsage).toHaveBeenCalledTimes(2);
  });

  it('retries failures and ignores a late result after cancellation', async () => {
    vi.useFakeTimers();
    const onUsage = vi.fn();
    const failedFetch = vi.fn().mockResolvedValue({ success: false });
    startContextUsageRefresh({
      isRunActive: false,
      retryAfterSuccess: false,
      fetchUsage: failedFetch,
      onUsage,
      ...timerOptions,
    });
    await vi.runAllTimersAsync();
    expect(failedFetch).toHaveBeenCalledTimes(3);

    let resolveLate: ((result: { success: boolean; totalTokens: number }) => void) | undefined;
    const stop = startContextUsageRefresh({
      isRunActive: true,
      retryAfterSuccess: false,
      fetchUsage: () =>
        new Promise(resolve => {
          resolveLate = resolve;
        }),
      onUsage,
      ...timerOptions,
    });
    stop();
    resolveLate?.({ success: true, totalTokens: 30_000 });
    await Promise.resolve();
    expect(onUsage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
