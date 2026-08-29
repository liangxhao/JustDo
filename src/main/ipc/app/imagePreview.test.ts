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

import { ImagePreviewIpc } from '../../../shared/imagePreview';
import { normalizeImagePreviewRequest, registerImagePreviewHandlers } from './imagePreview';

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
});
