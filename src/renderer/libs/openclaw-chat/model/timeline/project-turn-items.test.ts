import { describe, expect, test } from 'vitest';

import type { AssistantTurn, TurnItem } from '../chat-transcript-state';
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
  test('keeps a running nested tool beside its completed parent until the family can fold', () => {
    const parent = item('parent', 'tool', 'completed', { name: 'tool_call' });
    const thinking = item('note', 'thinking', 'completed');
    const child = item('child', 'tool', 'running', { presentation: { parentToolCallId: 'parent' } });
    const answer = item('answer', 'content', 'streaming');
    const nativeOrder = [parent, thinking, child, answer];

    expect(projectTurnItems(turn(nativeOrder))).toMatchObject([
      { kind: 'live-process', item: parent, toolDepth: 0 },
      { kind: 'live-process', item: child, toolDepth: 1 },
      { kind: 'process-summary', items: [thinking] },
      { kind: 'content', item: answer },
    ]);

    const finished = { ...child, status: 'completed' } as TurnItem;
    expect(projectTurnItems(turn([parent, thinking, finished, answer]))).toMatchObject([
      { kind: 'process-summary', items: [parent, thinking, finished] },
      { kind: 'content', item: answer },
    ]);
    expect(nativeOrder.map(process => process.id)).toEqual(['parent', 'note', 'child', 'answer']);
  });

  test('preserves visible Content between a parent and a later nested call', () => {
    const parent = item('parent', 'tool', 'completed', { name: 'tool_call' });
    const answer = item('answer', 'content', 'streaming');
    const child = item('child', 'tool', 'running', { presentation: { parentToolCallId: 'parent' } });
    const projected = projectTurnItems(turn([parent, answer, child]));

    expect(projected).toMatchObject([
      { kind: 'process-summary', items: [parent] },
      { kind: 'content', item: answer },
      { kind: 'live-process', item: child },
    ]);
    expect(projected[2]).not.toHaveProperty('toolDepth');
  });

  test('keeps a nested Widget tool under its caller when the standalone preview appears', () => {
    const parent = item('parent', 'tool', 'running', { name: 'tool_call' });
    const child = item('child', 'tool', 'running', {
      name: 'show_widget', presentation: { parentToolCallId: 'parent' },
    });
    expect(projectTurnItems(turn([parent, child]))).toMatchObject([
      { kind: 'live-process', item: parent, toolDepth: 0 },
      { kind: 'live-process', item: child, toolDepth: 1 },
    ]);

    const finished = {
      ...child,
      status: 'completed',
      output: JSON.stringify({
        kind: 'canvas', view: { id: 'widget-123' },
        presentation: { target: 'assistant_message', sandbox: 'scripts' },
      }),
    } as TurnItem;
    expect(projectTurnItems(turn([parent, finished]))).toMatchObject([
      { kind: 'live-process', item: parent, toolDepth: 0 },
      { kind: 'live-process', item: finished, toolDepth: 1 },
      { kind: 'native-widget', preview: { toolCallId: 'child' } },
    ]);
  });

  test('projects only a validated pending question or structured answer as question history', () => {
    const questions = [{
      id: 'stack',
      question: 'Which stack?',
      options: [{ id: 'react', label: 'React' }, { id: 'vue', label: 'Vue' }],
    }];
    const pending = item('question', 'tool', 'running', {
      name: 'ask_user_question',
      input: { questions },
    });
    const answered = item('answer', 'tool', 'completed', {
      name: 'ask_user_question',
      presentation: { questionResult: {
        version: 1,
        questions,
        response: { status: 'answered', answers: { stack: { selected: ['react'] } } },
      } },
    });

    expect(projectTurnItems(turn([pending, answered]))).toMatchObject([
      { kind: 'question-presentation', item: pending },
      { kind: 'question-presentation', item: answered },
    ]);
    const fallback = projectTurnItems(turn([
      item('malformed', 'tool', 'running', { name: 'ask_user_question', input: { questions: [] } }),
      item('failed', 'tool', 'failed', { name: 'ask_user_question', input: { questions }, error: 'unavailable' }),
      item('old-text', 'tool', 'completed', { name: 'ask_user_question', input: { questions }, output: 'User selected: React' }),
      item('old-name', 'tool', 'running', { name: 'AskUserQuestion', input: { questions } }),
      { ...answered, id: 'failed-stale-answer', status: 'failed' } as TurnItem,
    ]));
    expect(fallback.map(row => row.kind)).toEqual(['live-process', 'question-presentation', 'live-process', 'live-process', 'live-process']);
  });

  test('keeps one working indicator through output and removes it at settlement', () => {
    const activity = {
      runId: 'run-1',
      stage: 'responding' as const,
      startedAt: 1,
      stageChangedAt: 2,
      lastAgentEventAt: 2,
      lastModelActivityAt: 2,
      hasRunningTool: false,
      activeRunConfirmedAt: null,
      probeState: 'idle' as const,
    };
    const active = turn([item('content-1', 'content', 'streaming')]);
    const stalled = projectTurnItems(
      active,
      true,
      { kind: 'slow-active', tone: 'neutral', quietMs: 60_000 },
      activity,
    );
    expect(stalled.map(row => row.kind)).toEqual(['content', 'waiting']);
    expect(stalled[1]).toMatchObject({ notice: { kind: 'slow-active' } });
    expect(projectTurnItems(active, true, null, activity)[1]).not.toHaveProperty('notice');
    expect(projectTurnItems(active, true, null, activity).map(row => row.kind)).toEqual([
      'content',
      'waiting',
    ]);
    expect(projectTurnItems(active, true, null, activity)[1]).toMatchObject({
      startedAt: 1,
      stage: 'responding',
    });
    expect(
      projectTurnItems({ ...active, status: 'final' }, false, null, activity).map(row => row.kind),
    ).toEqual(['content']);
    expect(
      projectTurnItems(active, true, null, { ...activity, runId: 'old-run' }).map(row => row.kind),
    ).toEqual(['content']);
  });
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

  test('keeps Thinking visible through empty, pending, and media-only Content', () => {
    const result = projectTurnItems(
      turn([
        item('think-1', 'thinking', 'completed', { text: 'First distinct thought.' }),
        item('content-empty', 'content', 'completed', { text: '' }),
        item('think-2', 'thinking', 'completed', { text: 'Second distinct thought.' }),
        item('content-pending', 'content', 'streaming', { assistantTextSourcePending: true }),
        item('media', 'content', 'completed', { text: 'MEDIA:E:/output/clip.mp4' }),
      ]),
    );

    expect(result).toMatchObject([
      { kind: 'live-process', key: 'think-1' },
      { kind: 'live-process', key: 'think-2' },
      { kind: 'content', key: 'media' },
    ]);
  });

  test('keeps a Tool visible through completion, then folds it when Content is streamed', () => {
    const first = item('tool-completed', 'tool', 'completed');
    const second = item('tool-running', 'tool', 'running');
    const running = projectTurnItems(
      turn([first, second]),
    );
    const finished = item(second.id, 'tool', 'completed');
    const completed = projectTurnItems(turn([first, finished]));
    const withReply = projectTurnItems(turn([first, finished, item('reply', 'content', 'streaming')]));

    expect(running).toMatchObject([
      { kind: 'live-process', key: first.id, item: first },
      { kind: 'live-process', key: second.id, item: second },
    ]);
    expect(completed).toMatchObject([
      { kind: 'live-process', key: first.id, item: first },
      { kind: 'live-process', key: second.id, item: finished },
    ]);
    expect(withReply).toMatchObject([
      { kind: 'process-summary', toolCount: 2, items: [first, finished] },
      { kind: 'content', key: 'reply' },
    ]);
  });

  test('keeps Thinking visible while streaming and after completion before any Content', () => {
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

    expect(streaming.map(entry => entry.kind)).toEqual(['live-process', 'live-process']);
    expect(streaming[1]).toMatchObject({
      item: { id: 'think-2', text: 'still streaming', status: 'running' },
    });
    expect(completed).toMatchObject([
      { kind: 'live-process', key: 'think-1' },
      { kind: 'live-process', key: 'think-2', item: { status: 'completed', text: 'finished' } },
    ]);
  });

  test('keeps the summary key stable when its count grows', () => {
    const thinking = item('think-1', 'thinking', 'completed');
    const reply = item('reply', 'content', 'streaming');
    const first = projectTurnItems(turn([thinking, item('tool-1', 'tool', 'running'), reply]));
    const second = projectTurnItems(turn([thinking, item('tool-1', 'tool', 'completed'), reply]));

    expect(first[0]).toMatchObject({ kind: 'process-summary', toolCount: 0 });
    expect(second[0]).toMatchObject({ kind: 'process-summary', toolCount: 1 });
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
      'live-process',
      'progress-receipt',
      'live-process',
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

  test('keeps present_plan visible as a standalone plan card', () => {
    const result = projectTurnItems(
      turn([
        item('think-1', 'thinking', 'completed'),
        item('plan-1', 'tool', 'completed', {
          name: 'present_plan',
          input: { title: 'Ship it', plan: '# Plan\n\n1. Implement' },
        }),
        item('tool-1', 'tool', 'completed'),
      ]),
    );

    expect(result.map(entry => entry.kind)).toEqual([
      'live-process',
      'plan-presentation',
      'live-process',
    ]);
    expect(result[1]).toMatchObject({
      kind: 'plan-presentation',
      item: { id: 'plan-1', status: 'completed' },
    });
  });

  test('keeps the terminal banner when earlier Content already folded its matching Tool', () => {
    const result = projectTurnItems(
      turn([
        item('tool-1', 'tool', 'failed', { error: 'command failed' }),
        item('content-1', 'content', 'completed'),
        item('thinking-after-content', 'thinking', 'completed'),
        item('terminal-1', 'terminal', 'error', { message: 'command failed' }),
      ]),
    );

    expect(result).toMatchObject([
      { kind: 'process-summary', errorCount: 1, items: [{ id: 'tool-1' }] },
      { kind: 'content' },
      { kind: 'process-summary', items: [{ id: 'thinking-after-content' }] },
      { kind: 'terminal', item: { message: 'command failed' } },
    ]);
  });

  test('folds before the failed Tool when a terminal error repeats its diagnostic', () => {
    const thinking = item('thinking', 'thinking', 'completed');
    const failed = item('tool-1', 'tool', 'failed', { error: 'command failed' });
    const active = turn([thinking, failed]);

    expect(projectTurnItems(active)).toMatchObject([
      { kind: 'live-process', item: thinking },
      { kind: 'live-process', item: failed },
    ]);
    expect(projectTurnItems({
      ...active,
      status: 'error',
      items: [...active.items, item('terminal-1', 'terminal', 'error', { message: 'command failed' })],
    })).toMatchObject([
      { kind: 'process-summary', items: [thinking] },
      { kind: 'live-process', item: failed },
    ]);
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

    expect(result).toMatchObject([
      { kind: 'process-summary', items: [{ status: 'failed' }] },
      { kind: 'terminal', item: { message: 'provider failover unavailable' } },
    ]);
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

  test('keeps a terminal reason that the failed Tool reader does not display', () => {
    const failure = 'The command could not open the requested file.';
    const result = projectTurnItems(turn([
      item('tool-1', 'tool', 'failed', { output: 'Starting command...', error: failure }),
      item('terminal-1', 'terminal', 'error', { message: failure }),
    ]));

    expect(result).toMatchObject([
      { kind: 'process-summary', items: [{ id: 'tool-1' }] },
      { kind: 'terminal', item: { message: failure } },
    ]);
  });
});
