import type { ScheduledTaskResult } from '@shared/scheduledTask/types';
import { describe, expect, test } from 'vitest';

import reducer, {
  markAllResultsReadLocal,
  markResultReadLocal,
  removeResultLocal,
  replaceResults,
  setResultFilter,
  upsertResult,
} from './scheduledTaskSlice';

function result(id: string, taskId = 'task-1', readAt: string | null = null) {
  return {
    id,
    taskId,
    taskName: 'Task',
    sessionId: null,
    sessionKey: null,
    status: 'success',
    summary: id,
    startedAt: `2026-07-28T10:00:0${id}.000Z`,
    finishedAt: `2026-07-28T10:00:0${id}.000Z`,
    durationMs: 1,
    error: null,
    deliveryStatus: null,
    deliveryError: null,
    observedAt: `2026-07-28T10:00:0${id}.000Z`,
    readAt,
  } satisfies ScheduledTaskResult;
}

describe('scheduledTask result filtering', () => {
  test('a first page replaces stale results from the previous query', () => {
    let state = reducer(undefined, replaceResults({ results: [result('1')], nextCursor: null }));
    state = reducer(
      state,
      replaceResults({ results: [result('2', 'task-2')], nextCursor: null }),
    );

    expect(state.results.map(item => item.id)).toEqual(['2']);
  });

  test('removes read results while unread-only is active', () => {
    let state = reducer(undefined, setResultFilter({ taskId: null, unreadOnly: true }));
    state = reducer(state, upsertResult(result('1')));
    state = reducer(state, markResultReadLocal('1'));
    expect(state.results).toEqual([]);

    state = reducer(state, upsertResult(result('2')));
    state = reducer(state, markAllResultsReadLocal(undefined));
    expect(state.results).toEqual([]);
  });

  test('does not insert a realtime result that misses the current filter', () => {
    let state = reducer(undefined, setResultFilter({ taskId: 'task-1', unreadOnly: true }));
    state = reducer(state, upsertResult(result('1', 'task-2')));
    state = reducer(state, upsertResult(result('2', 'task-1', new Date().toISOString())));

    expect(state.results).toEqual([]);
  });

  test('removes a deleted result from the current page', () => {
    let state = reducer(
      undefined,
      replaceResults({ results: [result('1'), result('2')], nextCursor: 'next' }),
    );
    state = reducer(state, removeResultLocal('2'));

    expect(state.results.map(item => item.id)).toEqual(['1']);
    expect(state.resultsNextCursor).toBe('next');
  });
});
