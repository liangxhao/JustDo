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
  test('shows a waiting row as soon as sending starts before a turn exists', () => {
    expect(projectTurnItems(null, true)).toEqual([
      { kind: 'waiting', key: 'waiting:pending-turn' },
    ]);
  });

  test('shows a waiting row before the first assistant event arrives', () => {
    expect(
      projectTurnItems({
        ...turn([]),
        runId: 'run-waiting',
      }),
    ).toEqual([{ kind: 'waiting', key: 'waiting:run-waiting' }]);
  });

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

  test('keeps a running Tool visible, then folds it into the previous summary', () => {
    const running = projectTurnItems(
      turn([item('tool-completed', 'tool', 'completed'), item('tool-running', 'tool', 'running')]),
    );
    const completed = projectTurnItems(
      turn([
        item('tool-completed', 'tool', 'completed'),
        item('tool-running', 'tool', 'completed'),
      ]),
    );

    expect(running.map(entry => entry.kind)).toEqual(['process-summary', 'live-process']);
    expect(running[0]).toMatchObject({ toolCount: 1 });
    expect(running[1]).toMatchObject({
      kind: 'live-process',
      item: { id: 'tool-running', status: 'running' },
    });
    expect(completed.map(entry => entry.kind)).toEqual(['process-summary']);
    expect(completed[0]).toMatchObject({ toolCount: 2 });
  });

  test('keeps streaming Thinking visible until it completes', () => {
    const streaming = projectTurnItems(
      turn([
        item('think-1', 'thinking', 'completed'),
        item('think-2', 'thinking', 'running', { text: 'still streaming' }),
      ]),
    );
    const completed = projectTurnItems(
      turn([
        item('think-1', 'thinking', 'completed'),
        item('think-2', 'thinking', 'completed', { text: 'finished' }),
      ]),
    );

    expect(streaming.map(entry => entry.kind)).toEqual(['process-summary', 'live-process']);
    expect(streaming[0]).toMatchObject({ thinkingCount: 1 });
    expect(streaming[1]).toMatchObject({
      item: { id: 'think-2', text: 'still streaming', status: 'running' },
    });
    expect(completed.map(entry => entry.kind)).toEqual(['process-summary']);
    expect(completed[0]).toMatchObject({ thinkingCount: 2 });
  });

  test('keeps the summary key stable when its count grows', () => {
    const first = projectTurnItems(turn([item('think-1', 'thinking', 'completed')]));
    const second = projectTurnItems(
      turn([item('think-1', 'thinking', 'completed'), item('tool-1', 'tool', 'completed')]),
    );

    expect(second[0].key).toBe(first[0].key);
  });

  test('keeps every valid update_plan call as a standalone timeline item', () => {
    const result = projectTurnItems(
      turn([
        item('think-1', 'thinking', 'completed'),
        item('plan-1', 'tool', 'completed', {
          name: 'update_plan',
          input: { plan: [{ step: 'Inspect', status: 'completed' }] },
        }),
        item('tool-1', 'tool', 'completed'),
        item('plan-2', 'tool', 'running', {
          name: 'UPDATE_PLAN',
          input: {
            explanation: 'Implementation started',
            plan: [
              { step: 'Inspect', status: 'completed' },
              { step: 'Implement', status: 'in_progress' },
            ],
          },
        }),
      ]),
    );

    expect(result.map(entry => entry.kind)).toEqual([
      'process-summary',
      'plan-update',
      'process-summary',
      'plan-update',
    ]);
    expect(result.filter(entry => entry.kind === 'plan-update')).toMatchObject([
      { item: { id: 'plan-1' } },
      { item: { id: 'plan-2', status: 'running' } },
    ]);
  });

  test('keeps malformed update_plan calls in the ordinary Tool timeline', () => {
    const result = projectTurnItems(
      turn([
        item('plan-invalid', 'tool', 'completed', {
          name: 'update_plan',
          input: { plan: [] },
        }),
      ]),
    );

    expect(result.map(entry => entry.kind)).toEqual(['process-summary']);
  });

  test('does not repeat a Tool failure as a terminal banner after Content', () => {
    const result = projectTurnItems(
      turn([
        item('tool-1', 'tool', 'failed', { error: 'command failed' }),
        item('content-1', 'content', 'completed'),
        item('terminal-1', 'terminal', 'error', { message: 'command failed' }),
      ]),
    );

    expect(result.map(entry => entry.kind)).toEqual(['process-summary', 'content']);
    expect(result[0]).toMatchObject({ errorCount: 1 });
  });

  test('keeps a terminal banner for a run error without a failed Tool', () => {
    const result = projectTurnItems(
      turn([
        item('content-1', 'content', 'interrupted'),
        item('terminal-1', 'terminal', 'error', { message: 'provider unavailable' }),
      ]),
    );

    expect(result.map(entry => entry.kind)).toEqual(['content', 'terminal']);
  });
});
