import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const electronMocks = vi.hoisted(() => ({ app: {}, createWindow: vi.fn() }));
vi.mock('electron', () => ({
  app: electronMocks.app,
  BrowserWindow: class {
    constructor(options: unknown) {
      return electronMocks.createWindow(options);
    }
  },
}));
vi.mock('./contentSecurityPolicy', () => ({ registerContentSecurityPolicy: vi.fn() }));
vi.mock('./windowDiagnostics', () => ({ registerWindowDiagnostics: vi.fn() }));
vi.mock('./renderer/packagedRendererLoader', () => ({ loadPackagedRenderer: vi.fn() }));

import { registerContentSecurityPolicy } from './contentSecurityPolicy';
import { createInitializationWindow } from './initializationWindow';
import { loadPackagedRenderer } from './renderer/packagedRendererLoader';

const options = {
  appName: 'SampleProduct',
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
    loadURL: vi.fn(() => Promise.resolve()),
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
  vi.mocked(loadPackagedRenderer).mockResolvedValue(undefined);
});
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

test('loads the packaged HTTP renderer in memory and waits for its real load completion', async () => {
  let finish!: () => void;
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
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
  });
  expect(loaded).not.toHaveBeenCalled();
  finish();
  await startup.loaded;
  expect(loaded).toHaveBeenCalledOnce();
});

test('logs the actual host failure without blocking user-data preparation', async () => {
  const error = new Error('Renderer assets unavailable');
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.mocked(loadPackagedRenderer).mockRejectedValue(error);

  await expect(createInitializationWindow(options).loaded).resolves.toBeUndefined();

  expect(log).toHaveBeenCalledWith('[AppInitialization] Window load failed:', error);
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
