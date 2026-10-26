import { app, BrowserWindow } from 'electron';
import path from 'path';

import { initializationWindowArguments } from '../../../shared/app/initialization';
import { DEFAULT_MAIN_WINDOW_SIZE } from '../../../shared/app/windowGeometry';
import { registerAppWindowDiagnostics } from './appWindowFailure';
import { isAllowedMainWindowNavigation } from './browserPanelSecurity';
import { registerContentSecurityPolicy } from './contentSecurityPolicy';
import { loadPackagedRenderer } from './renderer/packagedRendererLoader';
import { registerStartupEntryClock } from './startupEntryClock';

export type InitializationWindow = { window: BrowserWindow; loaded: Promise<void> };

/** An in-memory shell can report a bad userData directory before opening profiles. */
export function createInitializationWindow(options: {
  appName: string;
  firstLaunch: boolean;
  startupPresentation?: { route?: import('../../../shared/app/startup/routing').StartupRoute; entryStartedAt?: number };
  preloadPath: string;
  isWindows: boolean;
  isDev: boolean;
  devServerUrl: string;
  devServerPort: number;
  onReady: (window: BrowserWindow) => void;
  getEntryStartedAt?: () => number;
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
      partition: 'justdo-initialization',
      additionalArguments: initializationWindowArguments(options.firstLaunch, true, options.startupPresentation),
      preload: options.preloadPath,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  if (options.getEntryStartedAt) registerStartupEntryClock(window.webContents, options.getEntryStartedAt);
  registerContentSecurityPolicy(
    { isDev: options.isDev, devServerPort: options.devServerPort },
    window.webContents.session,
  );
  const reportWindowFailure = registerAppWindowDiagnostics(window.webContents, 'AppInitialization');
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
    loaded: loading.catch(error => {
      console.error('[AppInitialization] Window load failed:', error);
      reportWindowFailure(error);
    }),
  };
}
