import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockWindow = {
  options: unknown;
  destroyed: boolean;
  webContents: EventEmitter & {
    executeJavaScript: ReturnType<typeof vi.fn<(script: string) => Promise<void>>>;
  };
  showInactive: ReturnType<typeof vi.fn>;
  setContentProtection: ReturnType<typeof vi.fn>;
  setIgnoreMouseEvents: ReturnType<typeof vi.fn>;
};
type MockDisplay = {
  id: number;
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
};
const mocks = vi.hoisted(() => ({
  windows: [] as MockWindow[],
  displays: [] as MockDisplay[],
  cursor: { x: 0, y: 0 },
}));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class Window extends EventEmitter {
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: vi.fn(),
      executeJavaScript: vi.fn(async (_script: string) => {}),
    });
    setContentProtection = vi.fn();
    setIgnoreMouseEvents = vi.fn();
    setAlwaysOnTop = vi.fn();
    setBounds = vi.fn();
    showInactive = vi.fn();
    hide = vi.fn();
    loadURL = vi.fn(async () => {});
    destroy = vi.fn(() => {
      this.destroyed = true;
    });
    isDestroyed = () => this.destroyed;
    constructor(public options: unknown) {
      super();
      mocks.windows.push(this);
    }
  }
  return {
    BrowserWindow: Window,
    screen: Object.assign(new EventEmitter(), {
      getAllDisplays: () => mocks.displays,
      getPrimaryDisplay: () => mocks.displays[0],
      getCursorScreenPoint: () => mocks.cursor,
    }),
    session: {
      fromPartition: () => ({
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
      }),
    },
  };
});

import { screen } from 'electron';

import { ComputerOverlayWindow } from './computerOverlayWindow';

const flush = async () => {
  for (let index = 0; index < 8; ++index) await Promise.resolve();
};
const lastFrame = (window: MockWindow) =>
  JSON.parse(window.webContents.executeJavaScript.mock.lastCall![0].match(/\((.*)\)$/)![1]);

