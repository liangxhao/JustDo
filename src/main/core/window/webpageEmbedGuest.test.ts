import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WebpageEmbedIpc, type WebpageEmbedProxyState } from '../../../shared/browser/webpageEmbed';

const mocks = vi.hoisted(() => ({
  fromPartition: vi.fn(),
  register: vi.fn(),
  unregister: vi.fn(),
  observe: vi.fn(),
  state: vi.fn(),
  credentials: vi.fn(),
  frame: vi.fn(),
}));
vi.mock('electron', () => ({
  session: { fromPartition: mocks.fromPartition },
  webFrameMain: { fromId: mocks.frame },
}));
vi.mock('../network/systemProxyPreference', () => ({
  BrowserProxyStatus: { PENDING: 'pending', READY: 'ready', FAILED: 'failed' },
  registerBrowserProxySession: mocks.register,
  unregisterBrowserProxySession: mocks.unregister,
  observeBrowserProxySession: mocks.observe,
  getBrowserProxySessionState: mocks.state,
  getBrowserProxyCredentials: mocks.credentials,
}));

import {
  createWebpageEmbedGuests,
  hasProxyOnlyWebpageRoute,
  isBlockedWebpageEmbedHost,
} from './webpageEmbedGuest';

const mountId = 'edff0385-cba8-4bbc-9521-913cc8182247';
const secondMountId = '5d42d305-4ee3-4ef9-b89c-2dc74b859b7d';
const applicationUrl = 'http://127.0.0.1:43127/index.html';
const shellUrl = `http://127.0.0.1:43127/embed-viewer.html?mount=${mountId}`;
const states = new Map<unknown, WebpageEmbedProxyState>();
const listeners = new Map<unknown, (state: WebpageEmbedProxyState) => void>();
let nextId = 1;

function contents(url: string, targetSession: unknown = {}) {
  let destroyed = false;
  const result = Object.assign(new EventEmitter(), {
    id: nextId++,
    session: targetSession,
    mainFrame: { url, parent: null },
    getURL: () => url,
    getType: () => 'webview',
    isDestroyed: () => destroyed,
    stop: vi.fn(),
    send: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    close: vi.fn(() => {
      destroyed = true;
      result.emit('destroyed');
    }),
  });
  return result;
}
function memorySession() {
  return Object.assign(new EventEmitter(), {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    closeAllConnections: vi.fn().mockResolvedValue(undefined),
    clearStorageData: vi.fn().mockResolvedValue(undefined),
    resolveHost: vi.fn().mockResolvedValue({ endpoints: [{ address: '10.20.30.40' }] }),
    resolveProxy: vi.fn().mockResolvedValue('DIRECT'),
    webRequest: {
      onBeforeRequest: vi.fn(),
      onBeforeSendHeaders: vi.fn(),
      onHeadersReceived: vi.fn(),
    },
  });
}
function setState(targetSession: unknown, state: WebpageEmbedProxyState) {
  states.set(targetSession, state);
  listeners.get(targetSession)?.(state);
}

beforeEach(() => {
  vi.clearAllMocks();
  states.clear();
  listeners.clear();
  mocks.fromPartition.mockImplementation(() => memorySession());
  mocks.state.mockImplementation(
    target => states.get(target) ?? { generation: 0, status: 'pending' },
  );
  mocks.observe.mockImplementation((target, listener) => {
    listeners.set(target, listener);
    listener(mocks.state(target));
    return () => listeners.delete(target);
  });
  mocks.register.mockImplementation(async target =>
    setState(target, { generation: 1, status: 'ready' }),
  );
  mocks.credentials.mockReturnValue(null);
  mocks.frame.mockReturnValue(undefined);
});

