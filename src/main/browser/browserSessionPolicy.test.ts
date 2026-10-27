import { EventEmitter } from 'node:events';

import { describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ claim: vi.fn(), proxyReady: vi.fn(async () => {}) }));
vi.mock('../core/network/systemProxyPreference', () => ({
  registerBrowserProxySession: mocks.proxyReady,
}));
vi.mock('./downloads/browserAgentDownloadCoordinator', () => ({
  claimBrowserAgentDownload: mocks.claim,
}));

import { registerBackgroundBrowserGuest } from './backgroundBrowserGuestRegistry';
import {
  type BrowserSessionUiPolicy,
  configureBrowserSessionUi,
  ensureBrowserSessionPolicy,
  registerBrowserSessionGuestPolicy,
  releaseBrowserSessionUi,
} from './browserSessionPolicy';

type BeforeRequest = (
  details: Electron.OnBeforeRequestListenerDetails,
  callback: (response: Electron.CallbackResponse) => void,
) => void;
type HeadersReceived = BrowserSessionUiPolicy['headersReceived'];
let nextId = 700;
const fixture = () => {
  mocks.claim.mockReset();
  mocks.proxyReady.mockReset().mockResolvedValue(undefined);
  let before!: BeforeRequest;
  let headers!: HeadersReceived;
  let check!: BrowserSessionUiPolicy['checkPermission'];
  let request!: BrowserSessionUiPolicy['requestPermission'];
  const session = Object.assign(new EventEmitter(), {
    storagePath: `/browser/policy-${nextId}`,
    resolveHost: vi.fn(async () => ({ endpoints: [{ address: '192.0.2.1' }] })),
    webRequest: {
      onBeforeRequest: vi.fn((handler: BeforeRequest) => {
        before = handler;
      }),
      onHeadersReceived: vi.fn((handler: HeadersReceived) => {
        headers = handler;
      }),
    },
    setPermissionCheckHandler: vi.fn((handler: typeof check) => {
      check = handler;
    }),
    setPermissionRequestHandler: vi.fn((handler: typeof request) => {
      request = handler;
    }),
    setDevicePermissionHandler: vi.fn(),
    setDisplayMediaRequestHandler: vi.fn(),
  });
  const nativeSession = session as unknown as Electron.Session;
  const guest = () =>
    Object.assign(new EventEmitter(), {
      id: nextId++,
      session: nativeSession,
      isDestroyed: () => false,
    }) as Electron.WebContents;
  const foreground = guest();
  const background = guest();
  const owner = registerBackgroundBrowserGuest(background);
  const ui = {
    ownsGuest: (guest: Electron.WebContents | undefined, id?: number) =>
      guest ? guest === foreground : id === foreground.id,
    checkPermission: vi.fn(() => true),
    requestPermission: vi.fn<BrowserSessionUiPolicy['requestPermission']>(
      (_guest, _permission, reply) => reply(true),
    ),
    download: vi.fn(),
    headersReceived: vi.fn<HeadersReceived>((_details, reply) => reply({})),
  };
  const uiOwner = Symbol('test-ui');
  configureBrowserSessionUi(nativeSession, uiOwner, ui);
  const inspectDetails = (details: Partial<Electron.OnBeforeRequestListenerDetails>) => {
    const reply = vi.fn();
    before(details as Electron.OnBeforeRequestListenerDetails, reply);
    return reply;
  };
  const inspect = (url: string, source?: Electron.WebContents, resourceType = 'xhr') => {
    return inspectDetails({
      url,
      resourceType,
      ...(source ? { webContentsId: source.id, webContents: source } : {}),
    } as Electron.OnBeforeRequestListenerDetails);
  };
  return {
    session,
    nativeSession,
    foreground,
    background,
    owner,
    ui,
    uiOwner,
    guest,
    inspect,
    inspectDetails,
    check: (...args: Parameters<typeof check>) => check(...args),
    request: (...args: Parameters<typeof request>) => request(...args),
    headers: (...args: Parameters<typeof headers>) => headers(...args),
  };
};
const item = () => Object.assign(new EventEmitter(), { cancel: vi.fn(), setSavePath: vi.fn() });

