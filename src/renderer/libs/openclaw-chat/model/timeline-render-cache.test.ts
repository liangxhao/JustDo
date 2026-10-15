import { describe, expect, test } from 'vitest';

import type { ContentItem } from './chat-transcript-state';
import type { PersistedTimelineItem } from './project-history-timeline';
import type { ActiveTurnTimelineItem, ProcessSummaryTimelineItem } from './project-turn-items';
import {
  PersistedTimelineRenderCache,
  projectIncrementalTimelineView,
} from './timeline-render-cache';

function activeContent(text: string, sequence: number): ActiveTurnTimelineItem {
  const item: ContentItem = {
    type: 'content',
    id: `content-${sequence}`,
    runId: 'run-live',
    firstSeq: sequence,
    lastSeq: sequence,
    startedAt: sequence,
    updatedAt: sequence,
    status: 'streaming',
    text,
    sourceMode: 'snapshot',
  };
  return { kind: 'content', key: item.id, item };
}

function summary(key: string): ProcessSummaryTimelineItem {
  return {
    kind: 'process-summary',
    key,
    runId: 'run-1',
    items: [],
    thinkingCount: 1,
    toolCount: 0,
    errorCount: 0,
    interruptedCount: 0,
  };
}

describe('PersistedTimelineRenderCache', () => {
  test('reuses history-sized row and minimap projections across live revisions', () => {
    let oldRoleReads = 0;
    const timeline: PersistedTimelineItem[] = Array.from({ length: 10_000 }, (_, index) => ({
      kind: 'history-message' as const,
      key: `message-${index}`,
      message: {
        get role() {
          oldRoleReads += 1;
          return index % 2 === 0 ? 'user' : 'assistant';
        },
        content: `message ${index}`,
      },
    }));
    const cache = new PersistedTimelineRenderCache();
    const persisted = cache.get(timeline);
    const revision = cache.revision;
    oldRoleReads = 0;

    for (let sequence = 0; sequence < 100; sequence += 1) {
      const view = projectIncrementalTimelineView({
        persisted: cache.get(timeline),
        activeTimeline: [activeContent(`stream ${sequence}`, sequence)],
        suppressTrailingAssistantFooter: true,
      });
      expect(view.persistedRows).toBe(persisted.rowsWithSuppressedFooter);
      expect(view.activeRows).toHaveLength(1);
      expect(view.minimapTail?.assistantText).toContain(`stream ${sequence}`);
    }

    expect(cache.revision).toBe(revision);
    expect(oldRoleReads).toBe(0);
  });

  test('recomputes only the final persisted/active summary seam', () => {
    const cache = new PersistedTimelineRenderCache();
    const timeline: PersistedTimelineItem[] = [
      {
        kind: 'history-message',
        key: 'user-1',
        message: { role: 'user', content: 'request' },
      },
      summary('persisted-summary'),
    ];
    const activeSummary: ActiveTurnTimelineItem = {
      ...summary('active-summary'),
      runId: 'run-live',
    };
    const persisted = cache.get(timeline);

    const view = projectIncrementalTimelineView({
      persisted,
      activeTimeline: [activeSummary, activeContent('answer', 2)],
      suppressTrailingAssistantFooter: true,
    });

    expect(view.persistedRows).toBe(persisted.rowsWithSuppressedFooterWithoutLast);
    expect(view.seamRow?.item).toMatchObject({
      key: 'persisted-summary',
      thinkingCount: 2,
    });
    expect(view.activeRows.map(row => row.item.key)).toEqual(['content-2']);
    expect(view.activeRows[0]?.showAvatar).toBe(false);
  });

  test('invalidates when the persisted timeline reference changes', () => {
    const cache = new PersistedTimelineRenderCache();
    const timeline = [summary('summary-1')];

    cache.get(timeline);
    const revision = cache.revision;
    cache.get([...timeline]);

    expect(cache.revision).toBe(revision + 1);
  });

  test('starts a new assistant avatar slot after a phase boundary', () => {
    const cache = new PersistedTimelineRenderCache();
    const persisted = cache.get([
      {
        kind: 'history-message',
        key: 'planning-user',
        message: { role: 'user', content: 'Plan this change' },
      },
      {
        kind: 'history-message',
        key: 'planning-assistant',
        message: { role: 'assistant', content: 'Here is the plan' },
      },
      {
        kind: 'phase-boundary',
        key: 'implementation-boundary',
        label: 'Implementation started',
      },
    ] satisfies PersistedTimelineItem[]);

    const view = projectIncrementalTimelineView({
      persisted,
      activeTimeline: [activeContent('Implementing now', 1)],
      suppressTrailingAssistantFooter: true,
    });

    expect(view.activeRows[0]?.showAvatar).toBe(true);
  });

  test('invalidates folding when the live-tail protection changes without a history revision', () => {
    const cache = new PersistedTimelineRenderCache();
    const timeline: PersistedTimelineItem[] = [
      { kind: 'history-message', key: 'user', message: { role: 'user', content: 'request' } },
      summary('process'),
      { kind: 'history-message', key: 'final', message: { role: 'assistant', content: 'answer' } },
    ];
    const live = cache.get(timeline, { protectTrailingTurn: true });
    expect(live.rows.map(row => row.item.kind)).toEqual([
      'history-message',
      'process-summary',
      'history-message',
    ]);
    expect(cache.get(timeline, { protectTrailingTurn: true })).toBe(live);

    const historical = cache.get(timeline, { protectTrailingTurn: false });
    expect(historical.rows.map(row => row.item.kind)).toEqual([
      'history-message',
      'completed-process',
      'history-message',
    ]);
    expect(historical).not.toBe(live);
    expect(cache.get(timeline)).toBe(historical);
  });
});