function fixture(
  overrides: {
    targetUrl?: string;
    allowsHostedRequest?: (url: string) => boolean;
    hostedRequestHeaders?: Record<string, string>;
    developmentCsp?: { isDev: boolean; devServerPort: number };
  } = {},
) {
  const owner = contents(applicationUrl);
  const surface = contents('http://127.0.0.1:43127/workspace.html?surface=granted');
  const ownsHost = vi.fn(
    (actualOwner, host) => actualOwner === owner && (host === owner || host === surface),
  );
  const controller = createWebpageEmbedGuests({
    preloadPath: 'embed-preload.js',
    ownsHost,
    developmentCsp: overrides.developmentCsp,
  });
  let current = true;
  const dispose = vi.fn();
  const { partition } = controller.registerMount({
    mountId,
    owner: owner as unknown as Electron.WebContents,
    shellUrl,
    targetUrl: overrides.targetUrl ?? 'https://portal.internal/page',
    gatewayOrigin: 'ws://gateway.internal:18789',
    isCurrent: () => current,
    dispose,
    ...overrides,
  });
  const targetSession = mocks.fromPartition.mock.results.at(-1)!.value as ReturnType<
    typeof memorySession
  >;
  const guest = contents(shellUrl, targetSession);
  const prepare = (host = owner, src = shellUrl, actualPartition = partition) => {
    const event = { preventDefault: vi.fn() };
    const preferences: Electron.WebPreferences = {};
    const handled = controller.prepare(
      event as unknown as Electron.Event,
      preferences,
      { partition: actualPartition, src },
      host as unknown as Electron.WebContents,
    );
    return { event, preferences, handled };
  };
  const attach = (host = owner) =>
    controller.attach(
      guest as unknown as Electron.WebContents,
      host as unknown as Electron.WebContents,
    );
  const read = (senderFrame: unknown = guest.mainFrame) =>
    controller.read({
      sender: guest,
      senderFrame,
    } as unknown as Electron.IpcMainInvokeEvent);
  const request = (
    url: string,
    resourceType = 'subFrame',
    frame: unknown = { url, parent: guest.mainFrame },
  ) =>
    new Promise<Record<string, unknown>>(resolve => {
      const handler = targetSession.webRequest.onBeforeRequest.mock.calls.at(-1)![0];
      handler({ url, resourceType, frame, webContentsId: guest.id }, resolve);
    });
  const headers = (url: string, requestHeaders: Record<string, string> = {}) =>
    new Promise<Record<string, unknown>>(resolve => {
      const handler = targetSession.webRequest.onBeforeSendHeaders.mock.calls.at(-1)![0];
      handler(
        {
          url,
          resourceType: 'xhr',
          frame: { url: 'https://portal.internal/page' },
          requestHeaders,
        },
        resolve,
      );
    });
  return {
    controller,
    owner,
    surface,
    guest,
    targetSession,
    partition,
    prepare,
    attach,
    read,
    request,
    headers,
    dispose,
    invalidate: () => {
      current = false;
    },
  };
}

