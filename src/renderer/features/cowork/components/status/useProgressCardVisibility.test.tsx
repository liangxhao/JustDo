// @vitest-environment jsdom

import { type ProgressCard, ProgressCardStepStatus } from '@shared/openclaw/progressCard';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PROGRESS_CARD_COMPLETION_DISPLAY_MS,
  useProgressCardVisibility,
} from './useProgressCardVisibility';

const card = (revision: number, complete = false): ProgressCard => ({
  sessionKey: 'agent:main:justdo:session-1',
  revision,
  updatedAt: revision,
  steps: [
    {
      step: 'Implement the progress card',
      status: complete ? ProgressCardStepStatus.Completed : ProgressCardStepStatus.InProgress,
    },
  ],
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useProgressCardVisibility', () => {
  it('shows active progress and preserves a manual hide across revisions', () => {
    const { result, rerender } = renderHook(({ value }) => useProgressCardVisibility(value), {
      initialProps: { value: card(1) as ProgressCard | null },
    });

    expect(result.current.visible).toBe(true);
    act(() => result.current.hide());
    rerender({ value: card(2) });
    expect(result.current.visible).toBe(false);
  });

  it('briefly shows a newly completed card and then hides it without deleting it', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ value }) => useProgressCardVisibility(value), {
      initialProps: { value: card(1) as ProgressCard | null },
    });

    rerender({ value: card(2, true) });
    expect(result.current.visible).toBe(true);

    act(() => vi.advanceTimersByTime(PROGRESS_CARD_COMPLETION_DISPLAY_MS));
    expect(result.current.visible).toBe(false);

    act(() => result.current.show());
    expect(result.current.visible).toBe(true);
  });

  it('cancels automatic hiding when the user interacts with the completed card', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ value }) => useProgressCardVisibility(value), {
      initialProps: { value: card(1) },
    });

    rerender({ value: card(2, true) });
    act(() => result.current.show());
    act(() => vi.advanceTimersByTime(PROGRESS_CARD_COMPLETION_DISPLAY_MS));

    expect(result.current.visible).toBe(true);
  });

  it('keeps an already completed card hidden when a session is restored', () => {
    const { result } = renderHook(() => useProgressCardVisibility(card(3, true)));
    expect(result.current.visible).toBe(false);
  });

  it('shows a new active plan after the preceding plan completed', () => {
    const { result, rerender } = renderHook(({ value }) => useProgressCardVisibility(value), {
      initialProps: { value: card(1, true) },
    });

    rerender({ value: card(2) });
    expect(result.current.visible).toBe(true);
  });
});
