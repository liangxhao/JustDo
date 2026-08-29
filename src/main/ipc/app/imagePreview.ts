import { BrowserWindow, ipcMain, shell } from 'electron';
import path from 'path';

import {
  type ImagePreviewDocument,
  ImagePreviewIpc,
  type ImagePreviewOpenRequest,
  type ImagePreviewOpenResult,
} from '../../../shared/imagePreview';
import { t } from '../../core/i18n';

const MAX_IMAGE_SOURCE_LENGTH = 32 * 1024 * 1024;
const MAX_IMAGE_ALT_LENGTH = 512;
const ALLOWED_IMAGE_PROTOCOLS = new Set(['blob:', 'http:', 'https:', 'localfile:']);

type ImagePreviewHandlerOptions = {
  devServerUrl: string;
  getIconPath: () => string | undefined;
  isDev: boolean;
  preloadPath: string;
};

export const normalizeImagePreviewRequest = (input: unknown): ImagePreviewOpenRequest | null => {
  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  const src = typeof record.src === 'string' ? record.src.trim() : '';
  if (!src || src.length > MAX_IMAGE_SOURCE_LENGTH) return null;

  try {
    const url = new URL(src);
    if (url.protocol === 'data:') {
      if (!/^data:image\/[a-z0-9.+-]+[;,]/i.test(src)) return null;
    } else if (!ALLOWED_IMAGE_PROTOCOLS.has(url.protocol)) {
      return null;
    }
  } catch {
    return null;
  }

  const alt =
    typeof record.alt === 'string' ? record.alt.trim().slice(0, MAX_IMAGE_ALT_LENGTH) : '';
  return { src, ...(alt ? { alt } : {}) };
};

export const registerImagePreviewHandlers = ({
  devServerUrl,
  getIconPath,
  isDev,
  preloadPath,
}: ImagePreviewHandlerOptions): void => {
  let previewWindow: BrowserWindow | null = null;
  let currentDocument: ImagePreviewDocument | null = null;

  const createPreviewWindow = (): BrowserWindow => {
    const window = new BrowserWindow({
      width: 1000,
      height: 720,
      minWidth: 480,
      minHeight: 320,
      title: t('imagePreviewWindowTitle'),
      icon: getIconPath(),
      show: false,
      frame: true,
      maximizable: true,
      minimizable: true,
      resizable: true,
      autoHideMenuBar: true,
      backgroundColor: '#090909',
      enableLargerThanScreen: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        preload: preloadPath,
        spellcheck: false,
        navigateOnDragDrop: false,
      },
    });

    window.setMenu(null);
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    window.webContents.on('did-finish-load', () => {
      if (currentDocument && !window.isDestroyed()) {
        window.webContents.send(ImagePreviewIpc.SourceChanged, currentDocument);
      }
    });
    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      console.error('[ImagePreview] Page failed to load:', errorCode, errorDescription);
    });
    window.once('ready-to-show', () => {
      if (!window.isDestroyed()) window.show();
    });
    window.on('closed', () => {
      if (previewWindow === window) {
        previewWindow = null;
        currentDocument = null;
      }
    });

    if (isDev) {
      const previewUrl = new URL('image-preview.html', `${devServerUrl.replace(/\/+$/, '')}/`);
      void window.loadURL(previewUrl.toString()).catch(error => {
        console.error('[ImagePreview] Failed to load development page', error);
      });
    } else {
      void window.loadFile(path.join(__dirname, '../dist/image-preview.html')).catch(error => {
        console.error('[ImagePreview] Failed to load packaged page', error);
      });
    }

    return window;
  };

  ipcMain.handle(ImagePreviewIpc.Open, (_event, input: unknown): ImagePreviewOpenResult => {
    const request = normalizeImagePreviewRequest(input);
    if (!request) return { success: false, error: 'Invalid image preview request' };

    const defaultTitle = t('imagePreviewWindowTitle');
    currentDocument = {
      src: request.src,
      alt: request.alt ?? defaultTitle,
      title: request.alt ?? defaultTitle,
    };

    const window =
      previewWindow && !previewWindow.isDestroyed()
        ? previewWindow
        : (previewWindow = createPreviewWindow());
    window.setTitle(currentDocument.title);
    if (!window.webContents.isLoadingMainFrame()) {
      window.webContents.send(ImagePreviewIpc.SourceChanged, currentDocument);
    }
    if (window.isMinimized()) window.restore();
    if (!window.isVisible()) window.show();
    window.focus();
    return { success: true };
  });

  ipcMain.handle(ImagePreviewIpc.GetCurrent, event => {
    if (!previewWindow || previewWindow.isDestroyed()) return null;
    return event.sender === previewWindow.webContents ? currentDocument : null;
  });
};
