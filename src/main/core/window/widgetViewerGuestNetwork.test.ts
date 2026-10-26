import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type WidgetNetworkCreate, WidgetNetworkIpc } from '../../../shared/widgets/network';

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  fromPartition: vi.fn(),
  register: vi.fn(),
  unregister: vi.fn(),
  mode: vi.fn(),
  subscribe: vi.fn(),
  changes: new Set<() => void>(),
}));
vi.mock('electron', () => ({
  ipcMain: { handle: mocks.handle },
  session: { fromPartition: mocks.fromPartition },
}));
vi.mock('../network/systemProxyPreference', () => ({
  registerBrowserProxySession: mocks.register,
  unregisterBrowserProxySession: mocks.unregister,
  getBrowserProxyMode: mocks.mode,
  onBrowserProxyWillChange: mocks.subscribe,
}));

const mountId = '2e4ec192-521e-4b76-b132-e34598e41bb2';
const sandboxUrl = `http://127.0.0.1:18790/mcp-app-sandbox?csp=YWJj&v=${'a'.repeat(64)}`;
const resourceUrl = `http://127.0.0.1:18789/__openclaw__/cap/${'a'.repeat(24)}/__widget_kit__/image-loading.js`;
const binding = {
  connectionGeneration: 1,
  agentId: 'main',
  sessionKey: 'agent:main:chat',
  sessionId: 'session',
  lifecycleRevision: 'lifecycle',
  name: 'globe',
  revision: 1,
  instanceId: 'native-instance',
  viewGeneration: 'view',
  grantState: 'granted' as const,
  netOrigins: ['https://assets.example'],
};
let id = 0;
function contents(url: string, targetSession?: unknown) {
  return Object.assign(new EventEmitter(), {
    id: ++id,
    session: targetSession,
    mainFrame: { url },
    getURL: () => url,
    isDestroyed: vi.fn(() => false),
    close: vi.fn(),
    send: vi.fn(),
  });
}
function targetSession() {
  return Object.assign(new EventEmitter(), {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    resolveProxy: vi.fn(async () => 'PROXY proxy.example:8080'),
    closeAllConnections: vi.fn(async () => {}),
    clearStorageData: vi.fn(async () => {}),
    clearCache: vi.fn(async () => {}),
    clearAuthCache: vi.fn(async () => {}),
    webRequest: {
      onBeforeRequest: vi.fn(),
      onBeforeSendHeaders: vi.fn(),
      onHeadersReceived: vi.fn(),
    },
  });
}
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.changes.clear();
  mocks.mode.mockReturnValue('system');
  mocks.register.mockResolvedValue(undefined);
  mocks.fromPartition.mockImplementation(() => targetSession());
  mocks.subscribe.mockImplementation((callback: () => void) => {
    mocks.changes.add(callback);
    return () => mocks.changes.delete(callback);
  });
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
});
afterEach(() => vi.useRealTimers());

async function fixture() {
  const { WidgetNetworkGuests } = await import('./widgetViewerGuestNetwork');
  const owner = contents('http://127.0.0.1:43127/index.html');
  const controller = new WidgetNetworkGuests(
    owner as unknown as Electron.WebContents,
    'minimal-preload.js',
  );
  const create = (mount = mountId) => {
    const check = controller.beginCheck({ mountId: mount });
    return controller.create({
      mountId: mount,
      nonce: check.nonce,
      binding,
      gatewayOrigin: 'http://127.0.0.1:18789',
      sandboxUrl,
      resourceUrls: [resourceUrl],
    });
  };
  return { owner, controller, create };
}

