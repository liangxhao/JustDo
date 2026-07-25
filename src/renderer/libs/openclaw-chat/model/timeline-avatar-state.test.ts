import { describe, expect, test } from 'vitest';

import type { VisibleTimelineItem } from './timeline-avatar-state';
import { prepareVisibleTimelineRows } from './timeline-avatar-state';

function history(key: string, role: string): VisibleTimelineItem {
  return {
    kind: 'history-message',
    key,
    message: { role, content: `${role} content` },
  };
}

function summary(key: string): VisibleTimelineItem {
  return {
    kind: 'process-summary',
    key,
    runId: 'run-1',
    items: [],
    thinkingCount: 1,
    toolCount: 1,
    errorCount: 0,
    interruptedCount: 0,
  };
}

describe('timeline avatar state', () => {
  test('shows one assistant avatar across multiple summary and Content segments in a turn', () => {
    const rows = prepareVisibleTimelineRows([
      history('user-1', 'user'),
      summary('summary-1'),
      history('content-1', 'assistant'),
      summary('summary-2'),
      history('content-2', 'assistant'),
    ]);

    expect(rows.map(row => row.showAvatar)).toEqual([true, true, false, false, false]);
  });

  test('starts a new assistant avatar after the next user message', () => {
    const rows = prepareVisibleTimelineRows([
      summary('summary-1'),
      history('content-1', 'assistant'),
      history('user-2', 'user'),
      summary('summary-2'),
      history('content-2', 'assistant'),
    ]);

    expect(rows.map(row => row.showAvatar)).toEqual([true, false, true, true, false]);
  });
});
