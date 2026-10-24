import { EventEmitter } from 'node:events';
import path from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { BROWSER_PANEL_PARTITION } from '../../../shared/browser/browser';

const mocks = vi.hoisted(() => ({
  createWindow: vi.fn(),
  fromPartition: vi.fn(),
  getPath: vi.fn(),
  record: vi.fn(),
  update: vi.fn(),
  claim: vi.fn(),
  cancelAll: vi.fn(),
  showSaveDialog: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { getPath: mocks.getPath },
  BrowserWindow: class {
    constructor() {
      return mocks.createWindow();
    }
  },
  dialog: { showSaveDialog: mocks.showSaveDialog },
  ipcMain: { on: vi.fn(), off: vi.fn(), handle: vi.fn(), removeHandler: vi.fn() },
  session: { fromPartition: mocks.fromPartition },
}));
vi.mock('../../browser/data/browserDataImportService', () => ({
  recordBrowserDownload: mocks.record,
  updateBrowserDownload: mocks.update,
}));
vi.mock('../../browser/downloads/browserAgentDownloadCoordinator', () => ({
  claimBrowserAgentDownload: mocks.claim,
  cancelAllBrowserAgentDownloads: mocks.cancelAll,
}));
vi.mock('../network/systemProxyPreference', () => ({ registerBrowserProxySession: vi.fn() }));
vi.mock('./appWindowFailure', () => ({ registerAppWindowDiagnostics: () => vi.fn() }));
vi.mock('./renderer/packagedRendererLoader', () => ({
  loadPackagedRenderer: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./windowAppearance', () => ({ registerWindowAppearance: vi.fn() }));
vi.mock('./widgetViewerGuest', () => ({ createWidgetViewerGuests: () => ({}) }));

import { createMainWindow } from './mainWindowFactory';

const makeSession = () =>
  Object.assign(new EventEmitter(), {
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    setDisplayMediaRequestHandler: vi.fn(),
    webRequest: { onBeforeRequest: vi.fn(), onHeadersReceived: vi.fn() },
  });
const makeItem = () =>
  Object.assign(new EventEmitter(), {
    getFilename: () => 'report.zip',
    getURL: () => 'https://files.example.test/download?id=report',
    getReceivedBytes: () => 0,
    getTotalBytes: () => 128,
    getSavePath: vi.fn(() => ''),
    setSaveDialogOptions: vi.fn(),
    setSavePath: vi.fn(),
    getState: () => 'progressing',
    pause: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
  });
const directory = path.join(process.cwd(), 'build', '下载 文件');
let browserSession: ReturnType<typeof makeSession>;
let window: EventEmitter;
let settings: { askWhereToSave: boolean; directory: string };

beforeEach(() => {
  vi.useFakeTimers();
  mocks.claim.mockReset();
  const sessions = new Map<string, ReturnType<typeof makeSession>>();
  mocks.fromPartition.mockImplementation((partition: string) => {
    if (!sessions.has(partition)) sessions.set(partition, makeSession());
    return sessions.get(partition);
  });
  mocks.getPath.mockReturnValue(directory);
  window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    setMenu: vi.fn(),
    setMinimumSize: vi.fn(),
    webContents: Object.assign(new EventEmitter(), {
      session: makeSession(),
      setWindowOpenHandler: vi.fn(),
    }),
  });
  mocks.createWindow.mockReturnValue(window);
  settings = { askWhereToSave: true, directory: '' };
  createMainWindow({
    appName: 'SampleProduct',
    firstLaunch: false,
    browserGuestPreloadPath: '/browser-preload.js',
    widgetViewerPreloadPath: '/widget-preload.js',
    devServerUrl: 'http://localhost:43127',
    getBackgroundColor: () => '#ffffff',
    getIconPath: () => undefined,
    getRendererPreferenceStore: () => ({ get: vi.fn(), set: vi.fn() }),
    getBrowserDownloadSettings: () => settings,
    getProxyCredentials: () => null,
    getTitleBarOverlay: () => ({}),
    showSystemMenu: vi.fn(),
    isDev: false,
    isMac: false,
    isQuitting: () => true,
    isWindows: true,
    onDidFinishLoad: vi.fn(),
    onReadyToShow: vi.fn(),
    onWindowStateChanged: vi.fn(),
    preloadPath: '/preload.js',
    scheduleReload: vi.fn(),
    readWorkspaceWindowBounds: () => undefined,
    saveWorkspaceWindowBounds: vi.fn(),
  });
  browserSession = sessions.get(BROWSER_PANEL_PARTITION)!;
});

afterEach(() => {
  window.emit('closed');
  vi.useRealTimers();
  vi.clearAllMocks();
});

test('uses one native save prompt configured synchronously for a download URL', async () => {
  const item = makeItem();

  browserSession.emit('will-download', {}, item);

  expect(item.setSaveDialogOptions).toHaveBeenCalledExactlyOnceWith({
    defaultPath: path.join(directory, 'report.zip'),
  });
  expect(item.setSavePath).not.toHaveBeenCalled();
  await Promise.resolve();
  expect(mocks.showSaveDialog).not.toHaveBeenCalled();
  expect(item.pause).not.toHaveBeenCalled();
  expect(mocks.record).toHaveBeenCalledWith(
    expect.objectContaining({ state: 'queued' }),
    undefined,
  );

  item.getSavePath.mockReturnValue(path.join(directory, 'renamed.zip'));
  item.emit('updated', {}, 'progressing');
  vi.advanceTimersByTime(300);
  expect(mocks.update).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.objectContaining({ state: 'progressing', savePath: item.getSavePath() }),
  );
  item.emit('done', {}, 'completed');
  expect(mocks.update).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.objectContaining({ state: 'completed', savePath: item.getSavePath() }),
  );
});

