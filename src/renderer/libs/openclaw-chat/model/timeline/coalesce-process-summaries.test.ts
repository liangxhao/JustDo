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

  test('folds a punctuation-only Thinking at the history seam without swallowing it', () => {
    const persisted = summary('persisted-key', 'history-thinking');
    const persistedThinking = persisted.items[0];
    if (persistedThinking.type !== 'thinking') throw new Error('expected Thinking item');
    persistedThinking.text = 'Describe the screenshot clearly';
    const active = summary('active-key', 'active-thinking');
    const activeThinking = active.items[0];
    if (activeThinking.type !== 'thinking') throw new Error('expected Thinking item');
    activeThinking.text = '.';

    const result = coalesceAdjacentProcessSummaries([persisted, active]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      key: 'persisted-key',
      thinkingCount: 2,
      items: [
        { id: 'history-thinking', text: 'Describe the screenshot clearly' },
        { id: 'active-thinking', text: '.' },
      ],
    });
  });

  test('does not merge summaries across a real timeline boundary', () => {
    const first = summary('first', 'thinking-1');
    const second = summary('second', 'thinking-2');
    const result = coalesceAdjacentProcessSummaries([
      first,
      { kind: 'history-message', key: 'content-1' },
      second,
    ]);

    expect(result.map(item => item.kind)).toEqual([
      'process-summary',
      'history-message',
      'process-summary',
    ]);
    expect(result[0]).toBe(first);
    expect(result[2]).toBe(second);
  });

  test('flattens a 10,000-summary cluster with linear copying and immutable native items', () => {
    const sources = Array.from({ length: 10_000 }, (_, index) => {
      const item = summary(`summary-${index}`, `thinking-${index}`);
      item.toolCount = index % 2;
      item.errorCount = index % 3 === 0 ? 1 : 0;
      item.interruptedCount = index % 5 === 0 ? 1 : 0;
      Object.freeze(item.items);
      return Object.freeze(item);
    });
    const nativeItems = new Set(sources.map(item => item.items[0]));
    const iterator = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator)!;
    let copiedItems = 0;
    Object.defineProperty(Array.prototype, Symbol.iterator, {
      ...iterator,
      value(this: ProcessSummaryTimelineItem['items']) {
        if (this.length > 0 && nativeItems.has(this[0])) copiedItems += this.length;
        return iterator.value.call(this);
      },
    });
    let result: ProcessSummaryTimelineItem[];
    try {
      result = coalesceAdjacentProcessSummaries(sources);
    } finally {
      Object.defineProperty(Array.prototype, Symbol.iterator, iterator);
    }

    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('summary-0');
    expect(result[0]).toMatchObject({
      thinkingCount: 10_000, toolCount: 5_000, errorCount: 3_334, interruptedCount: 2_000,
    });
    expect(result[0].items).toHaveLength(10_000);
    expect(result[0].items[0]).toBe(sources[0].items[0]);
    expect(result[0].items[9_999]).toBe(sources[9_999].items[0]);
    expect(sources.every(item => item.items.length === 1 && Object.isFrozen(item))).toBe(true);
    expect(copiedItems).toBeLessThanOrEqual(nativeItems.size * 2);
  });
});