describe('independent webpage guest admission', () => {
  it('uses a unique memory session and only the exact fixed shell receives its minimal preload', async () => {
    const f = fixture();
    const wrong = f.prepare(f.owner, 'https://foreign.invalid/embed-viewer.html');
    expect(wrong.handled).toBe(true);
    expect(wrong.event.preventDefault).toHaveBeenCalledOnce();
    const accepted = f.prepare(f.surface);
    expect(accepted.event.preventDefault).not.toHaveBeenCalled();
    expect(accepted.preferences).toMatchObject({
      session: f.targetSession,
      partition: f.partition,
      preload: 'embed-preload.js',
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      disableDialogs: true,
    });
    expect(f.prepare(f.surface).event.preventDefault).toHaveBeenCalledOnce();
    expect(f.attach(f.surface)).toBe(true);
    await expect(f.read()).resolves.toEqual({
      mountId,
      targetUrl: 'https://portal.internal/page',
      proxy: { generation: 1, status: 'ready' },
    });
    await expect(f.read({ url: shellUrl })).rejects.toThrow('unavailable');
    expect(mocks.fromPartition).toHaveBeenCalledWith(f.partition, { cache: false });
    const second = f.controller.registerMount({
      mountId: secondMountId,
      owner: f.owner as unknown as Electron.WebContents,
      shellUrl: shellUrl.replace(mountId, secondMountId),
      targetUrl: 'https://portal.internal/other',
      isCurrent: () => true,
    });
    expect(second.partition).not.toBe(f.partition);
    f.controller.dispose();
  });

  it('keeps an unprepared or foreign guest from receiving a prepared target', () => {
    const f = fixture();
    expect(f.attach()).toBe(true);
    expect(f.guest.close).toHaveBeenCalledOnce();
    const unknown = f.prepare(f.owner, shellUrl, `webpage-embed:${secondMountId}:unknown`);
    expect(unknown.handled).toBe(true);
    expect(unknown.event.preventDefault).toHaveBeenCalledOnce();
    expect(f.prepare(f.owner, 'https://website.invalid', 'ordinary-browser').handled).toBe(false);
    f.controller.dispose();
  });

  it('does not expose a target before current proxy readiness and leaves retry explicit', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => {
      release = resolve;
    });
    mocks.register.mockImplementation(async target => {
      await pending;
      setState(target, { generation: 3, status: 'ready' });
    });
    const f = fixture();
    f.prepare();
    f.attach();
    let delivered = false;
    const read = f.read().then(value => {
      delivered = true;
      return value;
    });
    await Promise.resolve();
    expect(delivered).toBe(false);
    await expect(f.request('https://portal.internal/page')).resolves.toEqual({ cancel: true });
    // The fixed shell can still render a configuration error.
    await expect(f.request(shellUrl, 'mainFrame', f.guest.mainFrame)).resolves.toEqual({});
    release();
    await read;
    expect(delivered).toBe(true);
    f.controller.dispose();
  });

  it('revokes on source navigation and releases proxy, storage and static transport once', async () => {
    const f = fixture();
    f.prepare(f.surface);
    f.attach(f.surface);
    await f.read();
    f.controller.release(contents(applicationUrl) as unknown as Electron.WebContents, mountId);
    expect(f.guest.close).not.toHaveBeenCalled();
    f.surface.emit('did-start-navigation', {}, applicationUrl, false, true);
    await Promise.resolve();
    expect(f.guest.close).toHaveBeenCalledOnce();
    expect(mocks.unregister).toHaveBeenCalledWith(f.targetSession);
    expect(f.targetSession.clearStorageData).toHaveBeenCalledOnce();
    expect(f.dispose).toHaveBeenCalledOnce();
    await expect(f.read()).rejects.toThrow('unavailable');
    await expect(f.request('https://portal.internal')).resolves.toEqual({ cancel: true });
    f.controller.dispose();
    expect(f.dispose).toHaveBeenCalledOnce();
  });

  it.each([
    'file:///C:/private.html',
    'data:text/html,hello',
    'http://127.0.0.1:9000',
    'http://2130706433:9000',
    'https://user:password@portal.internal',
    'http://gateway.internal:18789/',
  ])('rejects unprepared privileged target %s before allocating a session', targetUrl => {
    expect(() => fixture({ targetUrl })).toThrow('not allowed');
    expect(mocks.fromPartition).not.toHaveBeenCalled();
  });

  it('returns prepared identity after proxy failure and retries only proxy setup with the same guest', async () => {
    mocks.register.mockImplementationOnce(async target => {
      setState(target, { generation: 1, status: 'failed' });
      throw new Error('proxy failed');
    });
    const f = fixture();
    f.prepare();
    f.attach();
    await expect(f.read()).resolves.toEqual({
      mountId,
      targetUrl: 'https://portal.internal/page',
      proxy: { generation: 1, status: 'failed' },
    });
    expect(mocks.register).toHaveBeenCalledOnce();
    await expect(f.request('https://portal.internal/page')).resolves.toEqual({ cancel: true });
    await expect(
      f.controller.retry(contents(applicationUrl) as unknown as Electron.WebContents, mountId),
    ).rejects.toThrow('unavailable');
    await f.controller.retry(f.owner as unknown as Electron.WebContents, mountId);
    expect(mocks.register).toHaveBeenCalledTimes(2);
    expect(f.guest.close).not.toHaveBeenCalled();
    expect(f.guest.send).toHaveBeenLastCalledWith(WebpageEmbedIpc.ProxyState, {
      generation: 1,
      status: 'ready',
    });
    await expect(f.request('https://portal.internal/page')).resolves.toEqual({});
    f.controller.dispose();
  });

  it('applies development CSP only to the independent shell session', () => {
    const f = fixture({ developmentCsp: { isDev: true, devServerPort: 43127 } });
    expect(f.targetSession.webRequest.onHeadersReceived).toHaveBeenCalledOnce();
    const receive = f.targetSession.webRequest.onHeadersReceived.mock.calls[0][0];
    const applied = vi.fn();
    receive({ url: shellUrl, responseHeaders: {} }, applied);
    expect(applied.mock.calls[0][0].responseHeaders['Content-Security-Policy']).toContain(
      "object-src 'none'",
    );
    const foreign = vi.fn();
    receive(
      { url: 'https://portal.internal/page', responseHeaders: { Existing: ['unchanged'] } },
      foreign,
    );
    expect(foreign).toHaveBeenCalledWith({ responseHeaders: { Existing: ['unchanged'] } });
    f.controller.dispose();
  });
});

