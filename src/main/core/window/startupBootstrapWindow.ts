import path from 'node:path';

import { app, BrowserWindow } from 'electron';

import { DEFAULT_MAIN_WINDOW_SIZE } from '../../../shared/app/windowGeometry';
import { inlineApplicationScriptHashes } from './renderer/applicationContentSecurityPolicy';
import { readPackagedStartupDocument } from './renderer/applicationRendererHost';
import { registerStartupWindowPresentation } from './startupWindowPresentation';

async function loadPackagedBootstrap(window: BrowserWindow): Promise<void> {
  const html = await readPackagedStartupDocument(path.join(app.getAppPath(), 'dist'));
  const hashes = inlineApplicationScriptHashes(html).map(hash => `'${hash}'`);
  const policy = [
    "default-src 'none'",
    `script-src ${hashes.length ? hashes.join(' ') : "'none'"}`,
    "style-src 'unsafe-inline'",
    'img-src data:',
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  const secured = html.replace(/<head\s*>/iu,
    head => `${head}<meta http-equiv="Content-Security-Policy" content="${policy}">`);
  if (secured === html) throw new Error('Packaged startup document is missing its head.');
  if (window.isDestroyed()) return;
  try {
    await window.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(secured).toString('base64')}`);
  } catch (error) {
    // Electron's error message includes the full encoded document URL.
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    throw new Error(`Could not load the packaged startup document${code ? ` (${code})` : ''}.`);
  }
}

/** Route-neutral first paint: no preload, profile, preferences, or execution capabilities. */
export function createStartupBootstrapWindow(options: {
  appName: string;
  isDev: boolean;
  isWindows?: boolean;
  devServerUrl: string;
  onReady: (window: BrowserWindow) => void;
}): { window: BrowserWindow; loaded: Promise<void> } {
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
  const markLoaded = registerStartupWindowPresentation(window, options.onReady);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // All navigation after the initial Main-owned load is unnecessary.
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-frame-navigate', event => event.preventDefault());
  window.webContents.on('will-redirect', event => event.preventDefault());
  const loading = options.isDev
    ? window.loadURL(new URL('/startup-bootstrap.html', options.devServerUrl).href)
    : loadPackagedBootstrap(window);
  return {
    window,
    loaded: loading.then(markLoaded).catch(error => console.error('[StartupBootstrap] First paint failed:', error)),
  };
}
