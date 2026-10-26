import { EventEmitter } from 'node:events';

import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { STARTUP_WINDOW_FADE_MS, StartupWindowHandoff } from './startupWindowHandoff';

class WindowFixture extends EventEmitter {
  visible = false;
  destroyed = false;
  minimized = false;
  maximized = false;
  opacity = 1;
  bounds = { x: 60, y: 80, width: 1280, height: 815 };
  normalBounds?: { x: number; y: number; width: number; height: number };
  isDestroyed = () => this.destroyed;
  isVisible = () => this.visible;
  isMinimized = () => this.minimized;
  isMaximized = () => this.maximized;
  getBounds = () => ({ ...this.bounds });
  getNormalBounds = () => ({ ...(this.normalBounds ?? this.bounds) });
  setBounds = vi.fn((bounds: typeof this.bounds) => { this.bounds = { ...bounds }; });
  setOpacity = vi.fn((opacity: number) => { this.opacity = opacity; });
  show = vi.fn(() => { this.visible = true; });
  minimize = vi.fn(() => { this.minimized = true; });
  maximize = vi.fn(() => { this.maximized = true; this.visible = true; });
  close = vi.fn(() => { this.visible = false; this.destroyed = true; this.emit('closed'); });
  native = () => this as unknown as BrowserWindow;
}

function fixture() {
  let allowed = true;
  let quitting = false;
  const cancelled = vi.fn();
  const owner = new StartupWindowHandoff({ platform: 'win32', canShow: () => allowed,
    isQuitting: () => quitting, onCancelled: cancelled });
  const source = new WindowFixture();
  owner.setBootstrap(source.native());
  const target = new WindowFixture();
  return { owner, source, target, cancelled,
    hideLaunch: () => { allowed = false; }, quit: () => { quitting = true; owner.stop(); } };
}

beforeEach(() => vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] }));
afterEach(() => vi.useRealTimers());

test('keeps the old window opaque until the painted successor finishes its native fade at the same position', () => {
  const f = fixture();
  f.owner.showBootstrap(f.source.native());
  f.owner.prepare(f.target.native());
  expect(f.target.opacity).toBe(0);
  expect(f.target.show).not.toHaveBeenCalled();
  f.source.bounds.x = 250;
  f.owner.present(f.target.native());
  expect(f.target.bounds).toEqual(f.source.bounds);
  expect(f.target.show).toHaveBeenCalledOnce();
  expect(f.source.opacity).toBe(1);
  vi.advanceTimersByTime(STARTUP_WINDOW_FADE_MS / 2);
  expect(f.target.opacity).toBeGreaterThan(0);
  expect(f.target.opacity).toBeLessThan(1);
  expect(f.source.close).not.toHaveBeenCalled();
  vi.advanceTimersByTime(STARTUP_WINDOW_FADE_MS);
  expect(f.target.opacity).toBe(1);
  expect(f.source.close).toHaveBeenCalledOnce();
  f.target.close();
  expect(f.cancelled).not.toHaveBeenCalled();
});

test('does not flash a retired bootstrap when its ready event arrives after the successor', () => {
  const f = fixture();
  f.owner.prepare(f.target.native());
  f.owner.present(f.target.native());
  f.owner.showBootstrap(f.source.native());
  expect(f.source.show).not.toHaveBeenCalled();
  expect(f.source.close).toHaveBeenCalledOnce();
  expect(f.target.opacity).toBe(1);
  expect(f.target.show).toHaveBeenCalledOnce();
});

test('preserves hidden automatic startup without starting a native fade or showing either window', () => {
  const f = fixture();
  f.hideLaunch();
  f.owner.showBootstrap(f.source.native());
  f.owner.prepare(f.target.native());
  f.owner.present(f.target.native());
  vi.runAllTimers();
  expect(f.source.show).not.toHaveBeenCalled();
  expect(f.target.show).not.toHaveBeenCalled();
  expect(f.target.opacity).toBe(1);
  expect(f.source.close).toHaveBeenCalledOnce();
});

test('continues an explicit opening during automatic startup instead of hiding its successor again', () => {
  const f = fixture();
  f.hideLaunch();
  f.owner.showCurrent();
  expect(f.source.visible).toBe(true);
  f.owner.prepare(f.target.native());
  f.owner.present(f.target.native());
  vi.advanceTimersByTime(STARTUP_WINDOW_FADE_MS);
  expect(f.target.visible).toBe(true);
  expect(f.target.opacity).toBe(1);
  expect(f.source.close).toHaveBeenCalledOnce();
});

test('retains an explicit opening of the prepared target during automatic startup', () => {
  const f = fixture();
  f.hideLaunch();
  f.owner.prepare(f.target.native());
  f.target.show();
  f.owner.present(f.target.native());
  expect(f.target.visible).toBe(true);
  expect(f.target.opacity).toBe(1);
  expect(f.source.close).toHaveBeenCalledOnce();
});

