import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { BROWSER_PANEL_PARTITION } from '../../../shared/browser/browser';
import {
  WEBPAGE_EMBED_OPEN_LINK_EVENT,
  WebpageEmbedIpc,
  type WebpageEmbedProxyState,
} from '../../../shared/browser/webpageEmbed';

const mocks = vi.hoisted(() => ({
  fromPartition: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  policy: vi.fn(),
  register: vi.fn(),
  observe: vi.fn(),
  state: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { on: mocks.on, removeListener: mocks.off },
  session: { fromPartition: mocks.fromPartition },
}));
vi.mock('../../browser/browserSessionPolicy', () => ({
  registerBrowserSessionGuestPolicy: mocks.policy,
}));
vi.mock('../network/systemProxyPreference', () => ({
  BrowserProxyStatus: { PENDING: 'pending', READY: 'ready', FAILED: 'failed' },
  registerBrowserProxySession: mocks.register,
  observeBrowserProxySession: mocks.observe,
  getBrowserProxySessionState: mocks.state,
}));

import { createBrowserSessionWebpageGuests } from './webpageBrowserGuest';

let nextId = 1;
const makeContents = (session: unknown = {}, hostWebContents?: unknown) => {
  let destroyed = false;
  const contents = Object.assign(new EventEmitter(), {
    id: nextId++,
    session,
    hostWebContents,
    getType: () => 'webview',
    isDestroyed: () => destroyed,
    send: vi.fn(),
    loadURL: vi.fn(async () => {}),
    setWindowOpenHandler: vi.fn(),
    close: vi.fn(() => {
      destroyed = true;
      contents.emit('destroyed');
    }),
  });
  return contents;
};
type Contents = ReturnType<typeof makeContents>;
const controllers: Array<ReturnType<typeof createBrowserSessionWebpageGuests>> = [];
beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
});

function fixture(initialStatus: WebpageEmbedProxyState['status'] = 'ready') {
  let current = true;
  let state: WebpageEmbedProxyState = { generation: 1, status: initialStatus };
  let observer!: (value: WebpageEmbedProxyState) => void;
  const shared = {
    storagePath: '/browser/default',
    webRequest: { onBeforeRequest: vi.fn(), onBeforeSendHeaders: vi.fn() },
    clearStorageData: vi.fn(),
    closeAllConnections: vi.fn(),
    resolveProxy: vi.fn(async () => 'DIRECT'),
    resolveHost: vi.fn(async () => ({ endpoints: [{ address: '10.20.30.40' }] })),
  };
  mocks.fromPartition.mockReturnValue(shared);
  mocks.state.mockImplementation(() => state);
  mocks.register.mockResolvedValue(undefined);
  mocks.observe.mockImplementation((_session, listener) => {
    observer = listener;
    listener(state);
    return vi.fn();
  });
  mocks.policy.mockReturnValue(vi.fn());
  const owner = makeContents();
  const controller = createBrowserSessionWebpageGuests({
    ownsHost: (actual, host) => actual === owner && host === owner,
    getCredentials: () => null,
    remoteUrl: (_binding, value) => {
      try {
        const url = new URL(value);
        return !url.username && !url.password &&
          ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) &&
          !['localhost', '127.0.0.1', 'app.internal', 'gateway.internal'].includes(url.hostname)
          ? url
          : undefined;
      } catch {
        return undefined;
      }
    },
    isBlockedHost: value => value.startsWith('127.'),
    hasProxyOnlyRoute: route => route.startsWith('PROXY ') && !route.includes('DIRECT'),
  });
  controllers.push(controller);
  const register = (id = 'edff0385-cba8-4bbc-9521-913cc8182247') =>
    controller.registerMount({
      mountId: id,
      owner: owner as never,
      targetUrl: 'https://portal.internal/page',
      shellUrl: 'http://app.internal/embed-viewer.html',
      isCurrent: () => current,
    });
  const prepare = (mount: ReturnType<typeof register>, host: Contents = owner) => {
    const event = { preventDefault: vi.fn() };
    const preferences: Electron.WebPreferences = {
      preload: '/untrusted.js',
      nodeIntegration: true,
    };
    controller.prepare(
      event as never,
      preferences,
      { partition: mount.partition, src: mount.viewerUrl },
      host as never,
    );
    return { event, preferences };
  };
  const create = (
    mount: ReturnType<typeof register>,
    host: Contents = owner,
    actualSession: unknown = shared,
  ) => {
    const guest = makeContents(actualSession, host);
    const created = mocks.on.mock.calls.find(([name]) => name === 'web-contents-created')![1];
    created({}, guest);
    guest.emit('did-start-navigation', {}, mount.viewerUrl, false, true);
    return guest;
  };
  const attach = (guest: Contents, host: Contents = owner) =>
    controller.attach(guest as never, host as never);
  const inspect = (guest: Contents, url: string, resourceType = 'xhr') =>
    new Promise<Record<string, unknown>>(resolve => {
      const call = mocks.policy.mock.calls.find(([page]) => page === guest)!;
      void call[1].beforeRequest(
        { url, resourceType, webContents: guest, webContentsId: guest.id },
        resolve,
      );
    });
  return {
    shared,
    owner,
    controller,
    register,
    prepare,
    create,
    attach,
    inspect,
    invalidate: () => {
      current = false;
    },
    setState: (status: WebpageEmbedProxyState['status']) => {
      state = { generation: state.generation + 1, status };
      observer(state);
    },
  };
}

