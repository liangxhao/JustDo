import path from 'node:path';

import { app, BrowserWindow } from 'electron';

import { DEFAULT_MAIN_WINDOW_SIZE } from '../../../shared/app/windowGeometry';
import type { InitializationWindow } from './initializationWindow';
import { loadPackagedRenderer } from './renderer/packagedRendererLoader';

/** Route-neutral first paint: no preload, profile, preferences, or execution capabilities. */
export function createStartupBootstrapWindow(options: {
  appName: string;
  isDev: boolean;
  isWindows?: boolean;
  devServerUrl: string;
  onReady: (window: BrowserWindow) => void;
}): InitializationWindow {
  const window = new BrowserWindow({
    ...DEFAULT_MAIN_WINDOW_SIZE,
    minWidth: 800,
    minHeight: 600,
    title: options.appName,
    frame: !options.isWindows,
    titleBarStyle: options.isWindows ? 'hidden' : undefined,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#F8F9FB',
    webPreferences: {
      partition: 'startup-bootstrap',
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  window.once('ready-to-show', () => options.onReady(window));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // All navigation after the initial Main-owned load is unnecessary.
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-frame-navigate', event => event.preventDefault());
  window.webContents.on('will-redirect', event => event.preventDefault());
  const loading = options.isDev
    ? window.loadURL(new URL('/startup-bootstrap.html', options.devServerUrl).href)
    : loadPackagedRenderer(window, app, path.join(__dirname, '../dist'), () => {},
        { bootstrapOnly: true });
  return {
    window,
    loaded: loading.catch(error => console.error('[StartupBootstrap] First paint failed:', error)),
  };
}