describe('webpage networking and scoped broker headers', () => {
  it('allows a normal enterprise site while blocking protected origins and resolved loopback', async () => {
    const f = fixture();
    f.prepare();
    f.attach();
    await f.read();
    await expect(f.request('http://reports.internal/data')).resolves.toEqual({});
    await expect(f.request('http://192.168.20.8/api', 'xhr')).resolves.toEqual({});
    for (const url of [
      applicationUrl,
      'http://gateway.internal:18789/health',
      'http://localhost:4000/',
      'http://127.0.0.2/',
      'http://[::ffff:127.0.0.1]/',
      'http://169.254.169.254/latest',
      'file:///C:/secret',
      'javascript:alert(1)',
    ]) {
      await expect(f.request(url)).resolves.toEqual({ cancel: true });
    }
    f.targetSession.resolveHost.mockResolvedValueOnce({ endpoints: [{ address: '127.0.0.1' }] });
    await expect(f.request('http://rebound.internal/')).resolves.toEqual({ cancel: true });
    f.controller.dispose();
  });

  it('rechecks current proxy generation after DNS and keeps remote frames away from shell assets', async () => {
    const f = fixture();
    f.prepare();
    f.attach();
    await f.read();
    let resolved!: (value: unknown) => void;
    f.targetSession.resolveHost.mockReturnValueOnce(
      new Promise(resolve => {
        resolved = resolve;
      }),
    );
    const request = f.request('https://portal.internal/data', 'xhr');
    await vi.waitFor(() => expect(resolved).toBeTypeOf('function'));
    setState(f.targetSession, { generation: 2, status: 'ready' });
    resolved({ endpoints: [{ address: '10.0.0.20' }] });
    await expect(request).resolves.toEqual({ cancel: true });
    setState(f.targetSession, { generation: 3, status: 'failed' });
    await expect(f.request('https://portal.internal/data', 'xhr')).resolves.toEqual({
      cancel: true,
    });
    expect(f.guest.send).toHaveBeenLastCalledWith(WebpageEmbedIpc.ProxyState, {
      generation: 3,
      status: 'failed',
    });
    const asset = 'http://127.0.0.1:43127/assets/embed.js';
    await expect(f.request(asset, 'script', f.guest.mainFrame)).resolves.toEqual({});
    await expect(f.request(asset, 'script')).resolves.toEqual({ cancel: true });
    f.controller.dispose();
  });

  it('supports proxy-owned DNS only with no DIRECT route and still rejects known protected addresses', async () => {
    const f = fixture();
    f.prepare();
    f.attach();
    await f.read();
    f.targetSession.resolveHost.mockRejectedValue(new Error('not locally resolvable'));
    f.targetSession.resolveProxy.mockResolvedValue('PROXY proxy.internal:8181');
    await expect(f.request('https://remote-name.internal/page')).resolves.toEqual({});
    for (const route of [
      'DIRECT',
      'PROXY proxy.internal:8181; DIRECT',
      '',
      'UNKNOWN proxy.internal:8181',
    ]) {
      f.targetSession.resolveProxy.mockResolvedValue(route);
      await expect(f.request('https://remote-name.internal/page')).resolves.toEqual({
        cancel: true,
      });
    }
    f.targetSession.resolveProxy.mockResolvedValue('HTTPS proxy.internal:8181');
    f.targetSession.resolveHost.mockResolvedValue({ endpoints: [{ address: '0:0:0:0:0:0:0:1' }] });
    await expect(f.request('https://remote-name.internal/page')).resolves.toEqual({ cancel: true });
    f.controller.dispose();
  });

  it('adds the mount secret only for the exact broker range and strips it on redirect or foreign requests', async () => {
    const targetUrl = 'http://127.0.0.1:49123/documents/cv_one/index.html';
    const allowsHostedRequest = (value: string) =>
      value.startsWith('http://127.0.0.1:49123/documents/cv_one/');
    const f = fixture({
      targetUrl,
      allowsHostedRequest,
      hostedRequestHeaders: { 'X-Embed-Mount': 'ephemeral-secret' },
    });
    f.prepare();
    f.attach();
    await f.read();
    await expect(f.request(targetUrl)).resolves.toEqual({});
    await expect(
      f.request('http://127.0.0.1:49123/documents/cv_other/index.html'),
    ).resolves.toEqual({ cancel: true });
    await expect(f.headers(targetUrl)).resolves.toEqual({
      requestHeaders: { 'X-Embed-Mount': 'ephemeral-secret' },
    });
    await expect(
      f.headers('https://portal.internal/', {
        'x-embed-mount': 'ephemeral-secret',
        Accept: 'text/html',
      }),
    ).resolves.toEqual({ requestHeaders: { Accept: 'text/html' } });
    setState(f.targetSession, { generation: 2, status: 'pending' });
    await expect(f.headers(targetUrl)).resolves.toEqual({ cancel: true });
    f.controller.dispose();
  });

  it('does not turn allowed page networking into popups, downloads, permissions or proxy credential authority', async () => {
    mocks.credentials.mockReturnValue({
      host: 'proxy.internal',
      port: 8181,
      username: 'fixture',
      password: 'fixture-password',
    });
    const f = fixture();
    f.prepare();
    f.attach();
    await f.read();
    expect(f.guest.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: 'deny' });
    const download = { preventDefault: vi.fn() };
    f.targetSession.emit('will-download', download);
    expect(download.preventDefault).toHaveBeenCalledOnce();
    const permission = vi.fn();
    f.targetSession.setPermissionRequestHandler.mock.calls[0][0]({}, 'media', permission);
    expect(permission).toHaveBeenCalledWith(false);
    expect(f.targetSession.setPermissionCheckHandler.mock.calls[0][0]()).toBe(false);
    const challenge = (isProxy: boolean, host: string, port: number) => {
      const callback = vi.fn();
      f.guest.emit('login', { preventDefault: vi.fn() }, {}, { isProxy, host, port }, callback);
      return callback;
    };
    expect(challenge(true, 'proxy.internal', 8181)).toHaveBeenCalledWith(
      'fixture',
      'fixture-password',
    );
    expect(challenge(false, 'proxy.internal', 8181)).toHaveBeenCalledWith();
    expect(challenge(true, 'proxy.internal', 8182)).toHaveBeenCalledWith();
    setState(f.targetSession, { generation: 2, status: 'pending' });
    expect(challenge(true, 'proxy.internal', 8181)).toHaveBeenCalledWith();
    f.controller.dispose();
  });

  it('blocks page and redirect navigation into app or native control origins', async () => {
    const f = fixture();
    f.prepare();
    f.attach();
    await f.read();
    for (const name of ['will-frame-navigate', 'will-redirect']) {
      const event = { url: applicationUrl, isMainFrame: false, preventDefault: vi.fn() };
      f.guest.emit(name, event, applicationUrl);
      expect(event.preventDefault).toHaveBeenCalledOnce();
    }
    const allowed = {
      url: 'https://portal.internal/next',
      isMainFrame: false,
      preventDefault: vi.fn(),
    };
    f.guest.emit('will-frame-navigate', allowed);
    expect(allowed.preventDefault).not.toHaveBeenCalled();
    const top = { url: 'https://portal.internal', isMainFrame: true, preventDefault: vi.fn() };
    f.guest.emit('will-frame-navigate', top);
    expect(top.preventDefault).toHaveBeenCalledOnce();
    f.invalidate();
    await expect(f.request('https://portal.internal/data')).resolves.toEqual({ cancel: true });
    f.controller.dispose();
  });

  it('reports only a current direct child document failure, including its final redirect URL', async () => {
    const f = fixture();
    f.prepare();
    f.attach();
    await f.read();
    const direct = { parent: f.guest.mainFrame, processId: 44, routingId: 55 };
    mocks.frame.mockImplementation((processId, routingId) =>
      processId === 44 && routingId === 55 ? direct : undefined,
    );
    f.guest.emit('did-start-navigation', {}, 'https://portal.internal/page', false, false, 44, 55);
    f.guest.emit(
      'will-redirect',
      { isMainFrame: false, frame: direct, preventDefault: vi.fn() },
      'https://portal.internal/redirected',
    );
    f.guest.send.mockClear();
    f.guest.emit(
      'did-fail-load',
      {},
      -3,
      'aborted',
      'https://portal.internal/redirected',
      false,
      44,
      55,
    );
    f.guest.emit(
      'did-fail-load',
      {},
      -20,
      'blocked',
      'https://portal.internal/page',
      false,
      44,
      55,
    );
    f.guest.emit(
      'did-fail-load',
      {},
      -20,
      'blocked',
      'https://portal.internal/redirected',
      false,
      99,
      100,
    );
    expect(f.guest.send).not.toHaveBeenCalled();
    f.guest.emit(
      'did-fail-load',
      {},
      -20,
      'blocked',
      'https://portal.internal/redirected',
      false,
      44,
      55,
    );
    expect(f.guest.send).toHaveBeenCalledExactlyOnceWith(WebpageEmbedIpc.NativeFailure);
    f.controller.dispose();
  });

  it.each(['will-frame-navigate', 'will-redirect'])('reports a prevented direct page %s without waiting for a load event', async name => {
    const f = fixture();
    f.prepare();
    f.attach();
    await f.read();
    const direct = { parent: f.guest.mainFrame, processId: 44, routingId: 55 };
    const navigate = (url: string, frame: unknown = direct, isMainFrame = false) => {
      const event = { url, frame, isMainFrame, preventDefault: vi.fn() };
      f.guest.emit(name, event, url);
      return event;
    };
    f.guest.send.mockClear();
    expect(navigate('https://portal.internal/allowed').preventDefault).not.toHaveBeenCalled();
    expect(navigate(applicationUrl, { parent: direct }).preventDefault).toHaveBeenCalledOnce();
    expect(navigate(applicationUrl, f.guest.mainFrame, true).preventDefault).toHaveBeenCalledOnce();
    expect(f.guest.send).not.toHaveBeenCalled();
    expect(navigate(applicationUrl).preventDefault).toHaveBeenCalledOnce();
    expect(f.guest.send).toHaveBeenCalledExactlyOnceWith(WebpageEmbedIpc.NativeFailure);
    f.guest.send.mockClear();
    setState(f.targetSession, { generation: 2, status: 'pending' });
    f.guest.send.mockClear();
    expect(navigate('https://portal.internal/paused').preventDefault).toHaveBeenCalledOnce();
    expect(f.guest.send).not.toHaveBeenCalled();
    f.invalidate();
    expect(navigate(applicationUrl).preventDefault).toHaveBeenCalledOnce();
    expect(f.guest.send).not.toHaveBeenCalled();
    f.controller.dispose();
  });
});