test('hands new-window HTTP(S) links to the original owner without creating a popup or navigating the source', () => {
  const f = fixture();
  const mount = f.register();
  f.prepare(mount);
  const guest = f.create(mount);
  f.attach(guest);
  const open = guest.setWindowOpenHandler.mock.calls[0][0];
  f.owner.send.mockClear();

  expect(open({ url: 'https://destination.internal/path?q=search' })).toEqual({ action: 'deny' });
  expect(f.owner.send).toHaveBeenCalledExactlyOnceWith(WebpageEmbedIpc.Event, {
    mountId: 'edff0385-cba8-4bbc-9521-913cc8182247',
    type: WEBPAGE_EMBED_OPEN_LINK_EVENT,
    url: 'https://destination.internal/path?q=search',
  });
  expect(guest.loadURL).not.toHaveBeenCalled();
});

test('does not route unsafe targets or turn popup POST submissions into GET links', () => {
  const f = fixture();
  const mount = f.register();
  f.prepare(mount);
  const guest = f.create(mount);
  f.attach(guest);
  const open = guest.setWindowOpenHandler.mock.calls[0][0];
  f.owner.send.mockClear();

  for (const url of [
    'about:blank', 'javascript:alert(1)', 'file:///private/file',
    'ws://destination.internal/socket', 'wss://destination.internal/socket',
    'http://127.0.0.1:18789/', 'http://localhost/',
    'http://app.internal/', 'http://gateway.internal/',
    'https://user:password@destination.internal/',
  ]) expect(open({ url })).toEqual({ action: 'deny' });
  expect(open({ url: 'https://destination.internal/form', postBody: { data: [] } }))
    .toEqual({ action: 'deny' });
  expect(f.owner.send).not.toHaveBeenCalled();
});

test('ignores new-window links while the proxy or source binding is unavailable', () => {
  const f = fixture();
  const mount = f.register();
  f.prepare(mount);
  const guest = f.create(mount);
  f.attach(guest);
  const open = guest.setWindowOpenHandler.mock.calls[0][0];
  for (const status of ['pending', 'failed'] as const) {
    f.setState(status);
    f.owner.send.mockClear();
    expect(open({ url: 'https://destination.internal/' })).toEqual({ action: 'deny' });
    expect(f.owner.send).not.toHaveBeenCalled();
  }
  f.setState('ready');
  f.invalidate();
  f.owner.send.mockClear();
  expect(open({ url: 'https://destination.internal/' })).toEqual({ action: 'deny' });
  expect(f.owner.send).not.toHaveBeenCalled();
});

test('uses the sidebar session without loading an app shell or installing profile handlers', async () => {
  const f = fixture();
  const mount = f.register();
  const { preferences, event } = f.prepare(mount);
  expect(event.preventDefault).not.toHaveBeenCalled();
  expect(mocks.fromPartition).toHaveBeenCalledWith(BROWSER_PANEL_PARTITION);
  expect(preferences.session).toBe(f.shared);
  expect(preferences.preload).toBeUndefined();
  expect(preferences).toMatchObject({
    nodeIntegration: false,
    contextIsolation: true,
    webSecurity: true,
    sandbox: true,
  });
  expect(mount.viewerUrl).toMatch(/^data:text\/html/);
  expect(decodeURIComponent(mount.viewerUrl)).not.toContain('<script');
  const guest = f.create(mount);
  expect(f.attach(guest)).toBe(true);
  expect(guest.loadURL).not.toHaveBeenCalled();
  guest.emit('dom-ready');
  expect(guest.loadURL).toHaveBeenCalledExactlyOnceWith('https://portal.internal/page');
  expect(f.shared.webRequest.onBeforeRequest).not.toHaveBeenCalled();
  expect(f.shared.webRequest.onBeforeSendHeaders).not.toHaveBeenCalled();
});

