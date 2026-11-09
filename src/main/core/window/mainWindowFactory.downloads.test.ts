import { EventEmitter } from 'node:events';
import path from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import {
  BROWSER_GUEST_COMMAND_CHANNEL,
  BROWSER_PANEL_PARTITION,
  BrowserIpc,
  BrowserTabPresentation,
} from '../../../shared/browser/browser';
import { registerBackgroundBrowserGuest } from '../../browser/backgroundBrowserGuestRegistry';

const mocks = vi.hoisted(() => ({
  createWindow: vi.fn(),
  fromPartition: vi.fn(),
  getPath: vi.fn(),
  record: vi.fn(),
  update: vi.fn(),
  claim: vi.fn(),
  cancelForGuest: vi.fn(),
  showSaveDialog: vi.fn(),
  registerDiagnostics: vi.fn(),
  attachWidget: vi.fn(),
  attachWebpage: vi.fn(),
  automating: vi.fn(),
  menuPopup: vi.fn(),
  menuTemplate: vi.fn(),
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
  Menu: { buildFromTemplate: mocks.menuTemplate },
}));
vi.mock('../../browser/data/browserDataImportService', () => ({
  recordBrowserDownload: mocks.record,
  updateBrowserDownload: mocks.update,
}));
vi.mock('../../browser/downloads/browserAgentDownloadCoordinator', () => ({
  claimBrowserAgentDownload: mocks.claim,
  cancelBrowserAgentDownloadsForWebContents: mocks.cancelForGuest,
}));
vi.mock('../network/systemProxyPreference', () => ({ registerBrowserProxySession: vi.fn() }));
vi.mock('../../browser/browserNetworkDiagnostics', () => ({
  registerBrowserNetworkDiagnostics: mocks.registerDiagnostics,
}));
vi.mock('./appWindowFailure', () => ({ registerAppWindowDiagnostics: () => vi.fn() }));
vi.mock('./renderer/packagedRendererLoader', () => ({
  loadPackagedRenderer: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./windowAppearance', () => ({ registerWindowAppearance: vi.fn() }));
vi.mock('./widgetViewerGuest', () => ({
  createWidgetViewerGuests: () => ({ attach: mocks.attachWidget }),
}));
vi.mock('./webpageEmbedGuest', () => ({
  createWebpageEmbedGuests: () => ({ attach: mocks.attachWebpage, dispose: vi.fn() }),
}));
vi.mock('../../browser/history/browserHistoryTracking', () => ({
  trackBrowserHistory: () => vi.fn(),
}));
vi.mock('../../browser/history/browserFavicon', () => ({ trackBrowserFavicon: vi.fn() }));

import { createMainWindow } from './mainWindowFactory';

const makeSession = () =>
  Object.assign(new EventEmitter(), {
    getUserAgent: () => 'Chrome/148.0.0.0',
    setUserAgent: vi.fn(),
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
let origin: EventEmitter & {
  id: number;
  session: typeof browserSession;
  isDestroyed: () => boolean;
  setWindowOpenHandler: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.useFakeTimers();
  mocks.automating.mockReset().mockReturnValue(false);
  mocks.claim.mockReset();
  mocks.attachWidget.mockReturnValue(false);
  mocks.attachWebpage.mockReturnValue(false);
  mocks.menuTemplate.mockReset().mockImplementation(() => ({ popup: mocks.menuPopup }));
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
      send: vi.fn(),
    }),
  });
  mocks.createWindow.mockReturnValue(window);
  settings = { askWhereToSave: true, directory: '' };
  createMainWindow({
    appName: 'SampleProduct',
    firstLaunch: false,
    browserGuestPreloadPath: '/browser-preload.js',
    mediaPlaybackPreloadPath: '/media-playback-preload.js',
    widgetViewerPreloadPath: '/widget-preload.js',
    webpageEmbedPreloadPath: '/webpage-preload.js',
    getWebpageEmbedConnection: () => null,
    runConfigMutationExclusive: operation => operation(),
    devServerUrl: 'http://localhost:43127',
    getBackgroundColor: () => '#ffffff',
    getIconPath: () => undefined,
    getRendererPreferenceStore: () => ({ get: vi.fn(), set: vi.fn() }),
    getBrowserDownloadSettings: () => settings,
    isBrowserGuestAutomating: mocks.automating,
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
  origin = Object.assign(new EventEmitter(), {
    id: 9,
    session: browserSession,
    isDestroyed: () => false,
    setWindowOpenHandler: vi.fn(),
  });
  (window as unknown as { webContents: EventEmitter }).webContents.emit(
    'did-attach-webview',
    {},
    origin,
  );
});

test('keeps an automated guest input out of shell shortcuts and native menus until its exact lease ends', () => {
  const sendToGuest = vi.fn();
  Object.assign(origin, {
    send: sendToGuest,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    reload: vi.fn(),
  });
  const host = (window as unknown as { webContents: { send: ReturnType<typeof vi.fn> } })
    .webContents;
  const preventDefault = vi.fn();
  const key = {
    type: 'keyDown',
    key: 'p',
    control: true,
    alt: false,
    shift: false,
    meta: false,
    isAutoRepeat: false,
  };
  mocks.automating.mockImplementation(id => id === origin.id);
  origin.emit('before-input-event', { preventDefault }, key);
  origin.emit('before-input-event', { preventDefault }, { ...key, key: 'l' });
  origin.emit('context-menu', {}, {});
  expect(mocks.automating).toHaveBeenCalledWith(origin.id);
  expect(preventDefault).not.toHaveBeenCalled();
  expect(host.send).not.toHaveBeenCalledWith(BrowserIpc.PanelShortcutAction, expect.anything());
  expect(sendToGuest).not.toHaveBeenCalled();
  expect(mocks.menuPopup).not.toHaveBeenCalled();

  mocks.automating.mockReturnValue(false);
  origin.emit('before-input-event', { preventDefault }, key);
  origin.emit('before-input-event', { preventDefault }, { ...key, key: 'l' });
  origin.emit('context-menu', {}, {});
  expect(host.send).toHaveBeenCalledWith(BrowserIpc.PanelShortcutAction, 'files');
  expect(sendToGuest).toHaveBeenCalledWith(BROWSER_GUEST_COMMAND_CHANNEL, 'focus-address');
  expect(mocks.menuPopup).toHaveBeenCalledOnce();
  expect(preventDefault).toHaveBeenCalledTimes(2);
});

test.each([
  { disposition: 'foreground-tab', automating: false, presentation: BrowserTabPresentation.Foreground },
  { disposition: 'background-tab', automating: false, presentation: BrowserTabPresentation.Background },
  { disposition: 'foreground-tab', automating: true, presentation: BrowserTabPresentation.Background },
])('captures popup presentation at dispatch: %j', ({ disposition, automating, presentation }) => {
  const handler = origin.setWindowOpenHandler.mock.calls[0]![0] as (
    details: Record<string, unknown>,
  ) => { action: string };
  const host = (window as unknown as { webContents: { send: ReturnType<typeof vi.fn> } }).webContents;
  mocks.automating.mockReturnValue(automating);

  expect(handler({ url: 'https://example.com/popup', disposition })).toEqual({ action: 'deny' });
  mocks.automating.mockReturnValue(false);

  expect(host.send).toHaveBeenCalledWith(BrowserIpc.PanelOpenTab, {
    url: 'https://example.com/popup',
    openerGuestId: origin.id,
    presentation,
  });
});

test('keeps an Agent-triggered rejected POST popup in the background', () => {
  const handler = origin.setWindowOpenHandler.mock.calls[0]![0] as (
    details: Record<string, unknown>,
  ) => { action: string };
  mocks.automating.mockReturnValue(true);
  const host = (window as unknown as { webContents: { send: ReturnType<typeof vi.fn> } }).webContents;

  handler({ url: 'https://example.com/submit', disposition: 'foreground-tab', postBody: {} });

  expect(host.send).toHaveBeenCalledWith(BrowserIpc.PanelOpenTab, {
    url: 'https://example.com/submit',
    openerGuestId: origin.id,
    presentation: BrowserTabPresentation.Background,
    errorCode: 'post-navigation-blocked',
  });
});

test.each(['live', 'automating', 'destroyed'] as const)(
  'rechecks a retained native link-menu action when its source is %s', state => {
    Object.assign(origin, {
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    });
    const host = (window as unknown as { webContents: { send: ReturnType<typeof vi.fn> } }).webContents;
    origin.emit('context-menu', {}, { linkURL: 'https://example.com/link' });
    const template = mocks.menuTemplate.mock.calls.at(-1)![0] as Array<{ click?: () => void }>;
    const click = template[0]!.click!;
    if (state === 'automating') mocks.automating.mockReturnValue(true);
    if (state === 'destroyed') {
      origin.isDestroyed = () => true;
      origin.emit('destroyed');
    }

    click();

    if (state === 'live') expect(host.send).toHaveBeenCalledWith(BrowserIpc.PanelOpenTab, {
      url: 'https://example.com/link',
      openerGuestId: origin.id,
      presentation: BrowserTabPresentation.Foreground,
    });
    else expect(host.send).not.toHaveBeenCalledWith(BrowserIpc.PanelOpenTab, expect.anything());
  },
);

afterEach(() => {
  window.emit('closed');
  vi.useRealTimers();
  vi.clearAllMocks();
});

test('registers network failure diagnostics for an ordinary sidebar guest', () => {
  expect(mocks.registerDiagnostics).toHaveBeenCalledExactlyOnceWith(origin);
});

test.each(['widget', 'webpage'] as const)('leaves %s guest diagnostics with its existing owner', kind => {
  (kind === 'widget' ? mocks.attachWidget : mocks.attachWebpage).mockReturnValue(true);
  const separateGuest = Object.assign(new EventEmitter(), { id: 82 });

  (window as unknown as { webContents: EventEmitter }).webContents.emit(
    'did-attach-webview', {}, separateGuest,
  );

  expect(mocks.registerDiagnostics).toHaveBeenCalledExactlyOnceWith(origin);
});

test('uses one native save prompt configured synchronously for a download URL', async () => {
  const item = makeItem();

  browserSession.emit('will-download', {}, item, origin);

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
    browserSession.emit('will-download', {}, item, origin);
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

  browserSession.emit('will-download', {}, first, origin);
  browserSession.emit('will-download', {}, second, origin);

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

  browserSession.emit('will-download', {}, item, origin);

  expect(item.setSavePath).toHaveBeenCalledExactlyOnceWith(claim.savePath);
  expect(item.setSaveDialogOptions).not.toHaveBeenCalled();
  item.emit('done', {}, 'completed');
  expect(claim.settle).toHaveBeenCalledExactlyOnceWith(item, 'completed');
});

test('cancels its pending native save and releases UI while retaining the shared session guard', () => {
  const item = makeItem();
  browserSession.emit('will-download', {}, item, origin);

  window.emit('closed');

  expect(item.cancel).toHaveBeenCalledOnce();
  expect(browserSession.listenerCount('will-download')).toBe(1);
  const late = makeItem();
  browserSession.emit('will-download', {}, late, origin);
  expect(late.cancel).toHaveBeenCalledOnce();
  expect(late.setSaveDialogOptions).not.toHaveBeenCalled();
});

test('closing the UI preserves a different background page and its claimed download', () => {
  const background = Object.assign(new EventEmitter(), {
    id: 81,
    session: browserSession,
    isDestroyed: () => false,
  }) as unknown as Electron.WebContents;
  const lease = registerBackgroundBrowserGuest(background);
  const claim = {
    savePath: path.join(directory, 'background.zip'),
    cancelled: false,
    settle: vi.fn(),
  };
  mocks.claim.mockReturnValue(claim);

  window.emit('closed');

  expect(mocks.cancelForGuest).toHaveBeenCalledWith(origin.id);
  expect(mocks.cancelForGuest).not.toHaveBeenCalledWith(background.id);
  const download = makeItem();
  browserSession.emit('will-download', {}, download, background);
  expect(download.setSavePath).toHaveBeenCalledExactlyOnceWith(claim.savePath);
  expect(download.setSaveDialogOptions).not.toHaveBeenCalled();
  lease.release();
});
