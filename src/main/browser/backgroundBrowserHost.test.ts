import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  windows: [] as unknown[],
  sessions: new Map<string, unknown>(),
  proxyReady: vi.fn(async () => {}),
  credentials: vi.fn((): unknown => null),
  policy: vi.fn(),
  cancelDownloads: vi.fn(),
  windowCreated: vi.fn(),
}));

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  const fromPartition = vi.fn((partition: string) => {
    let current = mocks.sessions.get(partition);
    if (!current) {
      current = Object.assign(new EventEmitter(), {
        partition,
        storagePath: `C:/profiles/${partition}`,
        setPermissionCheckHandler: vi.fn(),
        setPermissionRequestHandler: vi.fn(),
        setDevicePermissionHandler: vi.fn(),
        setDisplayMediaRequestHandler: vi.fn(),
        closeAllConnections: vi.fn(async () => {}),
        clearStorageData: vi.fn(async () => {}),
        serviceWorkers: { getAllRunning: vi.fn(() => ({ 1: { scope: 'https://site.example' } })) },
        webRequest: { onBeforeRequest: vi.fn() },
      });
      mocks.sessions.set(partition, current);
    }
    return current;
  });
  class BrowserWindow extends EventEmitter {
    destroyed = false;
    webContents: EventEmitter & {
      id: number;
      destroyed: boolean;
      isDestroyed: () => boolean;
      session: unknown;
      loadURL: ReturnType<typeof vi.fn>;
      setWindowOpenHandler: ReturnType<typeof vi.fn>;
    };
    constructor(readonly options: { webPreferences: { session: unknown } }) {
      super();
      this.webContents = Object.assign(new EventEmitter(), {
        id: mocks.windows.length + 10000,
        destroyed: false,
        isDestroyed() {
          return this.destroyed;
        },
        session: options.webPreferences.session,
        loadURL: vi.fn(async () => {}),
        setWindowOpenHandler: vi.fn(),
      });
      mocks.windows.push(this);
      mocks.windowCreated(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy = vi.fn(() => {
      this.destroyed = true;
      this.webContents.destroyed = true;
      this.webContents.emit('destroyed');
      this.emit('closed');
    });
  }
  return { BrowserWindow, session: { fromPartition } };
});
vi.mock('../core/network/systemProxyPreference', () => ({
  registerBrowserProxySession: mocks.proxyReady,
  getBrowserProxyCredentials: mocks.credentials,
}));
vi.mock('./browserSessionPolicy', () => ({ ensureBrowserSessionPolicy: mocks.policy }));
vi.mock('./downloads/browserAgentDownloadCoordinator', () => ({
  cancelBrowserAgentDownloadsForWebContents: mocks.cancelDownloads,
}));

import { browserPartitionForProfile } from '../../shared/browser/browser';
import {
  captureBackgroundBrowserRequest,
  isBackgroundBrowserGuest,
} from './backgroundBrowserGuestRegistry';
import { BackgroundBrowserHost } from './backgroundBrowserHost';
import { reserveBackgroundBrowserStorageClear } from './data/backgroundBrowserStorage';

type BrowserSession = EventEmitter & {
  partition: string;
  storagePath: string;
  setPermissionCheckHandler: ReturnType<typeof vi.fn>;
  setPermissionRequestHandler: ReturnType<typeof vi.fn>;
  setDevicePermissionHandler: ReturnType<typeof vi.fn>;
  setDisplayMediaRequestHandler: ReturnType<typeof vi.fn>;
  closeAllConnections: ReturnType<typeof vi.fn>;
  clearStorageData: ReturnType<typeof vi.fn>;
  serviceWorkers: { getAllRunning: ReturnType<typeof vi.fn> };
  webRequest: { onBeforeRequest: ReturnType<typeof vi.fn> };
};
type Window = EventEmitter & {
  options: Record<string, unknown> & { webPreferences: Record<string, unknown> };
  webContents: EventEmitter & {
    id: number;
    session: BrowserSession;
    destroyed: boolean;
    loadURL: ReturnType<typeof vi.fn>;
    setWindowOpenHandler: ReturnType<typeof vi.fn>;
  };
  destroy: ReturnType<typeof vi.fn>;
};
const request = {
  scopeId: 'scope-one',
  sessionId: 'session-one',
  profile: 'embedded',
  targetId: 'page-one',
};
const currentWindow = () => mocks.windows.at(-1) as Window;
const hosts: BackgroundBrowserHost[] = [];
const createHost = () => {
  const host = new BackgroundBrowserHost();
  hosts.push(host);
  return host;
};
const reference = (webContentsId: number) => ({ ...request, webContentsId });

