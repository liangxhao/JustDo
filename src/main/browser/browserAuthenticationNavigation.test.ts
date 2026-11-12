import { EventEmitter } from 'node:events';

import { beforeEach, expect, it, vi } from 'vitest';

const helper = vi.hoisted(() => ({
  authenticateBrowserEntry: vi.fn(),
  commitBrowserAuthenticationCookies: vi.fn(),
  isBrowserAuthenticationAvailable: vi.fn(() => true),
  stopBrowserAuthenticationProcesses: vi.fn(),
}));
vi.mock('./authentication/browserAuthenticationProcess', () => helper);
vi.mock('../../config/browserAuthentication', () => ({
  BROWSER_AUTHENTICATION_CONFIG: {
    providerOrigin: 'https://sign-in.example.test',
    executableName: 'electron.exe',
  },
}));

import { BrowserAuthenticationNavigation } from './browserAuthenticationNavigation';
import { reserveBackgroundBrowserStorageClear } from './data/backgroundBrowserStorage';

const entry = 'https://portal.example.com/protected';
const login = 'https://sign-in.example.test/login1/';
const request = (id: number, url: string) =>
  ({ id, url, method: 'GET', resourceType: 'mainFrame' }) as const;
const redirect = (id: number, from = entry, to = login) => ({
  ...request(id, from),
  redirectURL: to,
  statusCode: 302,
});
const createGuest = (session = {} as Electron.Session): Electron.WebContents =>
  Object.assign(new EventEmitter(), {
    session,
    isDestroyed: () => false,
  }) as unknown as Electron.WebContents;
const current = () => true;

beforeEach(() => {
  vi.clearAllMocks();
  helper.authenticateBrowserEntry.mockResolvedValue([{ name: 'fixture' }]);
  helper.commitBrowserAuthenticationCookies.mockResolvedValue(undefined);
  helper.stopBrowserAuthenticationProcesses.mockResolvedValue(undefined);
});

it.each([entry, 'https://reports.example.net/private?view=monthly'])(
  'commits one helper result and resumes %s across an intermediate redirect',
  async businessUrl => {
    const coordinator = new BrowserAuthenticationNavigation(() => undefined);
    const guest = createGuest();
    const intermediate = new URL('/sso/start', businessUrl).href;
    coordinator.beforeRequest(guest.session, guest, request(1, businessUrl), current);
    coordinator.observeRedirect(guest.session, redirect(1, businessUrl, intermediate));
    coordinator.beforeRequest(guest.session, guest, request(1, intermediate), current);
    expect(helper.isBrowserAuthenticationAvailable).not.toHaveBeenCalled();
    coordinator.observeRedirect(guest.session, redirect(1, intermediate, `${login}#continue`));

    const authenticate = coordinator.beforeRequest(
      guest.session,
      guest,
      request(1, login),
      current,
    );
    expect(await authenticate?.()).toEqual({ redirectURL: businessUrl });
    expect(helper.authenticateBrowserEntry).toHaveBeenCalledWith(
      businessUrl,
      undefined,
      expect.any(AbortSignal),
    );
    expect(helper.commitBrowserAuthenticationCookies).toHaveBeenCalledWith(
      guest.session,
      businessUrl,
      [{ name: 'fixture' }],
      expect.any(Function),
    );

    expect(
      coordinator.beforeRequest(guest.session, guest, request(1, businessUrl), current),
    ).toBeUndefined();
    coordinator.observeRedirect(guest.session, redirect(1, businessUrl));
    expect(
      coordinator.beforeRequest(guest.session, guest, request(1, login), current),
    ).toBeUndefined();
    coordinator.finish(guest.session, 1);
    expect(helper.authenticateBrowserEntry).toHaveBeenCalledTimes(1);
  },
);

it('leaves direct login, unauthorized pages and POST-to-GET navigation with Chromium', () => {
  const coordinator = new BrowserAuthenticationNavigation(() => undefined);
  const guest = createGuest();
  expect(
    coordinator.beforeRequest(guest.session, guest, request(1, login), current),
  ).toBeUndefined();
  coordinator.beforeRequest(guest.session, guest, request(2, entry), () => false);
  coordinator.observeRedirect(guest.session, redirect(2));
  expect(
    coordinator.beforeRequest(guest.session, guest, request(2, login), current),
  ).toBeUndefined();
  coordinator.beforeRequest(
    guest.session,
    guest,
    { ...request(3, entry), method: 'POST' },
    current,
  );
  const afterPost = 'https://portal.example.com/continue';
  coordinator.observeRedirect(guest.session, {
    ...redirect(3, entry, afterPost),
    statusCode: 303,
    method: 'POST',
  });
  coordinator.beforeRequest(guest.session, guest, request(3, afterPost), current);
  coordinator.observeRedirect(guest.session, redirect(3, afterPost));
  expect(
    coordinator.beforeRequest(guest.session, guest, request(3, login), current),
  ).toBeUndefined();
  expect(helper.authenticateBrowserEntry).not.toHaveBeenCalled();
});

