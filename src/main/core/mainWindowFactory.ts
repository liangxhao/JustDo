import { app, BrowserWindow, nativeImage, shell } from 'electron';
import fs from 'fs';
import path from 'path';

type MainWindowFactoryOptions = {
  appName: string;
  devServerUrl: string;
  getBackgroundColor: () => string;
  getIconPath: () => string | undefined;
  getTitleBarOverlay: () => Electron.TitleBarOverlay;
  isDev: boolean;
  isMac: boolean;
  isQuitting: () => boolean;
  isWindows: boolean;
  onDidFinishLoad: (window: BrowserWindow) => void;
  onReadyToShow: (window: BrowserWindow) => void;
  onWindowStateChanged: (window: BrowserWindow) => void;
  preloadPath: string;
  scheduleReload: (reason: string) => void;
};

const DEV_LOAD_MAX_RETRIES = 3;
const LOAD_RETRY_DELAY_MS = 3_000;
const LOAD_TIMEOUT_MS = 30_000;

export const createMainWindow = (options: MainWindowFactoryOptions): BrowserWindow => {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: options.appName,
    icon: options.getIconPath(),
    ...(options.isMac
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 12, y: 20 },
        }
      : options.isWindows
        ? {
            frame: false,
            titleBarStyle: 'hidden' as const,
          }
        : {
            titleBarStyle: 'hidden' as const,
            titleBarOverlay: options.getTitleBarOverlay(),
          }),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      preload: options.preloadPath,
      backgroundThrottling: false,
      devTools: options.isDev,
      spellcheck: false,
      enableWebSQL: false,
      autoplayPolicy: 'document-user-activation-required',
      disableDialogs: true,
      navigateOnDragDrop: false,
    },
    backgroundColor: options.getBackgroundColor(),
    show: false,
    autoHideMenuBar: true,
    enableLargerThanScreen: false,
  });

  if (options.isMac && options.isDev) {
    const iconPath = path.join(__dirname, '../build/icons/png/512x512.png');
    if (fs.existsSync(iconPath)) {
      app.dock.setIcon(nativeImage.createFromPath(iconPath));
    }
  }

  mainWindow.setMenu(null);
  mainWindow.setMinimumSize(800, 600);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const loadTimeout = setTimeout(() => {
    if (!mainWindow.isDestroyed() && mainWindow.webContents.isLoadingMainFrame()) {
      console.log('[MainWindow] Load timed out, attempting to reload.');
      options.scheduleReload('load-timeout');
    }
  }, LOAD_TIMEOUT_MS);

  mainWindow.webContents.once('did-finish-load', () => clearTimeout(loadTimeout));
  mainWindow.webContents.on('did-finish-load', () => options.onDidFinishLoad(mainWindow));

  mainWindow.on('close', event => {
    if (!options.isQuitting() && !options.isDev) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  if (options.isDev) {
    let retryCount = 0;
    const tryLoadUrl = (): void => {
      void mainWindow.loadURL(options.devServerUrl).catch(error => {
        console.error('[MainWindow] Failed to load development URL:', error);
        retryCount += 1;
        if (retryCount < DEV_LOAD_MAX_RETRIES) {
          setTimeout(tryLoadUrl, LOAD_RETRY_DELAY_MS);
          return;
        }
        console.error('[MainWindow] Failed to load development URL after maximum retries.');
        if (!mainWindow.isDestroyed()) {
          void mainWindow.loadFile(path.join(__dirname, '../resources/error.html'));
        }
      });
    };
    tryLoadUrl();

    mainWindow.webContents.on('before-input-event', (_event, input) => {
      const isDevtoolsShortcut =
        input.key === 'F12' ||
        (input.control || input.meta) && input.shift && input.key.toLowerCase() === 'i';

      if (isDevtoolsShortcut) {
        mainWindow.webContents.toggleDevTools();
      }
    });
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error('[MainWindow] Page failed to load:', errorCode, errorDescription);
    if (options.isDev) {
      setTimeout(() => options.scheduleReload('did-fail-load'), LOAD_RETRY_DELAY_MS);
    }
  });

  const forwardWindowState = (): void => options.onWindowStateChanged(mainWindow);
  mainWindow.on('maximize', forwardWindowState);
  mainWindow.on('unmaximize', forwardWindowState);
  mainWindow.on('enter-full-screen', forwardWindowState);
  mainWindow.on('leave-full-screen', forwardWindowState);
  mainWindow.on('focus', forwardWindowState);
  mainWindow.on('blur', forwardWindowState);

  mainWindow.once('ready-to-show', () => options.onReadyToShow(mainWindow));
  return mainWindow;
};