describe('Windows desktop drawing surfaces', () => {
  it('allows remote preview only when enabled and restores protection on reused surfaces', async () => {
    let preview = false;
    const view = new ComputerOverlayWindow(() => preview);
    view.prepare();
    await flush();
    expect(
      mocks.windows.every(window => window.setContentProtection.mock.lastCall?.[0] === true),
    ).toBe(true);
    preview = true;
    view.show(true, false);
    await flush();
    expect(
      mocks.windows.every(window => window.setContentProtection.mock.lastCall?.[0] === false),
    ).toBe(true);
    (screen as unknown as EventEmitter).emit('display-metrics-changed');
    await flush();
    expect(
      mocks.windows
        .filter(window => !window.destroyed)
        .every(window => window.setContentProtection.mock.lastCall?.[0] === false),
    ).toBe(true);
    preview = false;
    view.show(false, false);
    expect(
      mocks.windows
        .filter(window => !window.destroyed)
        .every(window => window.setContentProtection.mock.lastCall?.[0] === true),
    ).toBe(true);
    view.dispose();
  });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'process',
      Object.defineProperty(Object.create(process), 'platform', { value: 'win32' }),
    );
    mocks.windows = [];
    mocks.displays = [
      { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1.25 },
      { id: 2, bounds: { x: -1280, y: -100, width: 1280, height: 900 }, scaleFactor: 2 },
    ];
    mocks.cursor = { x: -100, y: 120 };
  });
  afterEach(() => {
    (screen as unknown as EventEmitter).removeAllListeners();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('warms hidden windows, reuses them, and freezes end feedback at the sampled point', async () => {
    const view = new ComputerOverlayWindow();
    view.prepare();
    await flush();
    expect(mocks.windows.every(window => !window.showInactive.mock.calls.length)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    view.show(true, false);
    await flush();
    mocks.cursor = { x: 450, y: 300 };
    view.show(true, true, { waiting: true, hold: true, capture: true });
    await flush();
    mocks.cursor = { x: 900, y: 600 };
    vi.advanceTimersByTime(200);
    expect(lastFrame(mocks.windows[0])).toMatchObject({ x: 450, y: 300, waiting: true, pulse: 1 });
    expect(vi.getTimerCount()).toBe(0);
    view.hide();
    expect(mocks.windows.every(window => !window.destroyed)).toBe(true);
    view.show(false, false);
    await flush();
    expect(mocks.windows).toHaveLength(2);
    expect(lastFrame(mocks.windows[0])).toMatchObject({ cursor: false, pulse: 1 });
    view.dispose();
    expect(mocks.windows.every(window => window.destroyed)).toBe(true);
  });

  it('cancels an in-progress fade when another action starts', async () => {
    const view = new ComputerOverlayWindow();
    view.show(false, false);
    await flush();
    view.hide(true);
    await flush();
    expect(lastFrame(mocks.windows[0]).visible).toBe(false);
    vi.advanceTimersByTime(100);
    view.show(true, false);
    await flush();
    vi.advanceTimersByTime(100);
    expect(lastFrame(mocks.windows[0]).visible).toBe(true);
    expect(mocks.windows).toHaveLength(2);
    view.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows a current painted frame even when rendering is slower than pointer polling', async () => {
    const view = new ComputerOverlayWindow();
    view.prepare();
    await flush();
    for (const window of mocks.windows) {
      window.webContents.executeJavaScript.mockImplementation(
        () => new Promise(resolve => setTimeout(resolve, 50)),
      );
    }
    view.show(true, false);
    await vi.advanceTimersByTimeAsync(120);
    expect(mocks.windows.every(window => window.showInactive.mock.calls.length === 1)).toBe(true);
    view.dispose();
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.windows.every(window => window.destroyed)).toBe(true);
  });

  it('keeps click coordinates independent when a subsequent pointer frame replaces the queue', async () => {
    const view = new ComputerOverlayWindow();
    view.show(true, false);
    await flush();
    const window = mocks.windows[0];
    let finish!: () => void;
    window.webContents.executeJavaScript.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    vi.advanceTimersByTime(33);
    mocks.cursor = { x: -200, y: 250 };
    view.show(true, true, { waiting: true, hold: true, capture: true });
    mocks.cursor = { x: 500, y: 300 };
    view.show(true, false);
    finish();
    await flush();
    expect(lastFrame(window)).toMatchObject({
      x: 500,
      y: 300,
      pulseX: -200,
      pulseY: 250,
      pulseHere: false,
    });
    expect(lastFrame(mocks.windows[1])).toMatchObject({
      pulseX: 1080,
      pulseY: 350,
      pulseHere: true,
    });
    view.dispose();
  });

  it('does not replay an undisplayed pending click after hiding and reusing the surface', async () => {
    const view = new ComputerOverlayWindow();
    view.show(true, false);
    await flush();
    const window = mocks.windows[0];
    let finish!: () => void;
    window.webContents.executeJavaScript.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    vi.advanceTimersByTime(33);
    mocks.cursor = { x: 300, y: 200 };
    view.show(true, true, { waiting: true, hold: true, capture: true });
    view.hide();
    view.show(false, false);
    finish();
    await flush();
    expect(lastFrame(window)).toMatchObject({ pulse: 1, pulseHere: false });
    view.dispose();
  });

  it('protects capture before display, passes input through and uses DIP coordinates across monitors', async () => {
    const view = new ComputerOverlayWindow();
    view.show(true, false);
    await flush();
    expect(mocks.windows).toHaveLength(2);
    for (const window of mocks.windows) {
      expect(window.options).toMatchObject({
        focusable: false,
        skipTaskbar: true,
        transparent: true,
        webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
      });
      expect(window.setIgnoreMouseEvents).toHaveBeenCalledWith(true);
      expect(window.setContentProtection).toHaveBeenCalledWith(true);
      expect(window.setContentProtection.mock.invocationCallOrder[0]).toBeLessThan(
        window.showInactive.mock.invocationCallOrder[0],
      );
    }
    expect(lastFrame(mocks.windows[0])).toMatchObject({ cursor: false, badge: true });
    expect(lastFrame(mocks.windows[1])).toMatchObject({
      cursor: true,
      badge: false,
      x: 1180,
      y: 220,
    });
    view.dispose();
    expect(mocks.windows.every(window => window.destroyed)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not poll the physical pointer for background work or resurrect an unloaded surface', async () => {
    const view = new ComputerOverlayWindow();
    view.show(false, false);
    view.hide();
    await flush();
    expect(mocks.windows.every(window => !window.showInactive.mock.calls.length)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    view.show(false, false);
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    view.dispose();
  });

  it('coalesces a slow renderer without losing the final hidden-cursor frame or spinning', async () => {
    const view = new ComputerOverlayWindow();
    view.show(true, false);
    await flush();
    const window = mocks.windows[0];
    let finish!: () => void;
    window.webContents.executeJavaScript.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        }),
    );
    vi.advanceTimersByTime(33);
    view.show(false, false);
    expect(vi.getTimerCount()).toBe(0);
    finish();
    await flush();
    expect(lastFrame(window).cursor).toBe(false);
    const count = window.webContents.executeJavaScript.mock.calls.length;
    await flush();
    expect(window.webContents.executeJavaScript).toHaveBeenCalledTimes(count);
    view.dispose();
  });

  it('does not replay an old click when a new surface loads', async () => {
    const view = new ComputerOverlayWindow();
    view.show(true, false);
    await flush();
    view.show(true, true);
    await flush();
    expect(lastFrame(mocks.windows[0]).pulse).toBe(1);
    (screen as unknown as EventEmitter).emit('display-metrics-changed');
    await flush();
    expect(lastFrame(mocks.windows.at(-1)!).pulse).toBe(0);
    view.hide();
    view.show(true, false);
    await flush();
    expect(lastFrame(mocks.windows.at(-1)!).pulse).toBe(0);
    view.show(true, true);
    await flush();
    expect(lastFrame(mocks.windows.at(-1)!).pulse).toBe(1);
    view.dispose();
  });

  it('rebuilds for display changes and clears every surface after renderer failure', async () => {
    const view = new ComputerOverlayWindow();
    view.show(true, false);
    await flush();
    const previous = [...mocks.windows];
    (screen as unknown as EventEmitter).emit('display-metrics-changed');
    await flush();
    expect(previous.every(window => window.destroyed)).toBe(true);
    mocks.windows.at(-1)!.webContents.emit('render-process-gone');
    expect(mocks.windows.every(window => window.destroyed)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
