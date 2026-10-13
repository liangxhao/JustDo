import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ComputerOverlayController } from './computerOverlayController';

const id = '00000000-0000-0000-0000-000000000001';
const other = '00000000-0000-0000-0000-000000000002';
const activity = (phase: 'start' | 'end' | 'close', extra = {}) => ({
  v: 2,
  execution: id,
  id,
  phase,
  cursor: true,
  click: false,
  ...extra,
});

describe('computer overlay presentation leases', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps short non-click pointer feedback and bridges a thinking gap without hiding', () => {
    const view = { show: vi.fn(), hide: vi.fn() };
    const controller = new ComputerOverlayController(view);
    controller.receive(activity('start'));
    controller.receive(activity('end'));
    expect(view.show).toHaveBeenLastCalledWith(true, false, {
      waiting: true,
      hold: true,
      capture: true,
    });
    vi.advanceTimersByTime(8_000);
    expect(view.hide).not.toHaveBeenCalled();
    controller.receive(activity('start', { id: other, cursor: false }));
    expect(view.show).toHaveBeenLastCalledWith(false, false, {
      waiting: false,
      hold: true,
      capture: false,
    });
    vi.advanceTimersByTime(5_000);
    expect(view.hide).not.toHaveBeenCalled();
    controller.clear();
  });

  it('closes only the matching execution and rejects late start/end events', () => {
    const view = { show: vi.fn(), hide: vi.fn() };
    const controller = new ComputerOverlayController(view);
    controller.receive(activity('start'));
    controller.receive(activity('start', { id: other, execution: other, cursor: false }));
    controller.receive(activity('close', { cursor: false }));
    expect(view.show).toHaveBeenLastCalledWith(
      false,
      false,
      expect.objectContaining({ waiting: false }),
    );
    const count = view.show.mock.calls.length;
    controller.receive(activity('end', { click: true }));
    controller.receive(activity('start'));
    expect(view.show).toHaveBeenCalledTimes(count);
    controller.receive(activity('close', { id: other, execution: other, cursor: false }));
    expect(view.hide).toHaveBeenLastCalledWith(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a close arriving before start fences the whole execution', () => {
    const view = { show: vi.fn(), hide: vi.fn() };
    const controller = new ComputerOverlayController(view);
    controller.receive(activity('close', { cursor: false }));
    controller.receive(activity('start', { id: other }));
    expect(view.show).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('tracks admitted work and retires it after click feedback', () => {
    const view = { show: vi.fn(), hide: vi.fn() };
    const controller = new ComputerOverlayController(view);
    controller.receive(activity('start'), 1);
    expect(view.show).toHaveBeenLastCalledWith(true, false, expect.any(Object));
    controller.receive(activity('end', { click: true }), 2);
    expect(view.show).toHaveBeenLastCalledWith(true, true, expect.any(Object));
    vi.advanceTimersByTime(3_999);
    expect(view.show).toHaveBeenLastCalledWith(true, true, expect.any(Object));
    vi.advanceTimersByTime(1);
    expect(view.hide).not.toHaveBeenCalled();
    expect(view.show).toHaveBeenLastCalledWith(false, false, {
      waiting: true,
      hold: true,
      capture: false,
    });
    vi.advanceTimersByTime(8_000);
    expect(view.hide).toHaveBeenCalledOnce();
    controller.receive(activity('start'), 3);
    expect(view.show).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('expires dropped terminals and accepts heartbeats only before expiry', () => {
    const view = { show: vi.fn(), hide: vi.fn() };
    const controller = new ComputerOverlayController(view);
    controller.receive(activity('start'));
    vi.advanceTimersByTime(10_000);
    controller.receive(activity('start'));
    vi.advanceTimersByTime(10_000);
    expect(view.hide).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5_000);
    expect(view.hide).toHaveBeenCalledOnce();
    controller.receive(activity('start'));
    expect(view.show).toHaveBeenCalledTimes(2);
  });

  it('does not let one terminal hide other in-flight work or revive an older frame', () => {
    const view = { show: vi.fn(), hide: vi.fn() };
    const controller = new ComputerOverlayController(view);
    controller.receive(activity('start'), 3);
    controller.receive(activity('start', { id: other, cursor: false }), 4);
    controller.receive(activity('end'), 5);
    expect(view.show).toHaveBeenLastCalledWith(
      true,
      false,
      expect.objectContaining({ waiting: false, hold: true }),
    );
    controller.receive(activity('end', { id: other }), 4);
    vi.advanceTimersByTime(700);
    expect(view.hide).not.toHaveBeenCalled();
    controller.clear();
    expect(view.hide).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    controller.receive(activity('start'), 1);
    expect(view.show).toHaveBeenLastCalledWith(true, false, expect.any(Object));
    controller.clear();
  });

  it('ends click feedback while retaining the badge for background work', () => {
    const view = { show: vi.fn(), hide: vi.fn() };
    const controller = new ComputerOverlayController(view);
    controller.receive(activity('start'));
    controller.receive(activity('start', { id: other, cursor: false }));
    controller.receive(activity('end', { click: true }));
    expect(view.show).toHaveBeenLastCalledWith(true, true, expect.any(Object));
    vi.advanceTimersByTime(4_000);
    expect(view.show).toHaveBeenLastCalledWith(false, false, expect.any(Object));
    expect(view.hide).not.toHaveBeenCalled();
    controller.clear();
  });

  it('rejects malformed metadata and end-only events without rendering', () => {
    const view = { show: vi.fn(), hide: vi.fn() };
    const controller = new ComputerOverlayController(view);
    for (const payload of [
      null,
      {},
      activity('start', { id: 'untrusted' }),
      activity('start', { click: true }),
      activity('end', { cursor: false, click: true }),
      activity('start', { v: 1 }),
      activity('end'),
    ])
      controller.receive(payload);
    expect(view.show).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a new action cancels pending fade-out and clear cancels all callbacks', () => {
    const view = { show: vi.fn(), hide: vi.fn() };
    const controller = new ComputerOverlayController(view);
    controller.receive(activity('start'));
    controller.receive(activity('end'));
    controller.receive(activity('start', { id: other }));
    vi.advanceTimersByTime(700);
    expect(view.hide).not.toHaveBeenCalled();
    controller.clear();
    vi.advanceTimersByTime(60_000);
    expect(view.hide).toHaveBeenCalledOnce();
  });
});
