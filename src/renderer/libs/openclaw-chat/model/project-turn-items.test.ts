import { describe, expect, test } from 'vitest';

import type { AssistantTurn, TurnItem } from './chat-transcript-state';
import { projectTurnItems } from './project-turn-items';

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
    );

    expect(result.map(entry => entry.kind)).toEqual([
      'process-summary',
      'content',
      'process-summary',
      'content',
    ]);
    expect(result[0]).toMatchObject({ thinkingCount: 1, toolCount: 1 });
  });

  test('keeps every Tool status inside the same process summary', () => {
    const result = projectTurnItems(
      turn([
        item('tool-running', 'tool', 'running'),
        item('tool-completed', 'tool', 'completed'),
        item('tool-failed', 'tool', 'failed'),
        item('tool-cancelled', 'tool', 'cancelled'),
      ]),
    );

    expect(result.map(entry => entry.kind)).toEqual(['process-summary']);
    expect(result[0]).toMatchObject({
      thinkingCount: 0,
      toolCount: 4,
      errorCount: 1,
      interruptedCount: 1,
    });
  });

  test('keeps the summary key stable when its count grows', () => {
    const first = projectTurnItems(turn([item('think-1', 'thinking', 'completed')]));
    const second = projectTurnItems(
      turn([item('think-1', 'thinking', 'completed'), item('tool-1', 'tool', 'completed')]),
    );

    expect(second[0].key).toBe(first[0].key);
  });
});
