import { EventEmitter } from 'node:events';

import { expect, test, vi } from 'vitest';

const native = vi.hoisted(() => ({ views: [] as unknown[] }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class View {
    children: View[] = [];
    bounds = { x: 0, y: 0, width: 0, height: 0 };
    visible = true;
    addChildView(view: View) {
      this.children.push(view);
    }
    removeChildView(view: View) {
      this.children = this.children.filter(child => child !== view);
    }
    setBounds(bounds: typeof this.bounds) {
      this.bounds = bounds;
    }
    setVisible(visible: boolean) {
      this.visible = visible;
    }
  }
  class WebContentsView extends View {
    webContents = Object.assign(new EventEmitter(), {
      id: native.views.length + 800,
      destroyed: false,
      setBackgroundThrottling: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      setZoomFactor: vi.fn(),
      isDestroyed() {
        return this.destroyed;
      },
      close: vi.fn(() => {
        this.webContents.destroyed = true;
        this.webContents.emit('destroyed');
      }),
    });
    constructor() {
      super();
      native.views.push(this);
    }
  }
  return { screen: { on: vi.fn(), off: vi.fn() }, View, WebContentsView };
});
vi.mock('./workspaceSurfaceManager', () => ({
  WorkspaceSurfaceManager: class {
    handleOpen() {
      return null;
    }
    applyLayout() {}
    suspendWorkspace() {}
    closeAll() {}
  },
}));

import { View } from 'electron';

import { WorkspaceWindowManager } from './workspaceWindowManager';

test('assigns only the media preload to the precisely granted workspace window', () => {
  const owner = Object.assign(new EventEmitter(), {
    webContents: Object.assign(new EventEmitter(), { id: 700 }),
  });
  const manager = new WorkspaceWindowManager(owner as never, {
    url: 'http://127.0.0.1:1234/workspace.html',
    mediaPlaybackPreloadPath: '/mediaPlaybackPreload.js',
    getBackgroundColor: () => '#fff',
    getTitleBarOverlay: () => ({}),
    isMac: false,
    isWindows: true,
    isQuitting: () => false,
    showSystemMenu: vi.fn(),
    configureHost: vi.fn(),
    openExternal: vi.fn(),
    readBounds: vi.fn(),
    saveBounds: vi.fn(),
  });
  const grant = manager.prepare();
  const details = { url: grant.url, frameName: grant.frameName };
  expect(manager.handleOpen({ ...details, frameName: 'untrusted' } as never)).toBeNull();
  expect(manager.handleOpen(details as never)).toMatchObject({
    overrideBrowserWindowOptions: {
      webPreferences: {
        preload: '/mediaPlaybackPreload.js',
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    },
  });
});

test('retains hidden workspace viewport geometry without making the native presentation visible', () => {
  const owner = Object.assign(new EventEmitter(), {
    webContents: Object.assign(new EventEmitter(), {
      id: 701,
      getZoomFactor: () => 1,
      isDestroyed: () => false,
      isCrashed: () => false,
      send: vi.fn(),
    }),
    getContentSize: vi.fn(() => [1000, 800]),
    isDestroyed: () => false,
    contentView: new View(),
  });
  const manager = new WorkspaceWindowManager(owner as never, {
    url: 'http://127.0.0.1:1234/workspace.html',
    mediaPlaybackPreloadPath: '/mediaPlaybackPreload.js',
    getBackgroundColor: () => '#fff',
    getTitleBarOverlay: () => ({}),
    isMac: false,
    isWindows: true,
    isQuitting: () => false,
    showSystemMenu: vi.fn(),
    configureHost: vi.fn(),
    openExternal: vi.fn(),
    readBounds: vi.fn(),
    saveBounds: vi.fn(),
  });
  type NativeView = View & {
    bounds: { x: number; y: number; width: number; height: number };
    visible: boolean;
  };
  type Carrier = NativeView & { webContents: EventEmitter & { destroyed: boolean } };
  const open = () => {
    const grant = manager.prepare();
    const response = manager.handleOpen({ url: grant.url, frameName: grant.frameName } as never)!;
    if (response.action !== 'allow' || !response.createWindow)
      throw new Error('Missing workspace view');
    response.createWindow({});
    return {
      grant,
      view: native.views.at(-1) as Carrier,
      root: owner.contentView.children[0] as NativeView,
    };
  };
  try {
    const first = open();
    expect(first.root.visible).toBe(false);
    expect(first.view.bounds).toEqual({ x: 0, y: 0, width: 1000, height: 800 });
    const visible = {
      generation: first.grant.generation,
      x: 100,
      y: 50,
      width: 420,
      height: 600,
      visible: true,
      occluded: false,
    };
    manager.updateLayout(visible);
    expect(first.root.visible).toBe(true);
    expect(first.view.bounds).toEqual({ x: 0, y: 0, width: 420, height: 600 });

    manager.updateLayout({ ...visible, x: 0, y: 0, width: 0, height: 0, visible: false });
    expect(first.root.visible).toBe(false);
    expect(first.root.bounds).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(first.view.bounds).toEqual({ x: 0, y: 0, width: 420, height: 600 });
    owner.getContentSize.mockReturnValue([0, 0]);
    owner.emit('resize');
    expect(first.root.visible).toBe(false);
    expect(first.view.bounds).toMatchObject({ width: 420, height: 600 });

    owner.getContentSize.mockReturnValue([800, 700]);
    manager.updateLayout({ ...visible, width: 300, height: 450 });
    expect(first.root.visible).toBe(true);
    expect(first.view.bounds).toEqual({ x: 0, y: 0, width: 300, height: 450 });
    manager.updateLayout({ ...visible, generation: 'retired', width: 600 });
    expect(first.view.bounds).toMatchObject({ width: 300, height: 450 });

    first.view.webContents.destroyed = true;
    first.view.webContents.emit('destroyed');
    const replacement = open();
    expect(replacement.grant.generation).not.toBe(first.grant.generation);
    expect(replacement.root.visible).toBe(false);
    expect(replacement.view.bounds).toEqual({ x: 0, y: 0, width: 800, height: 700 });
    manager.updateLayout({
      generation: replacement.grant.generation,
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      visible: false,
      occluded: false,
    });
    expect(replacement.root.visible).toBe(false);
    expect(replacement.view.bounds).toMatchObject({ width: 800, height: 700 });
  } finally {
    owner.emit('closed');
  }
});
