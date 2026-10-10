import { beforeEach, describe, expect, test, vi } from 'vitest';

const electronMocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const webContents = {
    isLoadingMainFrame: vi.fn(() => false),
    on: vi.fn(),
    send: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  };
  const previewWindow = {
    focus: vi.fn(),
    destroy: vi.fn(),
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    isVisible: vi.fn(() => false),
    loadFile: vi.fn(() => Promise.resolve()),
    loadURL: vi.fn(() => Promise.resolve()),
    on: vi.fn(),
    once: vi.fn(),
    restore: vi.fn(),
    setMenu: vi.fn(),
    setTitle: vi.fn(),
    show: vi.fn(),
    webContents,
  };
  return {
    BrowserWindow: vi.fn(function BrowserWindowMock() {
      return previewWindow;
    }),
    handlers,
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
    },
    previewWindow,
    shell: { openExternal: vi.fn() },
  };
});

vi.mock('electron', () => ({
  BrowserWindow: electronMocks.BrowserWindow,
  ipcMain: electronMocks.ipcMain,
  shell: electronMocks.shell,
}));

import { ImagePreviewIpc } from '../../../shared/preview/imagePreview';
import {
  isAllowedImagePreviewNavigation,
  normalizeImagePreviewRequest,
  registerImagePreviewHandlers,
  resolvePackagedImagePreviewUrl,
} from './imagePreview';

beforeEach(() => {
  electronMocks.handlers.clear();
  vi.clearAllMocks();
});

describe('image preview request validation', () => {
  test.each([
    'https://example.com/image.png',
    'data:image/png;base64,AA==',
    'blob:file:///generated-image',
    'localfile:///C:/workspace/image.png',
  ])('accepts a supported rendered image URL: %s', src => {
    expect(normalizeImagePreviewRequest({ src, alt: ' detail ' })).toEqual({
      src,
      alt: 'detail',
    });
  });

  test.each([
    'javascript:alert(1)',
    'data:text/html;base64,AA==',
    'file:///tmp/image.png',
    '/relative/image.png',
    'not a URL',
    '',
  ])('rejects an unsupported image URL: %s', src => {
    expect(normalizeImagePreviewRequest({ src })).toBeNull();
  });

  test('rejects malformed payloads', () => {
    expect(normalizeImagePreviewRequest(null)).toBeNull();
    expect(normalizeImagePreviewRequest({ src: 42 })).toBeNull();
  });
});

