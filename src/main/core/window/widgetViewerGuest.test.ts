import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WIDGET_VIEWER_PARTITION, WidgetViewerIpc } from '../../../shared/widgets/viewer';

const mocks = vi.hoisted(() => ({ handle: vi.fn(), register: vi.fn(), fromPartition: vi.fn() }));
vi.mock('electron', () => ({
  ipcMain: { handle: mocks.handle },
  session: { fromPartition: mocks.fromPartition },
}));
vi.mock('../network/systemProxyPreference', () => ({
  registerBrowserProxySession: mocks.register,
}));
import { createWidgetViewerGuests } from './widgetViewerGuest';

const mount = '2e4ec192-521e-4b76-b132-e34598e41bb2';
const ownerUrl = 'http://127.0.0.1:43127/index.html';
const viewerUrl = `http://127.0.0.1:43127/widget-viewer.html?mount=${mount}`;
let nextId = 1;
function contents(url: string, session: unknown = {}) {
  return Object.assign(new EventEmitter(), {
    id: nextId++,
    session,
    mainFrame: { url },
    getURL: () => url,
    isDestroyed: vi.fn(() => false),
    close: vi.fn(),
    stop: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  });
}
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.register.mockResolvedValue(undefined);
});
describe('native widget guest boundary', () => {
  it('admits a later retry after an earlier proxy registration failed', async () => {
    const session = Object.assign(new EventEmitter(), {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
    });
    mocks.fromPartition.mockReturnValue(session);
    mocks.register
      .mockRejectedValueOnce(new Error('Startup proxy failed'))
      .mockRejectedValueOnce(new Error('First admission proxy failed'))
      .mockResolvedValue(undefined);
    const module = await import('./widgetViewerGuest');
    const controller = module.createWidgetViewerGuests('widget-preload.js', () => null);
    const host = contents(ownerUrl);
    const first = contents(viewerUrl, session);
    controller.attach(
      first as unknown as Electron.WebContents,
      host as unknown as Electron.WebContents,
    );
    const handler = mocks.handle.mock.calls.find(
      ([channel]) => channel === WidgetViewerIpc.ProxyReady,
    )![1];
    const firstEvent = { sender: first, senderFrame: first.mainFrame };
    await expect(handler(firstEvent)).rejects.toThrow('First admission proxy failed');
    const retry = contents(viewerUrl, session);
    controller.attach(
      retry as unknown as Electron.WebContents,
      host as unknown as Electron.WebContents,
    );
    await expect(handler({ sender: retry, senderFrame: retry.mainFrame })).resolves.toBeUndefined();
    // A successful later admission cannot revive the failed guest's authority.
    await expect(handler(firstEvent)).rejects.toThrow('First admission proxy failed');
    expect(mocks.register).toHaveBeenCalledTimes(3);
  });
  it('assigns the minimal preload only to the fixed current application page', () => {
    const session = Object.assign(new EventEmitter(), {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
    });
    mocks.fromPartition.mockReturnValue(session);
    const controller = createWidgetViewerGuests('widget-preload.js', () => null);
    const host = contents(ownerUrl) as unknown as Electron.WebContents;
    const event = { preventDefault: vi.fn() };
    const prefs: Electron.WebPreferences = {};
    expect(
      controller.prepare(
        event as unknown as Electron.Event,
        prefs,
        { partition: WIDGET_VIEWER_PARTITION, src: viewerUrl },
        host,
      ),
    ).toBe(true);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(prefs).toMatchObject({
      session,
      partition: WIDGET_VIEWER_PARTITION,
      preload: 'widget-preload.js',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      disableDialogs: true,
    });
    controller.prepare(
      event as unknown as Electron.Event,
      {},
      { partition: WIDGET_VIEWER_PARTITION, src: 'https://external.invalid/widget-viewer.html' },
      host,
    );
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(mocks.fromPartition).toHaveBeenCalledWith(WIDGET_VIEWER_PARTITION, { cache: false });
  });

  it('waits for the proxy, scopes readiness to the admitted guest, and revokes on owner navigation', async () => {
    const session = Object.assign(new EventEmitter(), {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
    });
    mocks.fromPartition.mockReturnValue(session);
    let release!: () => void;
    mocks.register.mockReturnValue(
      new Promise<void>(resolve => {
        release = resolve;
      }),
    );
    // A fresh module installs its handler once, as the application does.
    const module = await import('./widgetViewerGuest');
    const controller = module.createWidgetViewerGuests('widget-preload.js', () => null);
    const host = contents(ownerUrl);
    const guest = contents(viewerUrl, session);
    controller.attach(
      guest as unknown as Electron.WebContents,
      host as unknown as Electron.WebContents,
    );
    const handler = mocks.handle.mock.calls.find(
      ([channel]) => channel === WidgetViewerIpc.ProxyReady,
    )![1];
    const event = { sender: guest, senderFrame: guest.mainFrame };
    let ready = false;
    const pending = handler(event).then(() => {
      ready = true;
    });
    await Promise.resolve();
    expect(ready).toBe(false);
    await expect(handler({ sender: guest, senderFrame: { url: viewerUrl } })).rejects.toThrow();
    release();
    await pending;
    expect(ready).toBe(true);
    host.emit('did-start-navigation', {}, ownerUrl, false, true);
    expect(guest.close).toHaveBeenCalledOnce();
    await expect(handler(event)).rejects.toThrow();
  });

  it('fails closed on proxy initialization and supplies credentials only to the exact proxy', async () => {
    const session = Object.assign(new EventEmitter(), {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
    });
    mocks.fromPartition.mockReturnValue(session);
    mocks.register.mockRejectedValue(new Error('Proxy configuration failed'));
    const module = await import('./widgetViewerGuest');
    const controller = module.createWidgetViewerGuests('widget-preload.js', () => ({
      host: 'proxy.local',
      port: 8181,
      username: 'fixture',
      password: 'fixture-password',
    }));
    const host = contents(ownerUrl);
    const guest = contents(viewerUrl, session);
    controller.attach(
      guest as unknown as Electron.WebContents,
      host as unknown as Electron.WebContents,
    );
    const handler = mocks.handle.mock.calls.find(
      ([channel]) => channel === WidgetViewerIpc.ProxyReady,
    )![1];
    await expect(handler({ sender: guest, senderFrame: guest.mainFrame })).rejects.toThrow(
      'Proxy configuration failed',
    );
    const challenge = (isProxy: boolean, host: string, port: number) => {
      const callback = vi.fn();
      guest.emit('login', { preventDefault: vi.fn() }, {}, { isProxy, host, port }, callback);
      return callback;
    };
    expect(challenge(true, 'proxy.local', 8181)).toHaveBeenCalledWith(
      'fixture',
      'fixture-password',
    );
    expect(challenge(false, 'proxy.local', 8181)).toHaveBeenCalledWith();
    expect(challenge(true, 'another.local', 8181)).toHaveBeenCalledWith();
    expect(challenge(true, 'proxy.local', 8182)).toHaveBeenCalledWith();
    const download = { preventDefault: vi.fn() };
    session.emit('will-download', download);
    expect(download.preventDefault).toHaveBeenCalledOnce();
    const navigation = { preventDefault: vi.fn() };
    guest.emit('will-navigate', navigation);
    expect(navigation.preventDefault).toHaveBeenCalledOnce();
    expect(guest.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: 'deny' });
  });
});