describe('shared browser session policy ownership', () => {
  test('installs handlers once regardless of foreground/headless registration order', () => {
    const f = fixture();
    ensureBrowserSessionPolicy(f.nativeSession);
    configureBrowserSessionUi(f.nativeSession, f.uiOwner, { download: f.ui.download });

    expect(f.session.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1);
    expect(f.session.webRequest.onHeadersReceived).toHaveBeenCalledTimes(1);
    expect(f.session.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
    expect(f.session.listenerCount('will-download')).toBe(1);
    expect(f.check(f.background, 'notifications', 'https://site.example', {})).toBe(false);
    expect(f.check(f.foreground, 'notifications', 'https://site.example', {})).toBe(true);
    f.owner.release();
  });

  test('rejects background permission requests before reaching the UI, even for a focused guest', () => {
    const f = fixture();
    const reply = vi.fn();
    f.request(f.background, 'notifications', reply, {} as Electron.PermissionRequest);
    expect(reply).toHaveBeenCalledExactlyOnceWith(false);
    expect(f.ui.requestPermission).not.toHaveBeenCalled();
    f.owner.release();
  });

  test('rejects a late UI permission grant after the owning window is released', () => {
    const f = fixture();
    let grant!: (value: boolean) => void;
    f.ui.requestPermission.mockImplementationOnce((_guest, _permission, callback) => {
      grant = callback;
    });
    const reply = vi.fn();
    f.request(f.foreground, 'notifications', reply, {} as Electron.PermissionRequest);
    releaseBrowserSessionUi(f.nativeSession, f.uiOwner);
    grant(true);
    expect(reply).toHaveBeenCalledExactlyOnceWith(false);
    f.owner.release();
  });

  test('an older window cannot remove a replacement UI and background requests remain denied', () => {
    const f = fixture();
    const replacement = Symbol('replacement');
    configureBrowserSessionUi(f.nativeSession, replacement, f.ui);
    releaseBrowserSessionUi(f.nativeSession, f.uiOwner);
    expect(f.check(f.foreground, 'notifications', 'https://site.example', {})).toBe(true);
    expect(f.check(f.background, 'notifications', 'https://site.example', {})).toBe(false);
    f.owner.release();
  });

  test('revoked background DNS results fail while foreground and profile worker requests continue', async () => {
    const f = fixture();
    let finish!: (value: { endpoints: Array<{ address: string }> }) => void;
    f.session.resolveHost.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    const late = f.inspect('https://site.example/write', f.background);
    await vi.waitFor(() => expect(f.session.resolveHost).toHaveBeenCalledOnce());
    f.owner.revoke();
    finish({ endpoints: [{ address: '192.0.2.1' }] });
    await vi.waitFor(() => expect(late).toHaveBeenCalledExactlyOnceWith({ cancel: true }));
    const foreground = f.inspect('https://site.example', f.foreground);
    const profileWorker = f.inspect('https://site.example');
    await vi.waitFor(() => expect(foreground).toHaveBeenCalledExactlyOnceWith({ cancel: false }));
    await vi.waitFor(() =>
      expect(profileWorker).toHaveBeenCalledExactlyOnceWith({ cancel: false }),
    );
    f.owner.release();
    expect(f.inspect('https://site.example', f.background)).toHaveBeenCalledExactlyOnceWith({
      cancel: true,
    });
    expect(f.inspect('http://169.254.169.254/metadata')).toHaveBeenCalledExactlyOnceWith({
      cancel: true,
    });
  });

  test('routes only live background claimed downloads to their reserved path', () => {
    const f = fixture();
    const claim = { savePath: 'C:/workspace/claimed.txt', settle: vi.fn() };
    mocks.claim.mockReturnValue(claim);
    const claimed = item();
    f.session.emit('will-download', {}, claimed, f.background);
    expect(claimed.setSavePath).toHaveBeenCalledExactlyOnceWith(claim.savePath);
    expect(f.ui.download).not.toHaveBeenCalled();
    claimed.emit('done', {}, 'completed');
    expect(claim.settle).toHaveBeenCalledExactlyOnceWith(claimed, 'completed');
    f.owner.revoke();
    const late = item();
    f.session.emit('will-download', {}, late, f.background);
    expect(late.cancel).toHaveBeenCalledOnce();
    expect(late.setSavePath).not.toHaveBeenCalled();
    f.owner.release();
  });

  test.each(['unclaimed', 'cancelled', 'originless'] as const)(
    'never shows UI for a %s background download',
    cause => {
      const f = fixture();
      mocks.claim.mockReturnValue(cause === 'cancelled' ? { cancelled: true } : null);
      const download = item();
      f.session.emit(
        'will-download',
        {},
        download,
        cause === 'originless' ? undefined : f.background,
      );
      expect(download.cancel).toHaveBeenCalledOnce();
      expect(download.setSavePath).not.toHaveBeenCalled();
      expect(f.ui.download).not.toHaveBeenCalled();
      f.owner.release();
    },
  );

  test('foreground download delegates stay active after a background page closes and UI release keeps the policy', () => {
    const f = fixture();
    f.owner.revoke();
    f.owner.release();
    const manual = item();
    f.session.emit('will-download', {}, manual, f.foreground);
    expect(f.ui.download).toHaveBeenCalledExactlyOnceWith({}, manual, f.foreground);
    releaseBrowserSessionUi(f.nativeSession, f.uiOwner);
    const unattended = item();
    f.session.emit('will-download', {}, unattended, f.foreground);
    expect(unattended.cancel).toHaveBeenCalledOnce();
    expect(f.session.listenerCount('will-download')).toBe(1);
  });

  test('PDF notifications are restricted to foreground page requests', () => {
    const f = fixture();
    const inspect = (guest?: Electron.WebContents) => {
      f.headers(
        {
          webContentsId: guest?.id,
          webContents: guest,
        } as Electron.OnHeadersReceivedListenerDetails,
        vi.fn(),
      );
    };
    inspect(f.background);
    inspect();
    expect(f.ui.headersReceived).not.toHaveBeenCalled();
    inspect(f.foreground);
    expect(f.ui.headersReceived).toHaveBeenCalledOnce();
    f.owner.release();
  });

  test('accepts equivalent persistent Session wrappers without sharing a different profile', () => {
    const f = fixture();
    Object.assign(f.session, { storagePath: '/browser/profile-one' });
    Object.defineProperty(f.foreground, 'session', {
      configurable: true,
      value: { storagePath: '/browser/profile-one' },
    });
    expect(f.check(f.foreground, 'notifications', 'https://site.example', {})).toBe(true);
    Object.defineProperty(f.foreground, 'session', {
      value: { storagePath: '/browser/profile-two' },
    });
    expect(f.check(f.foreground, 'notifications', 'https://site.example', {})).toBe(false);
    f.owner.release();
  });

  test('does not send an old window guest into a replacement window UI', () => {
    const f = fixture();
    configureBrowserSessionUi(f.nativeSession, Symbol('new-window'), {
      ...f.ui,
      ownsGuest: () => false,
    });
    expect(f.check(f.foreground, 'notifications', 'https://site.example', {})).toBe(false);
    const download = item();
    f.session.emit('will-download', {}, download, f.foreground);
    expect(download.cancel).toHaveBeenCalledOnce();
    expect(f.ui.download).not.toHaveBeenCalled();
    f.owner.release();
  });

  test('an equivalent Session wrapper reuses the original handlers and UI owner', () => {
    const f = fixture();
    const alias = { storagePath: f.session.storagePath } as Electron.Session;
    ensureBrowserSessionPolicy(alias);
    configureBrowserSessionUi(alias, f.uiOwner, { download: f.ui.download });
    expect(f.session.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1);
    expect(f.check(f.foreground, 'notifications', 'https://site.example', {})).toBe(true);
    f.owner.release();
  });

  test('prepares proxy settings before allowing the first sidebar connection', async () => {
    const f = fixture();
    let ready!: () => void;
    mocks.proxyReady.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          ready = resolve;
        }),
    );
    const reply = f.inspect('https://site.example', f.foreground);
    await vi.waitFor(() => expect(mocks.proxyReady).toHaveBeenCalledOnce());
    expect(f.session.resolveHost).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    ready();
    await vi.waitFor(() => expect(reply).toHaveBeenCalledExactlyOnceWith({ cancel: false }));
    f.owner.release();
  });
});

