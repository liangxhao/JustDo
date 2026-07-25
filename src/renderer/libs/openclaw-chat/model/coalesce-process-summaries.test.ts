import { describe, expect, test } from 'vitest';

import { coalesceAdjacentProcessSummaries } from './coalesce-process-summaries';
import type { ProcessSummaryTimelineItem } from './project-turn-items';

function summary(key: string, itemId: string): ProcessSummaryTimelineItem {
  return {
    kind: 'process-summary',
    key,
    runId: key,
    thinkingCount: 1,
    toolCount: 0,
    errorCount: 0,
    interruptedCount: 0,
    items: [
      {
        id: itemId,
        runId: key,
        firstSeq: 1,
        lastSeq: 1,
        startedAt: 1,
        updatedAt: 2,
        type: 'thinking',
        status: 'completed',
        text: itemId,
      },
    ],
  };
}

describe('coalesceAdjacentProcessSummaries', () => {
  test('merges adjacent summaries and retains the first stable key and item order', () => {
    const result = coalesceAdjacentProcessSummaries([
      summary('persisted-key', 'history-thinking'),
      summary('active-key', 'active-thinking'),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      key: 'persisted-key',
      thinkingCount: 2,
      items: [{ id: 'history-thinking' }, { id: 'active-thinking' }],
    });
  });

  test('does not merge summaries across a real timeline boundary', () => {
    const result = coalesceAdjacentProcessSummaries([
      summary('first', 'thinking-1'),
      { kind: 'history-message', key: 'content-1' },
      summary('second', 'thinking-2'),
    ]);

    expect(result.map(item => item.kind)).toEqual([
      'process-summary',
      'history-message',
      'process-summary',
    ]);
  });
});
