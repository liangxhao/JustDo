import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import {
  FIRST_LAUNCH_WINDOW_ARGUMENT,
  INITIALIZATION_WINDOW_ARGUMENT,
} from '../../../shared/app/initialization';
import { StartupFailureSource } from '../../../shared/app/startupFailure';

const electronMocks = vi.hoisted(() => ({
  app: { getAppPath: () => '/packaged' }, createWindow: vi.fn(), reportFailure: vi.fn(),
  registerDiagnostics: vi.fn(),
}));
vi.mock('electron', () => ({
  app: electronMocks.app,
  BrowserWindow: class {
    constructor(options: unknown) {
      return electronMocks.createWindow(options);
    }
  },
}));
vi.mock('./contentSecurityPolicy', () => ({ registerContentSecurityPolicy: vi.fn() }));
vi.mock('./appWindowFailure', () => ({ registerAppWindowDiagnostics: electronMocks.registerDiagnostics }));
vi.mock('./renderer/packagedRendererLoader', () => ({ loadPackagedRenderer: vi.fn() }));
vi.mock('./renderer/applicationRendererHost', () => ({ readPackagedStartupDocument: vi.fn() }));

import { registerContentSecurityPolicy } from './contentSecurityPolicy';
import { createInitializationWindow } from './initializationWindow';
import { readPackagedStartupDocument } from './renderer/applicationRendererHost';
import { loadPackagedRenderer } from './renderer/packagedRendererLoader';
import { createStartupBootstrapWindow } from './startupBootstrapWindow';

const options = {
  appName: 'SampleProduct',
  firstLaunch: true,
  preloadPath: '/packaged/preload.js',
  isWindows: true,
  isDev: false,
  devServerUrl: 'http://localhost:43127',
  devServerPort: 43127,
  onReady: vi.fn(),
};
const makeWindow = () =>
  Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    loadURL: vi.fn((_url: string) => Promise.resolve()),
    loadFile: vi.fn(),
    webContents: Object.assign(new EventEmitter(), {
      session: {},
      setWindowOpenHandler: vi.fn(),
    }),
  });
let window: ReturnType<typeof makeWindow>;

beforeEach(() => {
  window = makeWindow();
  electronMocks.createWindow.mockReturnValue(window);
  electronMocks.registerDiagnostics.mockReturnValue(electronMocks.reportFailure);
  vi.mocked(loadPackagedRenderer).mockResolvedValue(true);
});
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

test('loads the packaged HTTP renderer in memory and waits for its real load completion', async () => {
  let finish!: (success: boolean) => void;
  vi.mocked(loadPackagedRenderer).mockReturnValue(new Promise(resolve => (finish = resolve)));

  const startup = createInitializationWindow(options);
  const loaded = vi.fn();
  void startup.loaded.then(loaded);
  await Promise.resolve();

  expect(startup.window).toBe(window);
  expect(loadPackagedRenderer).toHaveBeenCalledWith(
    window,
    electronMocks.app,
    expect.stringMatching(/[/\\]dist$/u),
    expect.any(Function),
  );
  expect(window.loadFile).not.toHaveBeenCalled();
  expect(electronMocks.createWindow.mock.calls[0][0].webPreferences).toMatchObject({
    partition: 'justdo-initialization',
    additionalArguments: [INITIALIZATION_WINDOW_ARGUMENT, FIRST_LAUNCH_WINDOW_ARGUMENT],
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
  });
  expect(loaded).not.toHaveBeenCalled();
  window.emit('ready-to-show');
  expect(options.onReady).not.toHaveBeenCalled();
  finish(true);
  await startup.loaded;
  expect(loaded).toHaveBeenCalledOnce();
  expect(options.onReady).toHaveBeenCalledExactlyOnceWith(window);
});