beforeEach(() => {
  mocks.windows.length = 0;
  mocks.sessions.clear();
  mocks.proxyReady.mockReset().mockResolvedValue(undefined);
  mocks.credentials.mockReset().mockReturnValue(null);
  mocks.policy.mockReset();
  mocks.cancelDownloads.mockReset();
  mocks.windowCreated.mockReset();
});
afterEach(async () => {
  for (const host of hosts) host.stop();
  for (const window of mocks.windows as Window[]) window.destroy();
  await Promise.all(hosts.splice(0).map(host => host.waitForDrain()));
});

it('creates a hidden sandboxed guest in the same persistent profile used by the sidebar', async () => {
  const host = createHost();
  const guest = await host.create(request);
  const window = currentWindow();
  expect(window.options).toMatchObject({
    show: false,
    focusable: false,
    skipTaskbar: true,
    useContentSize: true,
    webPreferences: {
      preload: undefined,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      backgroundThrottling: false,
      offscreen: true,
    },
  });
  expect(window.webContents.session.partition).toBe(browserPartitionForProfile('embedded'));
  expect(mocks.policy).toHaveBeenCalledExactlyOnceWith(window.webContents.session);
  expect(isBackgroundBrowserGuest(guest)).toBe(true);
  expect(window.webContents.loadURL).toHaveBeenCalledExactlyOnceWith('about:blank');
  expect(host.owns(reference(guest.id), guest)).toBe(true);
  expect(host.owns({ ...reference(guest.id), sessionId: 'other' }, guest)).toBe(false);
  expect(host.owns({ ...reference(guest.id), profile: 'other' }, guest)).toBe(false);
  expect(host.owns({ ...reference(guest.id), targetId: 'other' }, guest)).toBe(false);
  expect(host.owns(reference(guest.id), { ...guest } as never)).toBe(false);
});

it('lets separate executions share login storage while retaining separate pages and scope ownership', async () => {
  const host = createHost();
  const first = await host.create(request);
  const second = await host.create({ ...request, scopeId: 'two', sessionId: 'two' });
  expect(mocks.sessions.size).toBe(1);
  expect(first.session).toBe(second.session);
  host.closeScope(request.sessionId);
  await host.waitForDrain();
  expect(host.has(first.id)).toBe(false);
  expect(host.has(second.id)).toBe(true);
  expect(mocks.windows).toHaveLength(2);
});

it('keeps different user-selected profiles separate', async () => {
  const host = createHost();
  await host.create(request);
  await host.create({ ...request, profile: 'imported' });
  expect([...mocks.sessions.keys()]).toEqual([
    browserPartitionForProfile('embedded'),
    browserPartitionForProfile('imported'),
  ]);
});

it('never changes session handlers, closes shared connections, clears login data or stops profile workers', async () => {
  const host = createHost();
  const guest = await host.create(request);
  const browserSession = currentWindow().webContents.session;
  host.close(guest.id);
  await host.waitForDrain();
  host.stop();
  for (const method of [
    'setPermissionCheckHandler',
    'setPermissionRequestHandler',
    'setDevicePermissionHandler',
    'setDisplayMediaRequestHandler',
    'closeAllConnections',
    'clearStorageData',
  ] as const)
    expect(browserSession[method]).not.toHaveBeenCalled();
  expect(browserSession.webRequest.onBeforeRequest).not.toHaveBeenCalled();
  expect(browserSession.listenerCount('will-download')).toBe(0);
  expect(browserSession.serviceWorkers.getAllRunning).not.toHaveBeenCalled();
});

it('rejects duplicate pages and can create a fresh page after a creation failure', async () => {
  const host = createHost();
  mocks.proxyReady.mockRejectedValueOnce(new Error('proxy failed'));
  await expect(host.create(request)).rejects.toThrow('proxy failed');
  await host.waitForDrain();
  await host.create(request);
  await expect(host.create(request)).rejects.toThrow('already being created or open');
});

it('revokes page admission immediately but retains the data-clear lease until exact guest destruction', async () => {
  const host = createHost();
  const guest = await host.create(request);
  const window = currentWindow();
  const admission = captureBackgroundBrowserRequest(guest.session, { webContentsId: guest.id });
  expect(admission?.()).toBe(true);
  window.destroy.mockImplementation(() => {});
  host.close(guest.id);
  expect(admission?.()).toBe(false);
  expect(host.has(guest.id)).toBe(false);
  expect(reserveBackgroundBrowserStorageClear()).toBeNull();
  let drained = false;
  const drainage = host.waitForDrain().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  window.emit('closed');
  expect(reserveBackgroundBrowserStorageClear()).toBeNull();
  window.webContents.destroyed = true;
  window.webContents.emit('destroyed');
  await drainage;
  expect(drained).toBe(true);
  const releaseClear = reserveBackgroundBrowserStorageClear();
  expect(releaseClear).not.toBeNull();
  releaseClear!();
});