test('two same-URL mounts claim exact startup identities and releasing one preserves the other and profile', () => {
  const f = fixture();
  const left = f.register();
  const right = f.register('5d42d305-4ee3-4ef9-b89c-2dc74b859b7d');
  expect(left.partition).not.toBe(right.partition);
  expect(left.viewerUrl).not.toBe(right.viewerUrl);
  f.prepare(left);
  f.prepare(right);
  // Native creations may arrive in the opposite order from prepared mounts.
  const rightGuest = f.create(right);
  const leftGuest = f.create(left);
  expect(f.attach(leftGuest)).toBe(true);
  expect(f.attach(rightGuest)).toBe(true);
  leftGuest.emit('dom-ready');
  rightGuest.emit('dom-ready');
  f.controller.release(f.owner as never, 'edff0385-cba8-4bbc-9521-913cc8182247');
  expect(leftGuest.close).toHaveBeenCalledOnce();
  expect(rightGuest.close).not.toHaveBeenCalled();
  expect(f.shared.clearStorageData).not.toHaveBeenCalled();
  expect(f.shared.closeAllConnections).not.toHaveBeenCalled();
  expect(f.owner.listenerCount('did-start-navigation')).toBe(1);
});

test.each(['unprepared', 'owner', 'session', 'retired', 'replay'])(
  'rejects %s startup identity without falling back to the browser',
  kind => {
    const f = fixture();
    const mount = f.register();
    if (kind !== 'unprepared') f.prepare(mount);
    if (kind === 'retired')
      f.controller.release(f.owner as never, 'edff0385-cba8-4bbc-9521-913cc8182247');
    if (kind === 'replay') {
      const first = f.create(mount);
      f.attach(first);
    }
    const guest = f.create(
      mount,
      kind === 'owner' ? makeContents() : f.owner,
      kind === 'session' ? { storagePath: '/different/profile' } : f.shared,
    );
    expect(guest.close).toHaveBeenCalledOnce();
    expect(f.attach(guest)).toBe(true);
  },
);

test('does not consume ordinary sidebar pages sharing the same session', () => {
  const f = fixture();
  const mount = f.register();
  f.prepare(mount);
  const sidebar = f.create({ ...mount, viewerUrl: 'https://portal.internal/page' });
  expect(f.attach(sidebar)).toBe(false);
  expect(sidebar.close).not.toHaveBeenCalled();
});

test('a startup URL cannot borrow the ordinary browser prepare path', () => {
  const f = fixture();
  const mount = f.register();
  const event = { preventDefault: vi.fn() };
  const preferences: Electron.WebPreferences = { preload: '/browser-preload.js' };
  expect(
    f.controller.prepare(
      event as never,
      preferences,
      { src: mount.viewerUrl, partition: BROWSER_PANEL_PARTITION },
      f.owner as never,
    ),
  ).toBe(true);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  const attempted = f.create(mount);
  expect(attempted.close).toHaveBeenCalledOnce();
  expect(f.attach(attempted)).toBe(true);
});

test('waits for both proxy and startup, retries an unstarted page once and preserves a running page', async () => {
  const f = fixture('pending');
  const mount = f.register();
  f.prepare(mount);
  const guest = f.create(mount);
  f.attach(guest);
  f.setState('ready');
  expect(guest.loadURL).not.toHaveBeenCalled();
  f.setState('failed');
  guest.emit('dom-ready');
  expect(guest.loadURL).not.toHaveBeenCalled();
  f.setState('ready');
  expect(guest.loadURL).toHaveBeenCalledOnce();
  f.setState('pending');
  f.setState('failed');
  f.setState('ready');
  await f.controller.retry(f.owner as never, 'edff0385-cba8-4bbc-9521-913cc8182247');
  expect(guest.loadURL).toHaveBeenCalledOnce();
  expect(guest.close).not.toHaveBeenCalled();
});