describe('network widget ownership and leases', () => {
  it('admits only the current owner main frame and consumes only the newest nonce', async () => {
    const { owner, controller } = await fixture();
    const handler = mocks.handle.mock.calls.find(
      ([name]) => name === WidgetNetworkIpc.BeginCheck,
    )![1];
    expect(() => handler({ sender: owner, senderFrame: {} }, { mountId })).toThrow();
    const other = contents('http://127.0.0.1:43127/widget-viewer.html');
    expect(() => handler({ sender: other, senderFrame: other.mainFrame }, { mountId })).toThrow();
    const old = controller.beginCheck({ mountId });
    const current = controller.beginCheck({ mountId });
    const input: WidgetNetworkCreate = {
      mountId,
      nonce: old.nonce,
      binding,
      gatewayOrigin: 'http://127.0.0.1:18789',
      sandboxUrl,
      resourceUrls: [resourceUrl],
    };
    await expect(controller.create(input)).rejects.toThrow();
    const instance = await controller.create({ ...input, nonce: current.nonce });
    await expect(controller.create({ ...input, nonce: current.nonce })).rejects.toThrow();
    controller.close(instance);
  });

  it('expires from the check start even when create or renewal completes later', async () => {
    const { controller, owner } = await fixture();
    const check = controller.beginCheck({ mountId });
    await vi.advanceTimersByTimeAsync(14_000);
    const instance = await controller.create({
      mountId,
      nonce: check.nonce,
      binding,
      gatewayOrigin: 'http://127.0.0.1:18789',
      sandboxUrl,
      resourceUrls: [resourceUrl],
    });
    await vi.advanceTimersByTimeAsync(16_000);
    const renewal = controller.beginCheck(instance);
    await vi.advanceTimersByTimeAsync(14_000);
    controller.renew({ ...instance, nonce: renewal.nonce, binding });
    await vi.advanceTimersByTimeAsync(45_999);
    expect(owner.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(owner.send).toHaveBeenCalledWith(WidgetNetworkIpc.Revoked, {
      instanceId: instance.instanceId,
      mountId,
      reason: 'expired',
    });
  });

  it('rejects a 15-second-old proof and cannot revive a closed instance', async () => {
    const { controller, create } = await fixture();
    const instance = await create();
    const check = controller.beginCheck(instance);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(() => controller.renew({ ...instance, nonce: check.nonce, binding })).toThrow();
    const fresh = controller.beginCheck(instance);
    controller.close(instance);
    expect(() => controller.renew({ ...instance, nonce: fresh.nonce, binding })).toThrow();
    expect(mocks.unregister).toHaveBeenCalledOnce();
  });

  it('revokes on changed identity, proxy preferences, and owner navigation', async () => {
    const { controller, create, owner } = await fixture();
    const first = await create();
    const check = controller.beginCheck(first);
    expect(() =>
      controller.renew({
        ...first,
        nonce: check.nonce,
        binding: { ...binding, lifecycleRevision: 'replacement' },
      }),
    ).toThrow();
    const second = await create();
    for (const callback of mocks.changes) callback();
    expect(() => controller.beginCheck(second)).toThrow();
    const third = await create();
    owner.emit('did-start-navigation', {}, owner.getURL(), false, true);
    expect(() => controller.beginCheck(third)).toThrow();
    expect(mocks.unregister).toHaveBeenCalledTimes(3);
  });

  it('rejects DIRECT or PAC DIRECT fallback and cleans a failed private session', async () => {
    const { create } = await fixture();
    const target = targetSession();
    target.resolveProxy.mockResolvedValue('PROXY proxy.example:8080; DIRECT');
    mocks.fromPartition.mockReturnValue(target);
    await expect(create()).rejects.toThrow('proxy unavailable');
    expect(mocks.unregister).toHaveBeenCalledWith(target);
    expect(target.closeAllConnections).toHaveBeenCalledOnce();
    expect(target.clearStorageData).toHaveBeenCalledOnce();
    mocks.mode.mockReturnValue('direct');
    await expect(create()).rejects.toThrow('requires a proxy');
  });

  it('bounds stalled proxy initialization without reviving its late success', async () => {
    const { create, owner } = await fixture();
    let resolve!: () => void;
    mocks.register.mockReturnValue(
      new Promise<void>(done => {
        resolve = done;
      }),
    );
    const pending = expect(create()).rejects.toThrow('proxy unavailable');
    await vi.advanceTimersByTimeAsync(15_000);
    await pending;
    expect(mocks.unregister).toHaveBeenCalledOnce();
    resolve();
    await Promise.resolve();
    expect(owner.send).toHaveBeenCalledOnce();
  });

  it('allows independent checks without an application quota', async () => {
    const { controller } = await fixture();
    const checks = Array.from({ length: 33 }, (_, index) => {
      const mountId = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      return { mountId, ...controller.beginCheck({ mountId }) };
    });
    for (const check of [checks[0], checks[32]]) {
      const instance = await controller.create({
        mountId: check.mountId,
        nonce: check.nonce,
        binding,
        gatewayOrigin: 'http://127.0.0.1:18789',
        sandboxUrl,
        resourceUrls: [resourceUrl],
      });
      controller.close(instance);
    }
  });

  it('admits more views and recovers after repeated proxy failures without restarting', async () => {
    const { controller, create } = await fixture();
    const instances = [];
    for (let i = 0; i < 9; i++)
      instances.push(await create(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`));
    instances.forEach(instance => controller.close(instance));
    mocks.register.mockRejectedValue(new Error('proxy unavailable'));
    for (let i = 0; i < 64; i++) await expect(create()).rejects.toThrow('proxy unavailable');
    mocks.register.mockResolvedValue(undefined);
    const recovered = await create();
    expect(recovered.partition).toMatch(/^widget-network-/u);
    controller.close(recovered);
  });

  it('binds the exact viewer once and installs role-bound network/header limits before author HTML', async () => {
    const { controller, create, owner } = await fixture();
    const instance = await create();
    const target = mocks.fromPartition.mock.results[0].value;
    const viewer = `http://127.0.0.1:43127/widget-viewer.html?mount=${mountId}`;
    const event = { preventDefault: vi.fn() };
    const preferences: Electron.WebPreferences = {};
    controller.prepare(
      event as unknown as Electron.Event,
      preferences,
      { partition: instance.partition, src: viewer },
      owner as unknown as Electron.WebContents,
    );
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(preferences).toMatchObject({
      preload: 'minimal-preload.js',
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      session: target,
    });
    controller.prepare(
      event as unknown as Electron.Event,
      {},
      { partition: instance.partition, src: viewer },
      owner as unknown as Electron.WebContents,
    );
    expect(event.preventDefault).toHaveBeenCalledOnce();
    const guest = contents(viewer, target);
    controller.attach(
      guest as unknown as Electron.WebContents,
      owner as unknown as Electron.WebContents,
    );
    const shell = { url: sandboxUrl, parent: guest.mainFrame };
    const frame = { url: 'about:srcdoc', parent: shell };
    const details = {
      url: 'https://assets.example/earth.jpg',
      resourceType: 'xhr',
      method: 'GET',
      frame,
      webContentsId: guest.id,
    };
    const before = target.webRequest.onBeforeRequest.mock.calls[0][0];
    const allowed = vi.fn();
    before(details, allowed);
    await vi.waitFor(() => expect(allowed).toHaveBeenCalledWith({ cancel: false }));
    const upload = vi.fn();
    before({ ...details, uploadData: [{ bytes: new Uint8Array([1]) }] }, upload);
    expect(upload).toHaveBeenCalledWith({ cancel: true });
    const sendHeaders = target.webRequest.onBeforeSendHeaders.mock.calls[0][0];
    const headers = vi.fn();
    sendHeaders(
      {
        ...details,
        requestHeaders: { Cookie: 'source-secret', Authorization: 'bearer', Accept: 'image/png' },
      },
      headers,
    );
    expect(headers).toHaveBeenCalledWith({ requestHeaders: { Accept: 'image/png' } });
    const received = target.webRequest.onHeadersReceived.mock.calls[0][0];
    const response = vi.fn();
    received(
      {
        ...details,
        responseHeaders: {
          'Set-Cookie': ['secret'],
          'Content-Security-Policy': ["connect-src 'none'"],
        },
      },
      response,
    );
    expect(response).toHaveBeenCalledWith({
      responseHeaders: { 'Content-Security-Policy': ["connect-src 'none'"] },
    });
    const redirect = vi.fn();
    received(
      { ...details, responseHeaders: { Location: ['http://127.0.0.1:18789/secret'] } },
      redirect,
    );
    expect(redirect).toHaveBeenCalledWith({ cancel: true });
    const resource = {
      ...details,
      url: 'https://cdn.jsdelivr.net/library.js',
      resourceType: 'script',
    };
    const resourceAllowed = vi.fn();
    before(resource, resourceAllowed);
    await vi.waitFor(() => expect(resourceAllowed).toHaveBeenCalledWith({ cancel: false }));
    expect(target.resolveProxy).toHaveBeenCalledWith(resource.url);
    const resourceHeaders = vi.fn();
    sendHeaders(
      { ...resource, requestHeaders: { Cookie: 'secret', Authorization: 'secret', Accept: '*/*' } },
      resourceHeaders,
    );
    expect(resourceHeaders).toHaveBeenCalledWith({ requestHeaders: { Accept: '*/*' } });
    const resourceRedirect = vi.fn();
    received(
      {
        ...resource,
        responseHeaders: { Location: ['https://unpkg.com/library.js'], 'Set-Cookie': ['secret'] },
      },
      resourceRedirect,
    );
    expect(resourceRedirect).toHaveBeenCalledWith({
      responseHeaders: { Location: ['https://unpkg.com/library.js'] },
    });
    const transportRedirect = vi.fn();
    received(
      { ...resource, responseHeaders: { Location: ['http://127.0.0.1:18789/secret'] } },
      transportRedirect,
    );
    expect(transportRedirect).toHaveBeenCalledWith({ cancel: true });
    controller.close(instance);
    expect(guest.close).toHaveBeenCalledOnce();
    const retired = vi.fn();
    before(details, retired);
    expect(retired).toHaveBeenCalledWith({ cancel: true });
  });
});