it('requires the exact provider origin and next native request for the owning guest', () => {
  const coordinator = new BrowserAuthenticationNavigation(() => undefined);
  const guest = createGuest();
  const other = createGuest(guest.session);
  const lookalike = 'https://sign-in.example.test.other.test/login1/';
  coordinator.beforeRequest(guest.session, guest, request(1, entry), current);
  coordinator.observeRedirect(guest.session, redirect(1, entry, lookalike));
  expect(
    coordinator.beforeRequest(guest.session, guest, request(1, lookalike), current),
  ).toBeUndefined();

  coordinator.observeRedirect(guest.session, redirect(1, lookalike));
  expect(
    coordinator.beforeRequest(guest.session, other, request(1, login), current),
  ).toBeUndefined();
  expect(
    coordinator.beforeRequest(guest.session, guest, request(2, login), current),
  ).toBeUndefined();
  expect(helper.isBrowserAuthenticationAvailable).not.toHaveBeenCalled();
});

it('drops a delayed result after a different navigation supersedes the original', async () => {
  let resolveAuthentication!: (cookies: unknown[]) => void;
  helper.authenticateBrowserEntry.mockReturnValueOnce(
    new Promise(resolve => {
      resolveAuthentication = resolve;
    }),
  );
  const coordinator = new BrowserAuthenticationNavigation(() => undefined);
  const guest = createGuest();
  coordinator.beforeRequest(guest.session, guest, request(1, entry), current);
  coordinator.observeRedirect(guest.session, redirect(1));
  const pending = coordinator.beforeRequest(guest.session, guest, request(1, login), current)?.();
  expect(reserveBackgroundBrowserStorageClear()).toBeNull();

  coordinator.beforeRequest(guest.session, guest, request(2, 'https://example.com'), current);
  resolveAuthentication([{ name: 'fixture' }]);
  expect(await pending).toEqual({ cancel: true });
  expect(helper.commitBrowserAuthenticationCookies).not.toHaveBeenCalled();
  await vi.waitFor(() => {
    const clear = reserveBackgroundBrowserStorageClear();
    expect(clear).toEqual(expect.any(Function));
    clear?.();
  });
});

it('allows the existing login request when the helper fails', async () => {
  helper.authenticateBrowserEntry.mockRejectedValueOnce(new Error('test failure'));
  const coordinator = new BrowserAuthenticationNavigation(() => undefined);
  const guest = createGuest();
  coordinator.beforeRequest(guest.session, guest, request(1, entry), current);
  coordinator.observeRedirect(guest.session, redirect(1));
  const authenticate = coordinator.beforeRequest(
    guest.session,
    guest,
    request(1, `${login}#continue`),
    current,
  );
  expect(await authenticate?.()).toEqual({});
  expect(helper.commitBrowserAuthenticationCookies).not.toHaveBeenCalled();
  coordinator.finish(guest.session, 1);
});

it('cancels the held request on timeout during a cookie write', async () => {
  const deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline.signal);
  let settleCommit!: () => void;
  helper.commitBrowserAuthenticationCookies.mockReturnValueOnce(
    new Promise<void>(resolve => {
      settleCommit = resolve;
    }),
  );
  const coordinator = new BrowserAuthenticationNavigation(() => undefined);
  const guest = createGuest();
  try {
    coordinator.beforeRequest(guest.session, guest, request(1, entry), current);
    coordinator.observeRedirect(guest.session, redirect(1));
    const pending = coordinator.beforeRequest(guest.session, guest, request(1, login), current)?.();
    await vi.waitFor(() => expect(helper.commitBrowserAuthenticationCookies).toHaveBeenCalled());

    deadline.abort();
    expect(await pending).toEqual({ cancel: true });
    expect(reserveBackgroundBrowserStorageClear()).toBeNull();
  } finally {
    settleCommit();
    timeout.mockRestore();
    await coordinator.stop();
  }
});