describe('shared browser page network policies', () => {
  test('dispatches two pages independently while sidebar, background and worker requests keep their baseline', async () => {
    const f = fixture();
    const first = f.guest();
    const second = f.guest();
    const allow = vi.fn<Parameters<typeof registerBrowserSessionGuestPolicy>[1]['beforeRequest']>(
      (_details, reply) => reply({ cancel: false }),
    );
    const deny = vi.fn<Parameters<typeof registerBrowserSessionGuestPolicy>[1]['beforeRequest']>(
      (_details, reply) => reply({ cancel: true }),
    );
    const releaseFirst = registerBrowserSessionGuestPolicy(first, {
      isCurrent: () => true,
      beforeRequest: allow,
    });
    const releaseSecond = registerBrowserSessionGuestPolicy(second, {
      isCurrent: () => true,
      beforeRequest: deny,
    });

    expect(f.inspect('https://first.example', first, 'mainFrame')).toHaveBeenCalledExactlyOnceWith({
      cancel: false,
    });
    expect(f.inspect('https://second.example', second)).toHaveBeenCalledExactlyOnceWith({
      cancel: true,
    });
    expect(allow).toHaveBeenCalledOnce();
    expect(deny).toHaveBeenCalledOnce();
    const sidebar = f.inspect('https://sidebar.example', f.foreground);
    const background = f.inspect('https://background.example', f.background);
    const worker = f.inspectDetails({
      url: 'https://worker.example',
      resourceType: 'xhr',
      webContentsId: -1,
    });
    await vi.waitFor(() => {
      for (const reply of [sidebar, background, worker])
        expect(reply).toHaveBeenCalledExactlyOnceWith({ cancel: false });
    });
    releaseFirst();
    expect(f.inspect('https://first.example', first)).toHaveBeenCalledExactlyOnceWith({
      cancel: true,
    });
    expect(f.inspect('https://second.example', second)).toHaveBeenCalledExactlyOnceWith({
      cancel: true,
    });
    expect(deny).toHaveBeenCalledTimes(2);
    expect(f.session.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1);
    expect(f.session.webRequest.onHeadersReceived).toHaveBeenCalledTimes(1);
    expect(f.session.listenerCount('will-download')).toBe(1);
    releaseSecond();
    f.owner.release();
  });

  test('rejects mismatched guest identities and accepts equivalent Session wrappers only', () => {
    const f = fixture();
    const page = f.guest();
    const beforeRequest = vi.fn<
      Parameters<typeof registerBrowserSessionGuestPolicy>[1]['beforeRequest']
    >((_details, reply) => reply({}));
    Object.assign(page, { session: { storagePath: f.session.storagePath } });
    const release = registerBrowserSessionGuestPolicy(page, {
      isCurrent: () => true,
      beforeRequest,
    });
    expect(f.inspect('https://site.example', page)).toHaveBeenCalledExactlyOnceWith({});
    expect(
      f.inspectDetails({
        url: 'https://site.example',
        webContentsId: page.id,
        webContents: f.foreground,
      }),
    ).toHaveBeenCalledExactlyOnceWith({ cancel: true });
    expect(
      f.inspectDetails({
        url: 'https://site.example',
        webContentsId: f.foreground.id,
        webContents: page,
      }),
    ).toHaveBeenCalledExactlyOnceWith({ cancel: true });
    Object.assign(page, { session: { storagePath: '/browser/different-profile' } });
    expect(f.inspect('https://site.example', page)).toHaveBeenCalledExactlyOnceWith({
      cancel: true,
    });
    expect(beforeRequest).toHaveBeenCalledOnce();
    expect(f.session.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1);
    release();
    f.owner.release();
  });

  test.each(['release', 'retire', 'destroy', 'session'] as const)(
    'rechecks exact ownership when a pending page DNS request finishes after %s',
    async boundary => {
      const f = fixture();
      const page = f.guest();
      let current = true;
      let finish!: (value: { endpoints: Array<{ address: string }> }) => void;
      f.session.resolveHost.mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finish = resolve;
          }),
      );
      const release = registerBrowserSessionGuestPolicy(page, {
        isCurrent: () => current,
        beforeRequest: async (details, reply) => {
          await f.session.resolveHost(new URL(details.url).hostname);
          reply({ cancel: false });
          reply({ cancel: false });
        },
      });
      const reply = f.inspect('https://page.example', page);
      expect(reply).not.toHaveBeenCalled();
      if (boundary === 'release') release();
      if (boundary === 'retire') current = false;
      if (boundary === 'destroy') page.emit('destroyed');
      if (boundary === 'session')
        Object.assign(page, { session: { storagePath: '/browser/replacement-profile' } });
      finish({ endpoints: [{ address: '192.0.2.1' }] });
      await vi.waitFor(() => expect(reply).toHaveBeenCalledExactlyOnceWith({ cancel: true }));
      release();
      expect(
        f.inspectDetails({
          url: 'https://page.example',
          webContentsId: page.id,
        }),
      ).toHaveBeenCalledExactlyOnceWith({ cancel: true });
      f.owner.release();
    },
  );

  test('retired page IDs cannot fall through the browser baseline or be registered again', () => {
    const f = fixture();
    const page = f.guest();
    const handlers = { isCurrent: () => true, beforeRequest: vi.fn() };
    const release = registerBrowserSessionGuestPolicy(page, handlers);
    expect(() => registerBrowserSessionGuestPolicy(page, handlers)).toThrow('already registered');
    release();
    release();
    expect(() => registerBrowserSessionGuestPolicy(page, handlers)).toThrow('retired');
    expect(
      f.inspectDetails({
        url: 'https://site.example',
        webContentsId: page.id,
      }),
    ).toHaveBeenCalledExactlyOnceWith({ cancel: true });
    expect(handlers.beforeRequest).not.toHaveBeenCalled();
    expect(f.session.resolveHost).not.toHaveBeenCalled();
    expect(() => registerBrowserSessionGuestPolicy(f.background, handlers)).toThrow('unavailable');
    f.owner.release();
  });

  test('a page network policy cannot acquire UI permissions, downloads or PDF notifications', () => {
    const f = fixture();
    const release = registerBrowserSessionGuestPolicy(f.foreground, {
      isCurrent: () => true,
      beforeRequest: (_details, reply) => reply({}),
    });
    expect(f.check(f.foreground, 'notifications', 'https://site.example', {})).toBe(false);
    const permission = vi.fn();
    f.request(f.foreground, 'notifications', permission, {} as Electron.PermissionRequest);
    expect(permission).toHaveBeenCalledExactlyOnceWith(false);
    const download = item();
    f.session.emit('will-download', {}, download, f.foreground);
    expect(download.cancel).toHaveBeenCalledOnce();
    f.headers(
      {
        webContents: f.foreground,
        webContentsId: f.foreground.id,
      } as Electron.OnHeadersReceivedListenerDetails,
      vi.fn(),
    );
    expect(f.ui.checkPermission).not.toHaveBeenCalled();
    expect(f.ui.requestPermission).not.toHaveBeenCalled();
    expect(f.ui.download).not.toHaveBeenCalled();
    expect(f.ui.headersReceived).not.toHaveBeenCalled();
    release();
    expect(f.check(f.foreground, 'notifications', 'https://site.example', {})).toBe(false);
    f.owner.release();
  });

  test.each(['throw', 'reject'] as const)(
    'fails closed when the page policy handlers %s',
    async cause => {
      const f = fixture();
      const page = f.guest();
      const release = registerBrowserSessionGuestPolicy(page, {
        isCurrent: () => true,
        beforeRequest: () => {
          if (cause === 'throw') throw new Error('Policy failed');
          return Promise.reject(new Error('Policy failed'));
        },
      });
      const reply = f.inspect('https://site.example', page);
      await vi.waitFor(() => expect(reply).toHaveBeenCalledExactlyOnceWith({ cancel: true }));
      release();
      f.owner.release();
    },
  );
});
