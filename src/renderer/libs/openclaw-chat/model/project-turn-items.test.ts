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

  test('projects the temporary status below the existing waiting indicator', () => {
    const result = projectTurnItems(null, true, {
      kind: 'waiting-model',
      tone: 'neutral',
      quietMs: 20_000,
    });

    expect(result.map(entry => entry.kind)).toEqual(['waiting', 'waiting-status']);
  });

  test('projects the temporary status after partial assistant content', () => {
    const result = projectTurnItems(
      turn([item('content-1', 'content', 'running', { text: 'partial response' })]),
      true,
      { kind: 'slow-active', tone: 'neutral', quietMs: 60_000 },
    );

    expect(result.map(entry => entry.kind)).toEqual(['content', 'waiting-status']);
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

  test('ignores an empty Content control item between two distinct Thinking items', () => {
    const result = projectTurnItems(
      turn([
        item('think-1', 'thinking', 'completed', { text: 'First distinct thought.' }),
        item('content-empty', 'content', 'completed', { text: '' }),
        item('think-2', 'thinking', 'completed', { text: 'Second distinct thought.' }),
      ]),
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: 'process-summary',
      thinkingCount: 2,
      items: [{ id: 'think-1' }, { id: 'think-2' }],
    });
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

  test('keeps progress card writes as compact standalone receipts', () => {
    const result = projectTurnItems(
      turn([
        item('think-1', 'thinking', 'completed'),
        item('progress-1', 'tool', 'completed', {
          name: 'progress_card',
          input: { plan: [{ step: 'Inspect', status: 'completed' }] },
        }),
        item('tool-1', 'tool', 'completed'),
        item('progress-2', 'tool', 'running', {
          name: 'PROGRESS_CARD',
          input: {
            markdown: 'Implementation started',
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
      'progress-receipt',
      'process-summary',
      'progress-receipt',
    ]);
    expect(result.filter(entry => entry.kind === 'progress-receipt')).toMatchObject([
      { item: { id: 'progress-1' } },
      { item: { id: 'progress-2', status: 'running' } },
    ]);
  });

  test('keeps a progress card clear as a standalone receipt', () => {
    const result = projectTurnItems(
      turn([
        item('progress-clear', 'tool', 'completed', {
          name: 'progress_card',
          input: {},
        }),
      ]),
    );

    expect(result.map(entry => entry.kind)).toEqual(['progress-receipt']);
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

  test('keeps an unrelated terminal error after a failed Tool', () => {
    const result = projectTurnItems(
      turn([
        item('tool-1', 'tool', 'failed', { error: 'command failed' }),
        item('content-1', 'content', 'interrupted'),
        item('terminal-1', 'terminal', 'error', { message: 'provider unavailable' }),
      ]),
    );

    expect(result.map(entry => entry.kind)).toEqual(['process-summary', 'content', 'terminal']);
  });

  test('does not suppress an unrelated short terminal error substring', () => {
    const result = projectTurnItems(
      turn([
        item('tool-1', 'tool', 'failed', { error: 'fail' }),
        item('terminal-1', 'terminal', 'error', { message: 'provider failover unavailable' }),
      ]),
    );

    expect(result.map(entry => entry.kind)).toEqual(['process-summary', 'terminal']);
  });

  test('does not use arbitrary failed Tool output for terminal substring deduplication', () => {
    const result = projectTurnItems(
      turn([
        item('tool-1', 'tool', 'failed', {
          output: 'retry log: provider unavailable; switching endpoints',
        }),
        item('terminal-1', 'terminal', 'error', { message: 'provider unavailable' }),
      ]),
    );

    expect(result.map(entry => entry.kind)).toEqual(['process-summary', 'terminal']);
  });
});