test('directly presents the standalone bootstrap with a restrictive policy and no HTTP host', async () => {
  const script = '\n  document.documentElement.lang = "zh";\n';
  vi.mocked(readPackagedStartupDocument).mockResolvedValue(
    `<html><head></head><body><script>${script.replaceAll('\n', '\r\n')}</script></body></html>`,
  );

  const bootstrap = createStartupBootstrapWindow(options);
  await bootstrap.loaded;
  const preferences = electronMocks.createWindow.mock.calls[0][0].webPreferences;
  expect(preferences).toMatchObject({ partition: 'startup-bootstrap', sandbox: true, nodeIntegration: false });
  expect(preferences.preload).toBeUndefined();
  expect(preferences.additionalArguments).toBeUndefined();
  expect(loadPackagedRenderer).not.toHaveBeenCalled();
  expect(readPackagedStartupDocument).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/[/\\]dist$/u));
  const prefix = 'data:text/html;charset=utf-8;base64,';
  const url = window.loadURL.mock.calls[0][0];
  expect(url).toMatch(/^data:text\/html;charset=utf-8;base64,/u);
  const html = Buffer.from(url.slice(prefix.length), 'base64').toString('utf8');
  const hash = createHash('sha256').update(script).digest('base64');
  expect(html).toContain(`default-src 'none'; script-src 'sha256-${hash}'`);
  expect(html).toContain('img-src data:');
  expect(options.onReady).not.toHaveBeenCalled();
  window.emit('ready-to-show');
  expect(options.onReady).toHaveBeenCalledExactlyOnceWith(window);
  for (const event of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
    const preventDefault = vi.fn();
    window.webContents.emit(event, { preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
  }
});

test('leaves a failed optional initialization page hidden without showing a dialog', async () => {
  const error = new Error('Renderer assets unavailable');
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.mocked(loadPackagedRenderer).mockRejectedValue(error);

  const startup = createInitializationWindow(options);
  window.emit('ready-to-show');
  await expect(startup.loaded).resolves.toBe(false);

  expect(log).toHaveBeenCalledWith('[AppInitialization] Window load failed:', error);
  expect(electronMocks.reportFailure).not.toHaveBeenCalled();
  expect(options.onReady).not.toHaveBeenCalled();
});

test('keeps setup unavailable if preload failed despite a successful document load', async () => {
  const startup = createInitializationWindow(options);
  const canReport = electronMocks.registerDiagnostics.mock.calls[0][2];

  expect(canReport(StartupFailureSource.Preload)).toBe(false);
  window.emit('ready-to-show');

  await expect(startup.loaded).resolves.toBe(false);
  expect(options.onReady).not.toHaveBeenCalled();
  expect(electronMocks.reportFailure).not.toHaveBeenCalled();
});

test('keeps an ordinary startup failure in ordinary mode even in a transient window', async () => {
  await createInitializationWindow({ ...options, firstLaunch: false }).loaded;

  expect(electronMocks.createWindow.mock.calls[0][0].webPreferences.additionalArguments).toEqual([
    INITIALIZATION_WINDOW_ARGUMENT,
  ]);
});

test('admits only its own packaged page and revokes admission when the host closes', async () => {
  const startup = createInitializationWindow(options);
  const publishUrl = vi.mocked(loadPackagedRenderer).mock.calls[0][3];
  const applicationUrl = 'http://127.0.0.1:45001/index.html';
  publishUrl(applicationUrl);
  const navigate = (eventName: string, url: string, isMainFrame = true) => {
    const event = { url, isMainFrame, preventDefault: vi.fn() };
    window.webContents.emit(eventName, event);
    return event.preventDefault;
  };

  expect(navigate('will-navigate', applicationUrl)).not.toHaveBeenCalled();
  expect(navigate('will-navigate', 'http://127.0.0.1:45002/index.html')).toHaveBeenCalledOnce();
  expect(navigate('will-redirect', 'https://example.com/')).toHaveBeenCalledOnce();
  expect(navigate('will-frame-navigate', applicationUrl, false)).toHaveBeenCalledOnce();
  expect(window.webContents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: 'deny' });
  publishUrl(undefined);
  expect(navigate('will-navigate', applicationUrl)).toHaveBeenCalledOnce();
  await startup.loaded;
});

test('retains the development loader and applies CSP to its memory session', async () => {
  const startup = createInitializationWindow({ ...options, isDev: true });
  await startup.loaded;

  expect(loadPackagedRenderer).not.toHaveBeenCalled();
  expect(window.loadURL).toHaveBeenCalledWith(options.devServerUrl);
  expect(registerContentSecurityPolicy).toHaveBeenCalledWith(
    { isDev: true, devServerPort: 43127 },
    window.webContents.session,
  );
  window.emit('ready-to-show');
  expect(options.onReady).toHaveBeenCalledWith(window);
});