test('protects app/control origins, DNS results and proxy generations on the shared page', async () => {
  const f = fixture();
  const mount = f.register();
  f.prepare(mount);
  const guest = f.create(mount);
  f.attach(guest);
  guest.emit('dom-ready');
  await expect(f.inspect(guest, 'http://app.internal/private')).resolves.toEqual({ cancel: true });
  await expect(f.inspect(guest, 'http://gateway.internal/rpc')).resolves.toEqual({ cancel: true });
  await expect(f.inspect(guest, 'https://portal.internal/api')).resolves.toEqual({ cancel: false });
  f.shared.resolveHost.mockResolvedValueOnce({ endpoints: [{ address: '127.0.0.1' }] });
  await expect(f.inspect(guest, 'https://portal.internal/api')).resolves.toEqual({ cancel: true });
  let resolve!: (value: { endpoints: { address: string }[] }) => void;
  f.shared.resolveHost.mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done;
      }),
  );
  const late = f.inspect(guest, 'https://portal.internal/late');
  await Promise.resolve();
  f.setState('pending');
  f.setState('ready');
  resolve({ endpoints: [{ address: '10.20.30.40' }] });
  await expect(late).resolves.toEqual({ cancel: true });
});

test('reports protected main redirects but does not treat a nested rejection as whole-page failure', () => {
  const f = fixture();
  const mount = f.register();
  f.prepare(mount);
  const guest = f.create(mount);
  f.attach(guest);
  guest.emit('dom-ready');
  f.owner.send.mockClear();
  const nested = { isMainFrame: false, preventDefault: vi.fn() };
  guest.emit('will-redirect', nested, 'http://app.internal/private');
  expect(nested.preventDefault).toHaveBeenCalledOnce();
  expect(f.owner.send).not.toHaveBeenCalled();
  const main = { isMainFrame: true, preventDefault: vi.fn() };
  guest.emit('will-redirect', main, 'http://gateway.internal/rpc');
  expect(main.preventDefault).toHaveBeenCalledOnce();
  expect(f.owner.send).toHaveBeenCalledWith(WebpageEmbedIpc.Event, {
    mountId: 'edff0385-cba8-4bbc-9521-913cc8182247',
    type: 'failure',
  });
});

test('an aborted initial SSO load and stale failure do not close a valid replacement navigation', async () => {
  const f = fixture();
  const mount = f.register();
  f.prepare(mount);
  const guest = f.create(mount);
  f.attach(guest);
  guest.loadURL.mockRejectedValueOnce(
    Object.assign(new Error('Navigation replaced'), { code: 'ERR_ABORTED', errno: -3 }),
  );
  f.owner.send.mockClear();
  guest.emit('dom-ready');
  guest.emit('did-start-navigation', {}, 'https://portal.internal/login', false, true);
  await Promise.resolve();
  guest.emit('did-fail-load', {}, -3, 'aborted', 'https://portal.internal/login', true);
  guest.emit('did-fail-load', {}, -2, 'stale failure', 'https://portal.internal/page', true);
  expect(f.owner.send).not.toHaveBeenCalled();
  expect(guest.close).not.toHaveBeenCalled();
  guest.emit('did-fail-load', {}, -2, 'connection failed', 'https://portal.internal/login', true);
  expect(f.owner.send).toHaveBeenCalledWith(WebpageEmbedIpc.Event, {
    mountId: 'edff0385-cba8-4bbc-9521-913cc8182247',
    type: 'failure',
  });
});

test('source retirement removes listeners, stops the guest and leaves shared storage untouched', () => {
  const f = fixture();
  const mount = f.register();
  f.prepare(mount);
  const guest = f.create(mount);
  f.attach(guest);
  guest.emit('dom-ready');
  f.owner.emit('did-start-navigation', {}, 'https://new.invalid', false, true);
  expect(guest.close).toHaveBeenCalledOnce();
  expect(f.owner.listenerCount('did-start-navigation')).toBe(0);
  expect(f.shared.closeAllConnections).not.toHaveBeenCalled();
  expect(f.shared.clearStorageData).not.toHaveBeenCalled();
  f.controller.dispose();
  expect(mocks.off).toHaveBeenCalledWith('web-contents-created', expect.any(Function));
});