test.each(['cancelled', 'completed'] as const)(
  'records native %s even when no progress event was delivered',
  state => {
    const item = makeItem();
    browserSession.emit('will-download', {}, item);
    if (state === 'completed') item.getSavePath.mockReturnValue(path.join(directory, 'chosen.zip'));

    item.emit('done', {}, state);

    expect(mocks.update).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ state, savePath: item.getSavePath() || undefined }),
    );
    window.emit('closed');
    expect(item.cancel).not.toHaveBeenCalled();
  },
);

test('keeps automatic downloads synchronous and reserves distinct filenames', () => {
  settings.askWhereToSave = false;
  const first = makeItem();
  const second = makeItem();

  browserSession.emit('will-download', {}, first);
  browserSession.emit('will-download', {}, second);

  expect(first.setSavePath).toHaveBeenCalledExactlyOnceWith(path.join(directory, 'report.zip'));
  expect(second.setSavePath).toHaveBeenCalledExactlyOnceWith(
    path.join(directory, 'report (1).zip'),
  );
  expect(first.setSaveDialogOptions).not.toHaveBeenCalled();
  expect(second.setSaveDialogOptions).not.toHaveBeenCalled();
});

test('keeps agent downloads on the claimed path without a save prompt', () => {
  const item = makeItem();
  const claim = { savePath: path.join(directory, 'agent.zip'), cancelled: false, settle: vi.fn() };
  mocks.claim.mockReturnValue(claim);

  browserSession.emit('will-download', {}, item);

  expect(item.setSavePath).toHaveBeenCalledExactlyOnceWith(claim.savePath);
  expect(item.setSaveDialogOptions).not.toHaveBeenCalled();
  item.emit('done', {}, 'completed');
  expect(claim.settle).toHaveBeenCalledExactlyOnceWith(item, 'completed');
});

test('cancels a pending native save and removes the handler when the window closes', () => {
  const item = makeItem();
  browserSession.emit('will-download', {}, item);

  window.emit('closed');

  expect(item.cancel).toHaveBeenCalledOnce();
  expect(browserSession.listenerCount('will-download')).toBe(0);
});