describe('literal protected address classification', () => {
  it.each([
    '127.20.1.1',
    '0.0.0.0',
    '::1',
    '::ffff:7f00:1',
    '::ffff:127.0.0.1',
    'localhost.',
    'child.localhost',
    '169.254.1.1',
    '100.100.100.200',
    'fe80::2',
  ])('rejects %s', value => expect(isBlockedWebpageEmbedHost(value)).toBe(true));
  it.each(['10.0.0.1', '192.168.1.1', '172.20.0.1', 'portal.internal', '2001:db8::1'])(
    'allows ordinary enterprise address %s',
    value => expect(isBlockedWebpageEmbedHost(value)).toBe(false),
  );
});

describe('proxy-only route classification', () => {
  it.each([
    'PROXY proxy.internal:8080',
    'HTTPS proxy.internal:443; SOCKS5 fallback.internal:1080',
    'SOCKS [2001:db8::1]:1080',
  ])('accepts configured proxy route %s', route =>
    expect(hasProxyOnlyWebpageRoute(route)).toBe(true),
  );
  it.each([
    'DIRECT',
    'PROXY proxy.internal:8080; DIRECT',
    '',
    'PROXY',
    'PROXY user@proxy.internal:8080',
  ])('refuses ambiguous/direct route %s', route =>
    expect(hasProxyOnlyWebpageRoute(route)).toBe(false),
  );
});
