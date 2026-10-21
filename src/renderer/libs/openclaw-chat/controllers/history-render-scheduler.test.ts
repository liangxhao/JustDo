import { expect, test, vi } from 'vitest';

import { HistoryRenderScheduler } from './history-render-scheduler';

const rows = (start: number, end: number) =>
  Array.from({ length: end - start }, (_, index) => ({ item: { key: `row-${start + index}` } }));

function setup() {
  let nextId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const update = vi.fn();
  const scheduler = new HistoryRenderScheduler<ReturnType<typeof rows>[number]>(() => {
    if (frames.size > 0) return;
    frames.set(++nextId, () => {
      scheduler.beginFrame();
      update();
    });
  });
  const commit = (duration = 4) => scheduler.afterCommit(duration);
  const frame = () => {
    const [id, callback] = frames.entries().next().value!;
    frames.delete(id);
    callback(0);
  };
  return { scheduler, update, frames, commit, frame };
}

test('prepends a page in bounded commits from the retained anchor towards older content', async () => {
  const { scheduler, commit, frame, update } = setup();
  const tail = rows(100, 150);
  expect(scheduler.select(tail, 'session-1')).toBe(tail);
  commit();
  const target = rows(0, 150);
  const first = scheduler.select(target, 'session-1');
  expect(first).toHaveLength(58);
  expect(first[0].item.key).toBe('row-92');
  let completed = false;
  const complete = scheduler.complete.then(() => {
    completed = true;
  });
  commit();
  expect(completed).toBe(false);
  while (scheduler.isPending) {
    const before = scheduler.rows.length;
    frame();
    const current = scheduler.select(target, 'session-1');
    expect(current.length - before).toBeLessThanOrEqual(8);
    expect(current.slice(-50)).toEqual(tail);
    commit();
  }
  await complete;
  expect(completed).toBe(true);
  expect(scheduler.rows).toBe(target);
  expect(update).toHaveBeenCalled();
});

test('supersedes an unfinished older page with newer navigation and never commits retired rows', () => {
  const { scheduler, frames, commit, frame } = setup();
  scheduler.select(rows(100, 150), 'session');
  commit();
  scheduler.select(rows(0, 150), 'session');
  commit();
  const newer = rows(100, 200);
  scheduler.select(newer, 'session');
  expect(frames.size).toBe(1);
  commit();
  while (scheduler.isPending) {
    frame();
    scheduler.select(newer, 'session');
    commit();
  }
  expect(scheduler.rows).toBe(newer);
  expect(scheduler.rows.some(row => Number(row.item.key.slice(4)) < 100)).toBe(false);
});

test('cancels pending commits on native scope replacement or disconnect', async () => {
  const { scheduler, frames, commit } = setup();
  scheduler.select(rows(100, 150), 'session');
  commit();
  scheduler.select(rows(0, 150), 'session');
  commit();
  const oldCompletion = scheduler.complete;
  const replacement = rows(300, 310);
  expect(scheduler.select(replacement, 'new-incarnation')).toBe(replacement);
  expect(frames.size).toBe(1);
  const [, retiredFrame] = frames.entries().next().value!;
  retiredFrame(0);
  expect(scheduler.select(replacement, 'new-incarnation')).toBe(replacement);
  await oldCompletion;
  scheduler.clear();
  expect(scheduler.rows).toEqual([]);
  expect(scheduler.isPending).toBe(false);
});

test('reduces batch size after an expensive commit and can materialize the target for search', () => {
  const { scheduler, commit, frame } = setup();
  scheduler.select(rows(100, 150), 'session');
  commit(4);
  const target = rows(0, 150);
  scheduler.select(target, 'session');
  commit(24);
  const before = scheduler.rows.length;
  frame();
  scheduler.select(target, 'session');
  expect(scheduler.rows.length - before).toBe(4);
  expect(scheduler.select(target, 'session', true)).toBe(target);
  expect(scheduler.isPending).toBe(false);
});
