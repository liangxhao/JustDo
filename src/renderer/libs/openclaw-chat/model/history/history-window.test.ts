import { describe, expect, it } from 'vitest';

import {
  HISTORY_RENDER_WINDOW_SIZE,
  latestHistoryWindow,
  preserveHistoryWindow,
  shiftHistoryWindowNewer,
  shiftHistoryWindowOlder,
} from './history-window';

const messages = (start: number, count: number) =>
  Array.from({ length: count }, (_, offset) => ({
    role: 'assistant',
    content: `message-${start + offset}`,
    __openclaw: { id: `message-${start + offset}` },
  }));

describe('history window', () => {
  it('keeps a bounded render window while allowing all 100,000 messages to be traversed', () => {
    const total = 100_000;
    let window = latestHistoryWindow(total);
    expect(window.end - window.start).toBe(HISTORY_RENDER_WINDOW_SIZE);

    while (window.start > 0) window = shiftHistoryWindowOlder(window, total);
    expect(window).toEqual({ start: 0, end: HISTORY_RENDER_WINDOW_SIZE });

    while (window.end < total) window = shiftHistoryWindowNewer(window, total);
    expect(window).toEqual({
      start: total - HISTORY_RENDER_WINDOW_SIZE,
      end: total,
    });
  });

  it('preserves visible identities when an older page is prepended', () => {
    const current = messages(250, 1_000);
    const next = [...messages(0, 250), ...current];
    const preserved = preserveHistoryWindow(current, next, { start: 0, end: 750 });

    expect(preserved).toEqual({ start: 250, end: 1000 });
    expect(next[preserved.start]).toBe(current[0]);
  });

  it('keeps following the latest tail when messages are appended', () => {
    const current = messages(0, 2);
    const next = [...current, ...messages(2, 1)];

    expect(preserveHistoryWindow(current, next, { start: 0, end: 2 })).toEqual({
      start: 0,
      end: 3,
    });
  });
});
