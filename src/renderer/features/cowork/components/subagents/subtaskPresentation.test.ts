import { describe, expect, test } from 'vitest';

import {
  mergeSubtaskSnapshots,
  partitionSubtasks,
  resolveSubtaskElapsedMs,
  type Subtask,
} from './subtaskPresentation';

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

  test('clears terminal fields when a newer snapshot reactivates a task', () => {
    const result = mergeSubtaskSnapshots(
      subtask({
        status: 'failed',
        updatedAt: 100,
        endedAt: 90,
        runtimeMs: 50,
        terminalSummary: 'Old result',
        error: 'Old failure',
      }),
      subtask({ status: 'running', updatedAt: 200, runtimeMs: 75 }),
    );

    expect(result).toMatchObject({ status: 'running', runtimeMs: 75 });
    expect(result.endedAt).toBeUndefined();
    expect(result.terminalSummary).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  test('does not let an older detail snapshot roll lifecycle state backward', () => {
    const result = mergeSubtaskSnapshots(
      subtask({ status: 'done', updatedAt: 300, endedAt: 290 }),
      subtask({ status: 'running', updatedAt: 200, task: 'Complete prompt' }),
    );

    expect(result).toMatchObject({
      status: 'done',
      updatedAt: 300,
      endedAt: 290,
      task: 'Complete prompt',
    });
  });

  test('uses the session-projected runtime for an active reactivated task', () => {
    expect(
      resolveSubtaskElapsedMs(
        subtask({
          status: 'running',
          startedAt: 1_000,
          runtimeMs: 2_500,
          runtimeSampledAt: 8_000,
        }),
        10_000,
      ),
    ).toBe(4_500);
  });

  test('does not count queued wait time toward accumulated runtime', () => {
    expect(
      resolveSubtaskElapsedMs(
        subtask({ status: 'pending', runtimeMs: 2_500, runtimeSampledAt: 8_000 }),
        10_000,
      ),
    ).toBe(2_500);
    expect(
      resolveSubtaskElapsedMs(
        subtask({ status: 'pending', startedAt: 1_000, runtimeMs: undefined }),
        10_000,
      ),
    ).toBeUndefined();
  });

  test('uses local request order when lifecycle timestamps are equal', () => {
    const result = mergeSubtaskSnapshots(
      subtask({
        status: 'running',
        updatedAt: 200,
        lifecycleRequestSequence: 2,
      }),
      subtask({
        status: 'done',
        updatedAt: 200,
        endedAt: 200,
        lifecycleRequestSequence: 1,
      }),
    );

    expect(result.status).toBe('running');
    expect(result.lifecycleRequestSequence).toBe(2);
  });
});