it('holds data-clear admission across pending creation and lets abort finish without proxy resolution', async () => {
  const host = createHost();
  const controller = new AbortController();
  let releaseProxy!: () => void;
  mocks.proxyReady.mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        releaseProxy = resolve;
      }),
  );
  const creating = host.create({ ...request, signal: controller.signal });
  expect(reserveBackgroundBrowserStorageClear()).toBeNull();
  controller.abort();
  await expect(creating).rejects.toThrow();
  await host.waitForDrain();
  expect(mocks.windows).toHaveLength(0);
  const releaseClear = reserveBackgroundBrowserStorageClear();
  expect(releaseClear).not.toBeNull();
  releaseClear!();
  releaseProxy();
});

it.each(['stop', 'closeScope', 'abort'] as const)(
  'revokes pending creation on %s',
  async action => {
    const host = createHost();
    const controller = new AbortController();
    let releaseProxy!: () => void;
    mocks.proxyReady.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          releaseProxy = resolve;
        }),
    );
    const creating = host.create({ ...request, signal: controller.signal });
    if (action === 'stop') host.stop();
    else if (action === 'closeScope') host.closeScope(request.sessionId);
    else controller.abort();
    await expect(creating).rejects.toThrow();
    await host.waitForDrain();
    releaseProxy();
    expect(mocks.windows).toHaveLength(0);
    await host.create(request);
  },
);

it('waits for guest destruction when cancellation arrives during its initial page load', async () => {
  const host = createHost();
  const controller = new AbortController();
  let loadPage!: () => void;
  mocks.windowCreated.mockImplementationOnce((window: Window) => {
    window.webContents.loadURL.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          loadPage = resolve;
        }),
    );
    window.destroy.mockImplementation(() => {});
  });
  const creating = host.create({ ...request, signal: controller.signal });
  await vi.waitFor(() => expect(mocks.windows).toHaveLength(1));
  controller.abort();
  await expect(creating).rejects.toThrow();
  let drained = false;
  const drainage = host.waitForDrain().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  expect(reserveBackgroundBrowserStorageClear()).toBeNull();
  const window = currentWindow();
  window.webContents.destroyed = true;
  window.webContents.emit('destroyed');
  await drainage;
  loadPage();
  expect(drained).toBe(true);
  expect(host.has(window.webContents.id)).toBe(false);
});

it('revokes crashed pages and rejects popup/private navigation without changing shared profile data', async () => {
  const host = createHost();
  const guest = await host.create(request);
  const window = currentWindow();
  expect(
    window.webContents.setWindowOpenHandler.mock.calls[0][0]({ url: 'https://site.example' }),
  ).toEqual({ action: 'deny' });
  for (const eventName of ['will-navigate', 'will-redirect']) {
    const event = { preventDefault: vi.fn() };
    window.webContents.emit(eventName, event, 'app-private://secret');
    expect(event.preventDefault).toHaveBeenCalledOnce();
  }
  const nested = { preventDefault: vi.fn() };
  window.webContents.emit('will-attach-webview', nested);
  expect(nested.preventDefault).toHaveBeenCalledOnce();
  window.webContents.emit('render-process-gone', {}, {});
  await host.waitForDrain();
  expect(host.has(guest.id)).toBe(false);
});

it('answers only the configured proxy challenge and reports site authentication without an OS prompt', async () => {
  const host = createHost();
  const guest = await host.create(request);
  const window = currentWindow();
  mocks.credentials.mockReturnValue({
    host: 'proxy.internal',
    port: 8080,
    username: 'user',
    password: 'synthetic',
  });
  const authenticate = (info: unknown) => {
    const callback = vi.fn();
    const event = { preventDefault: vi.fn() };
    window.webContents.emit('login', event, {}, info, callback);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    return callback;
  };
  expect(
    authenticate({ isProxy: true, host: 'PROXY.internal', port: 8080 }),
  ).toHaveBeenCalledExactlyOnceWith('user', 'synthetic');
  expect(
    authenticate({ isProxy: true, host: 'wrong.internal', port: 8080 }),
  ).toHaveBeenCalledExactlyOnceWith();
  expect(
    authenticate({ isProxy: false, host: 'site.internal', port: 443 }),
  ).toHaveBeenCalledExactlyOnceWith();
  expect(host.getFailure(guest.id)).toContain('HTTP authentication requires');
  window.webContents.emit('did-start-navigation', {}, 'https://site.internal', false, true);
  expect(host.getFailure(guest.id)).toBeNull();
});
