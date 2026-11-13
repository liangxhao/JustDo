import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  onSessionCreated: undefined as ((browserSession: Electron.Session) => void) | undefined,
}));
vi.mock('electron', () => ({
  app: {
    on: (_event: string, listener: typeof electron.onSessionCreated) => {
      electron.onSessionCreated = listener;
    },
    removeListener: (_event: string, listener: typeof electron.onSessionCreated) => {
      if (electron.onSessionCreated === listener) electron.onSessionCreated = undefined;
    },
  },
}));

const AUTHENTICATION_URL = 'https://localhost:18080/getSpesInfo';
const RELAY_PORT = 51_234;
type Details = Electron.OnBeforeSendHeadersListenerDetails;
type HeaderListener = (details: Details, reply: (response: Electron.BeforeSendResponse) => void) => void;

function browserSession(storagePath: string | null = null) {
  let beforeSendHeaders: HeaderListener | undefined;
  const browserSession = {
    storagePath,
    webRequest: {
      onBeforeSendHeaders: vi.fn((_filter: Electron.WebRequestFilter, listener: HeaderListener) => {
        beforeSendHeaders = listener;
      }),
    },
  } as unknown as Electron.Session;
  electron.onSessionCreated?.(browserSession);
  const request = (details: Partial<Details> = {}) => new Promise<Electron.BeforeSendResponse>(resolve =>
    beforeSendHeaders?.({
      url: AUTHENTICATION_URL,
      method: 'POST',
      resourceType: 'xhr',
      requestHeaders: { Origin: 'https://provider.example' },
      ...details,
    } as Details, resolve),
  );
  return { browserSession, request };
}

describe('browser authentication request scope', () => {
  let guard: typeof import('./browserTransportRequests');
  let rollback: () => void;
  beforeEach(async () => {
    vi.resetModules();
    electron.onSessionCreated = undefined;
    guard = await import('./browserTransportRequests');
    rollback = guard.installBrowserTransportRequestGuard(RELAY_PORT);
  });

  it('allows the exact page POST and preflight in a managed profile without pinning the origin', async () => {
    const active = browserSession('/browser/profile');
    const alias = browserSession('/browser/profile');
    guard.registerBrowserTransportSession(active.browserSession, request => request.webContentsId === 42);

    await expect(active.request({ webContentsId: 42 })).resolves.toEqual({});
    await expect(alias.request({
      webContentsId: 42,
      method: 'OPTIONS',
      requestHeaders: { origin: 'https://other.example', 'Access-Control-Request-Method': 'POST' },
      frame: {
        origin: 'https://other.example',
        top: { origin: 'http://business.example' },
      } as Electron.WebFrameMain,
    })).resolves.toEqual({});
  });

  it('rejects the mapped authority outside the admitted method, request, and page', async () => {
    const owned = browserSession();
    guard.registerBrowserTransportSession(owned.browserSession, request => request.webContentsId === 42);
    const unowned = browserSession();

    await expect(unowned.request({ webContentsId: 42 })).resolves.toEqual({ cancel: true });
    for (const details of [
      { webContentsId: 51 },
      { resourceType: 'mainFrame' },
      { resourceType: 'subFrame' },
      { method: 'GET' },
      { method: 'OPTIONS' },
      { method: 'OPTIONS', requestHeaders: { Origin: 'null', 'Access-Control-Request-Method': 'PUT' } },
      { method: 'OPTIONS', requestHeaders: { Origin: 'https://site.example', origin: 'null', 'Access-Control-Request-Method': 'POST' } },
      { requestHeaders: {} },
      { requestHeaders: { Origin: 'null' } },
      { requestHeaders: { Origin: 'http://provider.example' } },
      { requestHeaders: { Origin: 'https://localhost' } },
      { requestHeaders: { Origin: 'https://127.0.0.1' } },
      { requestHeaders: { Origin: 'https://[::ffff:7f00:1]' } },
      { frame: { origin: 'https://wrong.example' } as Electron.WebFrameMain },
      { url: `${AUTHENTICATION_URL}?other=1` },
      { url: 'http://localhost:18080/getSpesInfo' },
      { url: 'wss://localhost:18080/getSpesInfo' },
      { url: 'https://localhost:18080/other' },
      { url: 'https://localhost.:18080/getSpesInfo' },
    ] as Partial<Details>[]) {
      await expect(owned.request({ webContentsId: 42, ...details })).resolves.toEqual({ cancel: true });
    }
  });

  it('blocks direct relay addressing and leaves ordinary URLs on their existing route', async () => {
    const browser = browserSession();
    for (const host of ['localhost', 'localhost.']) {
      await expect(browser.request({ url: `https://${host}:${RELAY_PORT}/direct` }))
        .resolves.toEqual({ cancel: true });
    }
    await expect(browser.request({ url: `wss://localhost:${RELAY_PORT}/direct` }))
      .resolves.toEqual({ cancel: true });
    for (const url of [
      'https://localhost:18081/', 'https://intranet.example:18080/', 'https://portal.example/',
      `https://portal.example:${RELAY_PORT}/`, `wss://portal.example:${RELAY_PORT}/`,
    ]) {
      await expect(browser.request({ url })).resolves.toEqual({});
    }
  });

  it('restores requests when startup could not install the resolver rule', async () => {
    const browser = browserSession();
    await expect(browser.request()).resolves.toEqual({ cancel: true });

    rollback();
    rollback();

    expect(electron.onSessionCreated).toBeUndefined();
    await expect(browser.request()).resolves.toEqual({});
  });
});
