import { app, BrowserWindow } from 'electron';
import path from 'path';

import { isAllowedMainWindowNavigation } from './browserPanelSecurity';
import { registerContentSecurityPolicy } from './contentSecurityPolicy';
import { loadPackagedRenderer } from './renderer/packagedRendererLoader';
import { registerWindowDiagnostics } from './windowDiagnostics';

export type InitializationWindow = { window: BrowserWindow; loaded: Promise<void> };

/** An in-memory shell can report a bad userData directory before opening profiles. */
export function createInitializationWindow(options: {
  appName: string;
  preloadPath: string;
  isWindows: boolean;
  isDev: boolean;
  devServerUrl: string;
  devServerPort: number;
  onReady: (window: BrowserWindow) => void;
}): InitializationWindow {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: options.appName,
    frame: !options.isWindows,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#F8F9FB',
    webPreferences: {
      partition: 'justdo-initialization',
      preload: options.preloadPath,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  registerContentSecurityPolicy(
    { isDev: options.isDev, devServerPort: options.devServerPort },
    window.webContents.session,
  );
  registerWindowDiagnostics(window.webContents, 'AppInitialization');
  window.once('ready-to-show', () => options.onReady(window));
  const navigation = {
    isDev: options.isDev,
    devServerUrl: options.devServerUrl,
    applicationUrl: undefined as string | undefined,
  };
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => {
    if (!isAllowedMainWindowNavigation(event.url, navigation)) event.preventDefault();
  });
  window.webContents.on('will-frame-navigate', event => {
    if (!event.isMainFrame || !isAllowedMainWindowNavigation(event.url, navigation))
      event.preventDefault();
  });
  window.webContents.on('will-redirect', event => {
    if (!isAllowedMainWindowNavigation(event.url, navigation)) event.preventDefault();
  });
  const loading = options.isDev
    ? window.loadURL(options.devServerUrl)
    : loadPackagedRenderer(window, app, path.join(__dirname, '../dist'), url => {
        navigation.applicationUrl = url;
      });
  return {
    window,
    loaded: loading.catch(error => console.error('[AppInitialization] Window load failed:', error)),
  };
}