test('inherits a minimized source without showing its successor in the foreground', () => {
  const f = fixture();
  f.owner.showBootstrap(f.source.native());
  f.source.minimize();
  f.owner.prepare(f.target.native());
  f.owner.present(f.target.native());
  vi.runAllTimers();
  expect(f.target.minimize).toHaveBeenCalledOnce();
  expect(f.target.show).not.toHaveBeenCalled();
  expect(f.target.opacity).toBe(1);
  expect(f.source.close).toHaveBeenCalledOnce();
  f.owner.present(f.target.native());
  expect(f.target.show).not.toHaveBeenCalled();
  expect(f.cancelled).not.toHaveBeenCalled();
});

test('inherits native maximization before fading without treating maximization as startup readiness', () => {
  const f = fixture();
  f.owner.showBootstrap(f.source.native());
  f.source.maximize();
  f.source.normalBounds = { x: 80, y: 100, width: 1000, height: 700 };
  f.source.bounds = { x: 0, y: 0, width: 1920, height: 1080 };
  f.owner.prepare(f.target.native());
  expect(f.target.maximize).not.toHaveBeenCalled();
  f.owner.present(f.target.native());
  expect(f.target.isMaximized()).toBe(true);
  expect(f.target.getNormalBounds()).toEqual(f.source.normalBounds);
  expect(f.target.opacity).toBeLessThan(1);
  expect(f.source.close).not.toHaveBeenCalled();
  vi.advanceTimersByTime(STARTUP_WINDOW_FADE_MS);
  expect(f.source.close).toHaveBeenCalledOnce();
});

test('preserves a newer explicit target opening over the source minimized state and geometry', () => {
  const f = fixture();
  f.hideLaunch();
  f.owner.showCurrent();
  f.source.minimize();
  f.owner.prepare(f.target.native());
  f.target.show();
  f.target.bounds.x = 400;
  f.owner.present(f.target.native());
  expect(f.target.minimize).not.toHaveBeenCalled();
  expect(f.target.visible).toBe(true);
  expect(f.target.bounds.x).toBe(400);
  expect(f.target.opacity).toBe(1);
  expect(f.source.close).toHaveBeenCalledOnce();
});

test('does not implicitly show a hidden automatic startup by inheriting maximization', () => {
  const f = fixture();
  f.hideLaunch();
  f.source.maximized = true;
  f.owner.prepare(f.target.native());
  f.owner.present(f.target.native());
  expect(f.target.maximize).not.toHaveBeenCalled();
  expect(f.target.show).not.toHaveBeenCalled();
  expect(f.target.visible).toBe(false);
});

test.each(['source', 'target'] as const)('cancels a pending handoff when the user closes its %s', which => {
  const f = fixture();
  f.owner.showBootstrap(f.source.native());
  f.owner.prepare(f.target.native());
  f[which].close();
  f.owner.present(f.target.native());
  f.owner.showBootstrap(f.source.native());
  expect(f.cancelled).toHaveBeenCalledOnce();
  expect(f.target.show).not.toHaveBeenCalled();
});

test('quit during a fade cancels its timer and prevents late show callbacks from restoring a window', () => {
  const f = fixture();
  f.owner.showBootstrap(f.source.native());
  f.owner.prepare(f.target.native());
  f.owner.present(f.target.native());
  vi.advanceTimersByTime(32);
  f.quit();
  f.source.visible = false;
  f.target.visible = false;
  const opacityCalls = f.target.setOpacity.mock.calls.length;
  f.owner.present(f.target.native());
  f.owner.showBootstrap(f.source.native());
  vi.runAllTimers();
  expect(f.target.setOpacity).toHaveBeenCalledTimes(opacityCalls);
  expect(f.target.show).toHaveBeenCalledOnce();
  expect(f.source.show).toHaveBeenCalledOnce();
  expect(f.target.visible).toBe(false);
});

test('joins an overlapping transient handoff before fading to the main window and carries one visual clock', () => {
  const f = fixture();
  vi.advanceTimersByTime(30_000);
  const startedAt = f.owner.getEntryStartedAt();
  expect(startedAt).toBe(Date.now());
  f.owner.showBootstrap(f.source.native());
  f.owner.prepare(f.target.native(), false);
  f.owner.present(f.target.native());
  vi.advanceTimersByTime(80);
  const main = new WindowFixture();
  f.owner.prepare(main.native());
  f.owner.present(main.native());
  expect(f.source.close).toHaveBeenCalledOnce();
  expect(f.target.opacity).toBe(1);
  vi.advanceTimersByTime(STARTUP_WINDOW_FADE_MS);
  expect(f.target.close).toHaveBeenCalledOnce();
  expect(main.opacity).toBe(1);
  expect(f.cancelled).not.toHaveBeenCalled();
  expect(f.owner.getEntryStartedAt()).toBe(startedAt);
});
