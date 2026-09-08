import { describe, expect, test } from 'vitest';

import { partitionSubtasks, resolveSubtaskElapsedMs, type Subtask } from './subtaskPresentation';

const subtask = (overrides: Partial<Subtask>): Subtask => ({
  id: 'task-1',
  taskName: 'task-1',
  sessionKey: 'agent:main:subagent:task-1',
  label: 'Research',
  labelSource: 'label',
  status: 'running',
  ...overrides,
});

describe('subtask presentation', () => {
  test('keeps active work ahead of finished history and sorts each group by activity', () => {
    const result = partitionSubtasks([
      subtask({ id: 'done', status: 'done', updatedAt: 500 }),
      subtask({ id: 'older', updatedAt: 100 }),
      subtask({ id: 'newer', updatedAt: 300 }),
    ]);

    expect(result.active.map(item => item.id)).toEqual(['newer', 'older']);
    expect(result.finished.map(item => item.id)).toEqual(['done']);
  });

  test('derives live and terminal elapsed durations without returning negative values', () => {
    expect(resolveSubtaskElapsedMs(subtask({ startedAt: 1_000 }), 4_000)).toBe(3_000);
    expect(
      resolveSubtaskElapsedMs(
        subtask({ status: 'done', startedAt: 1_000, endedAt: 3_500, runtimeMs: 2_400 }),
        9_000,
      ),
    ).toBe(2_400);
    expect(resolveSubtaskElapsedMs(subtask({ startedAt: 5_000 }), 4_000)).toBe(0);
    expect(
      resolveSubtaskElapsedMs(subtask({ status: 'done', startedAt: 1_000 }), 9_000),
    ).toBeUndefined();
  });

  test('bounds finished history while retaining every active task', () => {
    const result = partitionSubtasks([
      subtask({ id: 'active', updatedAt: 1 }),
      ...Array.from({ length: 60 }, (_, index) =>
        subtask({ id: `done-${index}`, status: 'done', updatedAt: index + 2 }),
      ),
    ]);

    expect(result.active.map(item => item.id)).toEqual(['active']);
    expect(result.finished).toHaveLength(50);
    expect(result.finished[0]?.id).toBe('done-59');
  });
});
