import { describe, expect, test } from 'vitest';

import type { AssistantTurn, TurnItem } from './chat-transcript-state';
import { projectTurnItems, recordToolVisibility } from './project-turn-items';

function item(
  id: string,
  type: TurnItem['type'],
  status: string,
  extra: Record<string, unknown> = {},
): TurnItem {
  return {
    id,
    runId: 'run-1',
    firstSeq: 1,
    lastSeq: 1,
    startedAt: 1,
    updatedAt: 1,
    type,
    status,
    ...(type === 'thinking' ? { text: id } : {}),
    ...(type === 'tool' ? { toolCallId: id, name: id } : {}),
    ...(type === 'content' ? { text: id, sourceMode: 'snapshot' } : {}),
    ...(type === 'terminal' ? { message: id } : {}),
    ...extra,
  } as TurnItem;
}

function turn(items: TurnItem[]): AssistantTurn {
  return {
    id: 'turn-1',
    runId: 'run-1',
    sessionId: null,
    lifecycleGeneration: null,
    sessionKey: 'session-1',
    status: 'running',
    lastAgentSeq: 10,
    startedAt: 1,
    items,
    toolById: new Map(),
  };
}

describe('projectTurnItems', () => {
  test('uses Content as a hard process summary boundary', () => {
    const result = projectTurnItems(
      turn([
        item('think-1', 'thinking', 'completed'),
        item('tool-1', 'tool', 'completed'),
        item('content-1', 'content', 'completed'),
        item('think-2', 'thinking', 'completed'),
        item('content-2', 'content', 'completed'),
      ]),
      { visibleSince: new Map(), now: 1000 },
    );

    expect(result.map(entry => entry.kind)).toEqual([
      'process-summary',
      'content',
      'process-summary',
      'content',
    ]);
    expect(result[0]).toMatchObject({ thinkingCount: 1, toolCount: 1 });
  });

  test('keeps failures visible and delays archiving a fast completed Tool', () => {
    const result = projectTurnItems(
      turn([item('tool-fast', 'tool', 'completed'), item('tool-failed', 'tool', 'failed')]),
      { visibleSince: new Map([['tool-fast', 800]]), now: 1000, minimumToolVisibleMs: 500 },
    );

    expect(result.map(entry => entry.kind)).toEqual(['tool', 'process-summary', 'tool']);
    expect(result[1]).toMatchObject({ errorCount: 1 });
  });

  test('records a completed Tool first observed after its result so it is still shown', () => {
    const activeTurn = turn([item('tool-fast', 'tool', 'completed')]);
    const visibleSince = new Map<string, number>();

    recordToolVisibility(activeTurn, visibleSince, 1000);
    const firstPaint = projectTurnItems(activeTurn, {
      visibleSince,
      now: 1000,
      minimumToolVisibleMs: 500,
    });
    const settledPaint = projectTurnItems(activeTurn, {
      visibleSince,
      now: 1500,
      minimumToolVisibleMs: 500,
    });

    expect(firstPaint.map(entry => entry.kind)).toEqual(['tool']);
    expect(firstPaint[0]).toMatchObject({ item: { name: 'tool-fast', status: 'completed' } });
    expect(settledPaint.map(entry => entry.kind)).toEqual(['process-summary']);
  });

  test('dismissing a failed Tool keeps it in the same process summary', () => {
    const result = projectTurnItems(
      turn([item('think-1', 'thinking', 'completed'), item('tool-failed', 'tool', 'failed')]),
      {
        visibleSince: new Map(),
        dismissedDiagnosticIds: new Set(['tool-failed']),
        now: 1000,
      },
    );

    expect(result.map(entry => entry.kind)).toEqual(['process-summary']);
    expect(result[0]).toMatchObject({ thinkingCount: 1, toolCount: 1, errorCount: 1 });
  });

  test('keeps the summary key stable when its count grows', () => {
    const first = projectTurnItems(turn([item('think-1', 'thinking', 'completed')]), {
      visibleSince: new Map(),
      now: 1000,
    });
    const second = projectTurnItems(
      turn([item('think-1', 'thinking', 'completed'), item('tool-1', 'tool', 'completed')]),
      { visibleSince: new Map(), now: 1000 },
    );

    expect(second[0].key).toBe(first[0].key);
  });
});