describe('image preview window', () => {
  test('creates an independent native window with a dedicated preload', () => {
    registerImagePreviewHandlers({
      devServerUrl: 'http://localhost:43127',
      getIconPath: () => 'app.ico',
      isDev: true,
      preloadPath: 'imagePreviewPreload.js',
    });
    const openHandler = electronMocks.handlers.get(ImagePreviewIpc.Open);

    expect(openHandler?.({}, { src: 'https://example.com/detail.png', alt: 'detail' })).toEqual({
      success: true,
    });
    expect(electronMocks.BrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        frame: true,
        width: 1000,
        height: 720,
        maximizable: true,
        webPreferences: expect.objectContaining({
          contextIsolation: true,
          nodeIntegration: false,
          preload: 'imagePreviewPreload.js',
          sandbox: true,
        }),
      }),
    );
    const windowOptions = electronMocks.BrowserWindow.mock.calls[0]?.[0];
    expect(windowOptions).not.toHaveProperty('parent');
    expect(electronMocks.previewWindow.loadURL).toHaveBeenCalledWith(
      'http://localhost:43127/image-preview.html',
    );
    expect(electronMocks.previewWindow.focus).toHaveBeenCalledOnce();
  });

  test('loads the packaged viewer on the main HTTP origin with its minimal preload', () => {
    registerImagePreviewHandlers({
      devServerUrl: 'http://localhost:43127',
      getIconPath: () => undefined,
      getMainWindow: () =>
        ({
          isDestroyed: () => false,
          webContents: { getURL: () => 'http://127.0.0.1:45001/index.html#chat' },
        }) as unknown as BrowserWindow,
      isDev: false,
      preloadPath: 'imagePreviewPreload.js',
    });
    expect(
      electronMocks.handlers.get(ImagePreviewIpc.Open)?.(
        {},
        {
          src: 'blob:http://127.0.0.1:45001/1234',
        },
      ),
    ).toEqual({ success: true });
    expect(electronMocks.previewWindow.loadURL).toHaveBeenCalledWith(
      'http://127.0.0.1:45001/image-preview.html',
    );
    expect(electronMocks.previewWindow.loadFile).not.toHaveBeenCalled();
    expect(electronMocks.BrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        webPreferences: expect.objectContaining({
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          contextIsolation: true,
          sandbox: true,
          preload: 'imagePreviewPreload.js',
        }),
      }),
    );
  });

  test('fails closed while the packaged main origin is unavailable', () => {
    registerImagePreviewHandlers({
      devServerUrl: 'http://localhost:43127',
      getIconPath: () => undefined,
      getMainWindow: () => null,
      isDev: false,
      preloadPath: 'imagePreviewPreload.js',
    });
    expect(
      electronMocks.handlers.get(ImagePreviewIpc.Open)?.({}, { src: 'data:image/png;base64,AA==' }),
    ).toMatchObject({ success: false });
    expect(electronMocks.BrowserWindow).not.toHaveBeenCalled();
    expect(electronMocks.previewWindow.loadFile).not.toHaveBeenCalled();
  });

  test('recreates the viewer when the main host origin changes', () => {
    let origin = 'http://127.0.0.1:45001';
    registerImagePreviewHandlers({
      devServerUrl: 'http://localhost:43127',
      getIconPath: () => undefined,
      getMainWindow: () =>
        ({
          isDestroyed: () => false,
          webContents: { getURL: () => `${origin}/index.html` },
        }) as unknown as BrowserWindow,
      isDev: false,
      preloadPath: 'imagePreviewPreload.js',
    });
    const open = electronMocks.handlers.get(ImagePreviewIpc.Open)!;
    open({}, { src: `${origin}/assets/image.png` });
    origin = 'http://127.0.0.1:45002';
    open({}, { src: `${origin}/assets/image.png` });
    expect(electronMocks.previewWindow.destroy).toHaveBeenCalledOnce();
    expect(electronMocks.BrowserWindow).toHaveBeenCalledTimes(2);
    expect(electronMocks.previewWindow.loadURL).toHaveBeenLastCalledWith(
      `${origin}/image-preview.html`,
    );
  });

  test('blocks navigation/redirects and new windows on the application origin', () => {
    registerImagePreviewHandlers({
      devServerUrl: 'http://localhost:43127',
      getIconPath: () => undefined,
      getMainWindow: () =>
        ({
          isDestroyed: () => false,
          webContents: { getURL: () => 'http://127.0.0.1:45001/index.html' },
        }) as unknown as BrowserWindow,
      isDev: false,
      preloadPath: 'imagePreviewPreload.js',
    });
    electronMocks.handlers.get(ImagePreviewIpc.Open)!({}, { src: 'https://example.com/image.png' });
    const listeners = new Map(electronMocks.previewWindow.webContents.on.mock.calls);
    for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
      const preventDefault = vi.fn();
      listeners.get(name)?.({
        url: 'https://attacker.example/',
        isMainFrame: true,
        preventDefault,
      });
      expect(preventDefault).toHaveBeenCalledOnce();
    }
    const openWindow =
      electronMocks.previewWindow.webContents.setWindowOpenHandler.mock.lastCall?.[0];
    expect(openWindow({ url: 'http://127.0.0.1:45001/index.html' })).toEqual({ action: 'deny' });
    expect(electronMocks.shell.openExternal).not.toHaveBeenCalled();
    expect(openWindow({ url: 'https://example.com' })).toEqual({ action: 'deny' });
    expect(electronMocks.shell.openExternal).toHaveBeenCalledWith('https://example.com');
  });
});

describe('packaged image preview origin', () => {
  test.each([
    '',
    'file:///C:/app/index.html',
    'https://example.com/index.html',
    'http://localhost:45001/index.html',
    'http://user@127.0.0.1:45001/index.html',
    'http://127.0.0.1:45001/other.html',
    'http://127.0.0.1:45001/index.html?redirect=1',
  ])('rejects an unowned packaged entry: %s', input => {
    expect(resolvePackagedImagePreviewUrl(input)).toBeNull();
  });

  test('allows only the dedicated same-origin preview entry', () => {
    const entry = 'http://127.0.0.1:45001/image-preview.html';
    expect(isAllowedImagePreviewNavigation(`${entry}#image`, entry)).toBe(true);
    for (const url of [
      'http://127.0.0.1:45001/index.html',
      'http://127.0.0.1:45002/image-preview.html',
      'https://example.com',
      `${entry}?redirect=1`,
    ]) {
      expect(isAllowedImagePreviewNavigation(url, entry)).toBe(false);
    }
  });
});
import type { BrowserWindow } from 'electron';
