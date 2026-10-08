import { afterEach, expect, test, vi } from 'vitest';

import { StreamRenderScheduler } from './stream-render-scheduler';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('publishes at most once for multiple updates in one animation frame', () => {
  let callback: FrameRequestCallback | null = null;
  vi.stubGlobal('requestAnimationFrame', (next: FrameRequestCallback) => {
    callback = next;
    return 1;
  });
  const publish = vi.fn();
  const scheduler = new StreamRenderScheduler(publish);

  scheduler.schedule();
  scheduler.schedule();
  scheduler.schedule();
  expect(publish).not.toHaveBeenCalled();

  const scheduled = callback as FrameRequestCallback | null;
  expect(scheduled).not.toBeNull();
  scheduled?.(16);
  expect(publish).toHaveBeenCalledOnce();
});

test('throttles Tool partials to 80ms and flushes terminal updates immediately', () => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (next: FrameRequestCallback) => {
    next(0);
    return 1;
  });
  const publish = vi.fn();
  let now = 100;
  const scheduler = new StreamRenderScheduler(publish, () => now);

  scheduler.scheduleToolPartial();
  scheduler.scheduleToolPartial();
  expect(publish).toHaveBeenCalledOnce();

  now = 120;
  scheduler.scheduleToolPartial();
  scheduler.scheduleToolPartial();
  expect(publish).toHaveBeenCalledOnce();

  scheduler.flush();
  expect(publish).toHaveBeenCalledTimes(2);

  now = 200;
  vi.advanceTimersByTime(100);
  expect(publish).toHaveBeenCalledTimes(2);
});

test('renders and cancels in the window that owns the scheduled frame', () => {
  const mainFrame = vi.fn(),
    mainCancel = vi.fn();
  const workspaceFrame = vi.fn(() => 7),
    workspaceCancel = vi.fn();
  let host = { requestAnimationFrame: workspaceFrame, cancelAnimationFrame: workspaceCancel };
  const scheduler = new StreamRenderScheduler(vi.fn(), Date.now, () => host);
  scheduler.schedule();
  host = { requestAnimationFrame: mainFrame, cancelAnimationFrame: mainCancel };
  scheduler.dispose();
  expect(workspaceFrame).toHaveBeenCalledOnce();
  expect(workspaceCancel).toHaveBeenCalledWith(7);
  expect(mainFrame).not.toHaveBeenCalled();
  expect(mainCancel).not.toHaveBeenCalled();
});
