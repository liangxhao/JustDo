import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CONTEXT_USAGE_IDLE_RETRY_MS,
  CONTEXT_USAGE_RUNNING_REFRESH_MS,
  getContextUsageRefreshDelay,
  mergeContextUsageSnapshot,
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

  it('performs two bounded finalization retries after a run', async () => {
    vi.useFakeTimers();
    const fetchUsage = vi.fn().mockResolvedValue({ success: true, totalTokens: 10_000 });

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
