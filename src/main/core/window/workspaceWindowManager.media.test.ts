import { EventEmitter } from 'node:events';

import { expect, test, vi } from 'vitest';

vi.mock('electron', () => ({ screen: { on: vi.fn() } }));
vi.mock('./workspaceSurfaceManager', () => ({
  WorkspaceSurfaceManager: class {
    handleOpen() {
      return null;
    }
  },
}));

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
