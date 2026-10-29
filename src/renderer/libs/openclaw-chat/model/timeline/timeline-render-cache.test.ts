import { describe, expect, test } from 'vitest';

import type { ContentItem } from '../chat-transcript-state';
import { type PersistedTimelineItem, projectPersistedTimeline } from './project-history-timeline';
import type { ActiveTurnTimelineItem, ProcessSummaryTimelineItem, QuestionPresentationTimelineItem } from './project-turn-items';
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
  test.each([false, true])('replaces an unknown historical result with its real native receipt (failure: %s)', failed => {
    const cache = new PersistedTimelineRenderCache();
    const call = {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'missing-read', name: 'read' }],
    };
    const final = { role: 'assistant', content: 'The model continued.' };
    const initial = cache.get(projectPersistedTimeline([call, final]), {
      foldUnresolvedTools: true,
    });
    expect(initial.rows[0].item).toMatchObject({
      kind: 'completed-process', items: [{
        kind: 'process-summary', items: [{
          status: 'running', presentation: { outcome: 'unknown' },
        }],
      }],
    });
    const updated = cache.get(projectPersistedTimeline([
      call,
      {
        role: 'toolResult', toolCallId: 'missing-read', toolName: 'read', isError: failed,
        content: [{ type: 'text', text: failed ? 'Native read failed.' : 'Native read succeeded.' }],
      },
      final,
    ]), { foldUnresolvedTools: true });
    const group = updated.rows[0].item;
    if (group.kind !== 'completed-process') throw new Error('Missing process history');
    const process = group.items[0];
    if (process.kind !== 'process-summary') throw new Error('Missing process summary');
    expect(process.items[0]).toMatchObject({
      status: failed ? 'failed' : 'completed',
      output: failed ? 'Native read failed.' : 'Native read succeeded.',
    });
    expect(process.items[0]).not.toHaveProperty('presentation.outcome');
  });

  test('invalidates history folding when missing-result disclosure changes without a history revision', () => {
    const cache = new PersistedTimelineRenderCache();
    const timeline: PersistedTimelineItem[] = [
      {
        kind: 'live-process', key: 'yield', origin: 'persisted',
        item: {
          type: 'tool', id: 'yield', toolCallId: 'yield', name: 'sessions_yield',
          runId: 'old-run', firstSeq: 1, lastSeq: 1, startedAt: 1, updatedAt: 1,
          status: 'running',
        },
      },
      { kind: 'history-message', key: 'final', message: { role: 'assistant', content: 'answer' } },
    ];
    const original = cache.get(timeline);
    expect(original.rows[0].item.kind).toBe('live-process');
    const archived = cache.get(timeline, { foldUnresolvedTools: true });
    expect(archived).not.toBe(original);
    expect(archived.rows[0].item.kind).toBe('completed-process');
    expect(cache.get(timeline, { foldUnresolvedTools: true })).toBe(archived);
    const restored = cache.get(timeline);
    expect(restored.rows[0].item).toBe(timeline[0]);
  });

  test('folds missing historical results across a settled live seam while retaining actual live tools', () => {
    const historical: PersistedTimelineItem = {
      kind: 'live-process', key: 'historical-yield', origin: 'persisted',
      item: {
        type: 'tool', id: 'historical-yield', toolCallId: 'historical-yield', name: 'sessions_yield',
        runId: 'run-live', firstSeq: 1, lastSeq: 1, startedAt: 1, updatedAt: 1,
        status: 'running',
      },
    };
    const actualLive = { ...historical, key: 'actual-live', origin: undefined };
    const final = activeContent('final answer', 4);
    if (final.kind !== 'content') throw new Error('Missing final content');
    final.item.status = 'completed';
    const view = projectIncrementalTimelineView({
      persisted: new PersistedTimelineRenderCache().get([historical], {
        protectTrailingTurn: true, foldUnresolvedTools: true,
      }),
      activeTimeline: [actualLive, final],
      suppressTrailingAssistantFooter: true,
      foldSettledTurn: true,
      foldUnresolvedTools: true,
    });
    const rows = [...view.persistedRows, ...view.activeRows];
    expect(rows.map(row => row.item.kind)).toEqual(['completed-process', 'live-process', 'content']);
    expect(rows[1].item).toBe(actualLive);
    expect(historical.item).not.toHaveProperty('presentation.outcome');
  });

  test('keeps live questions in process disclosure and merges them on settled history takeover', () => {
    const question: QuestionPresentationTimelineItem = {
      kind: 'question-presentation',
      key: 'question-1',
      item: {
        type: 'tool', id: 'question-1', toolCallId: 'call-1', name: 'ask_user_question',
        runId: 'run-live', firstSeq: 1, lastSeq: 1, startedAt: 1, updatedAt: 1,
        status: 'running',
      },
    };
    const cache = new PersistedTimelineRenderCache();
    const live = projectIncrementalTimelineView({
      persisted: cache.get([]),
      activeTimeline: [summary('working'), question],
      suppressTrailingAssistantFooter: true,
    });
    expect(live.activeRows.map(row => row.item.kind)).toEqual(['process-summary', 'completed-process']);

    const final = activeContent('final answer', 4);
    if (final.kind !== 'content') throw new Error('Missing final content');
    final.item.status = 'completed';
    question.item.status = 'completed';
    const settled = projectIncrementalTimelineView({
      persisted: cache.get([summary('working'), question], { protectTrailingTurn: true }),
      activeTimeline: [summary('following'), final],
      suppressTrailingAssistantFooter: true,
      foldSettledTurn: true,
    });
    const combined = [...settled.persistedRows, ...settled.activeRows];
    expect(combined.map(row => row.item.kind)).toEqual(['completed-process', 'content']);
    expect(combined[0].item).toMatchObject({ items: [summary('working'), question, summary('following')] });
  });

  test('folds a settled turn across its persisted/live seam while preserving final content', () => {
    const persistedSummary = summary('persisted-process');
    const activeSummary = summary('active-process');
    const commentary = activeContent('commentary', 2);
    const final = activeContent('final answer', 3);
    if (commentary.kind !== 'content' || final.kind !== 'content')
      throw new Error('Missing content');
    commentary.item.status = 'completed';
    final.item.status = 'completed';
    const timeline: PersistedTimelineItem[] = [
      { kind: 'history-message', key: 'user', message: { role: 'user', content: 'request' } },
      persistedSummary,
    ];
    const view = projectIncrementalTimelineView({
      persisted: new PersistedTimelineRenderCache().get(timeline, { protectTrailingTurn: true }),
      activeTimeline: [activeSummary, commentary, summary('last-process'), final],
      suppressTrailingAssistantFooter: true,
      foldSettledTurn: true,
    });

    expect([...view.persistedRows, ...view.activeRows].map(row => row.item.kind)).toEqual([
      'history-message',
      'completed-process',
      'content',
    ]);
    const folded = view.activeRows[0].item;
    if (folded.kind !== 'completed-process') throw new Error('Missing disclosure');
    expect(folded.items.map(item => item.key)).toEqual([
      'persisted-process',
      'content-2',
      'last-process',
    ]);
    expect(folded.items[0]).toMatchObject({ thinkingCount: 2 });
    expect(view.activeRows[1].item).toBe(final);
    expect(view.seamRow).toBeNull();
    expect(view.persistedRows).toHaveLength(1);
  });

  test('does not fold unfinished final content even when requested', () => {
    const view = projectIncrementalTimelineView({
      persisted: new PersistedTimelineRenderCache().get([]),
      activeTimeline: [summary('process'), activeContent('still streaming', 2)],
      suppressTrailingAssistantFooter: true,
      foldSettledTurn: true,
    });
    expect(view.activeRows.map(row => row.item.kind)).toEqual(['process-summary', 'content']);
  });

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
