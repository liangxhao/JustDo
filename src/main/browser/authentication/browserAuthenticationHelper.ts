import { isIP } from 'node:net';
import { basename } from 'node:path';

import { app, BrowserWindow, session } from 'electron';

import { BROWSER_AUTHENTICATION_SWITCH } from '../../../shared/browser/browserAuthentication';
import {
  normalizeProxySettings,
  ProxyMode,
  type ProxySettings,
} from '../../../shared/network/proxy';
import { isLoopbackBaseUrl } from '../../core/network/systemProxy';
import {
  applyBrowserProxyPreference,
  getBrowserProxyCredentials,
  registerBrowserProxySession,
} from '../../core/network/systemProxyPreference';
import { isAllowedBrowserPanelUrl } from '../../core/window/browserPanelSecurity';
import { ensureBrowserSessionPolicy } from '../browserSessionPolicy';
import {
  BROWSER_AUTHENTICATION_EXECUTABLE,
  BROWSER_AUTHENTICATION_PROVIDER_ORIGIN,
  getBrowserAuthenticationProviderUrl,
  normalizeBrowserAuthenticationEntry,
} from './browserAuthenticationConfig';
import {
  type BrowserAuthenticationCookie,
  readBrowserAuthenticationCookies,
} from './browserAuthenticationCookies';
import {
  BrowserAuthenticationMessage,
  browserAuthenticationProfile,
  isBrowserAuthenticationMessage,
} from './browserAuthenticationProtocol';

const PARTITION = 'browser-authentication';
const LOCAL_ENDPOINT = 'https://localhost:18080/getSpesInfo';
const LOCAL_SERVICE_PORT = new URL(LOCAL_ENDPOINT).port;
const MAX_VERIFY_BYTES = 64 * 1024;
const AUTHENTICATION_SHELL =
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(
    '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" ' +
      'content="default-src \'none\'; frame-src about:"><webview src="about:blank" partition="' +
      PARTITION +
      '"></webview>',
  );

function requestHeader(headers: Record<string, string>, name: string): string | undefined {
  const matches = Object.entries(headers).filter(([key]) => key.toLowerCase() === name);
  return matches.length === 1 ? matches[0][1] : undefined;
}

function isLocalServiceHost(hostname: string): boolean {
  const mapped = /^\[::ffff:([\da-f]+):([\da-f]+)\]$/u.exec(hostname);
  return (
    hostname === '0.0.0.0' ||
    hostname === '[::]' ||
    Boolean(
      mapped &&
      (Number.parseInt(mapped[1], 16) >> 8 === 127 ||
        (Number.parseInt(mapped[1], 16) === 0 && Number.parseInt(mapped[2], 16) === 0)),
    ) ||
    isLoopbackBaseUrl(`https://${hostname}`)
  );
}

function isNonLoopbackAddress(address: string): boolean {
  const version = isIP(address);
  if (!version) return false;
  const normalized = URL.parse(`https://${version === 6 ? `[${address}]` : address}`)?.hostname;
  return Boolean(normalized && !isLocalServiceHost(normalized));
}

function restrictLocalAuthenticationRequests(browserSession: Electron.Session): void {
  // The helper may visit arbitrary business pages. Chromium owns the Origin
  // header, so a page cannot impersonate the provider with fetch or a form.
  browserSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const target = URL.parse(details.url);
    if (target?.port !== LOCAL_SERVICE_PORT) {
      callback({});
      return;
    }
    if (target.href !== LOCAL_ENDPOINT) {
      if (isLocalServiceHost(target.hostname)) {
        callback({ cancel: true });
        return;
      }
      // Other sites may use the same port. Check the Chromium Session's DNS
      // results without overriding its proxy or allowing a known loopback alias.
      const hostname = target.hostname.replace(/^\[|\]$/gu, '');
      void Promise.resolve()
        .then(() => browserSession.resolveHost(hostname))
        .then(
          ({ endpoints }) =>
            callback({
              cancel:
                !endpoints.length ||
                endpoints.some(endpoint => !isNonLoopbackAddress(endpoint.address)),
            }),
          () => callback({ cancel: true }),
        );
      return;
    }
    const headers = details.requestHeaders;
    const authorized =
      BROWSER_AUTHENTICATION_PROVIDER_ORIGIN !== null &&
      requestHeader(headers, 'origin') === BROWSER_AUTHENTICATION_PROVIDER_ORIGIN &&
      (details.method === 'POST' ||
        (details.method === 'OPTIONS' &&
          requestHeader(headers, 'access-control-request-method') === 'POST'));
    callback({ cancel: !authorized });
  });
}

function configureAuthenticationGuest(guest: Electron.WebContents): void {
  guest.setWindowOpenHandler(() => ({ action: 'deny' }));
  const checkNavigation = (event: Electron.Event, url: string): void => {
    if (url === 'about:blank') return;
    try {
      const destination = new URL(url);
      if (
        destination.protocol === 'https:' &&
        !destination.username &&
        !destination.password &&
        isAllowedBrowserPanelUrl(url)
      )
        return;
    } catch {
      /* Other schemes and malformed URLs cannot enter the login window. */
    }
    event.preventDefault();
  };
  guest.on('will-navigate', checkNavigation);
  guest.on('will-redirect', checkNavigation);
  guest.on('will-frame-navigate', event => {
    if (event.isMainFrame) checkNavigation(event, event.url);
  });
  guest.on('login', (event, _details, info, callback) => {
    event.preventDefault();
    const proxy = getBrowserProxyCredentials();
    if (
      info.isProxy &&
      proxy &&
      info.host.toLowerCase() === proxy.host &&
      info.port === proxy.port
    ) {
      callback(proxy.username, proxy.password);
    } else callback();
  });
  guest.on('select-bluetooth-device', (event, _devices, callback) => {
    event.preventDefault();
    callback('');
  });
}

async function getAuthenticationGuest(window: BrowserWindow): Promise<Electron.WebContents> {
  const shell = window.webContents;
  shell.setWindowOpenHandler(() => ({ action: 'deny' }));
  shell.on('will-navigate', event => event.preventDefault());
  shell.on('will-attach-webview', (event, preferences, params) => {
    if (params.src !== 'about:blank' || params.partition !== PARTITION) {
      event.preventDefault();
      return;
    }
    Object.assign(preferences, {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      backgroundThrottling: false,
    });
    delete preferences.preload;
  });
  const attached = new Promise<Electron.WebContents>(resolve => {
    shell.once('did-attach-webview', (_event, guest) => resolve(guest));
  });
  await window.loadURL(AUTHENTICATION_SHELL);
  return attached;
}

function verifyAuthenticationResponse(body: { body: string; base64Encoded: boolean }): boolean {
  const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
  if (text.length > MAX_VERIFY_BYTES) return false;
  try {
    const code: unknown = JSON.parse(text)?.result?.code;
    return code === 200 || code === '200';
  } catch {
    return false;
  }
}

async function authenticateInGuest(
  guest: Electron.WebContents,
  entry: URL,
): Promise<BrowserAuthenticationCookie[]> {
  configureAuthenticationGuest(guest);
  guest.debugger.attach('1.3');
  await guest.debugger.sendCommand('Network.enable', {
    maxTotalBufferSize: 512 * 1024,
    maxResourceBufferSize: MAX_VERIFY_BYTES,
    enableDurableMessages: true,
  });
  await guest.debugger.sendCommand('Network.setCacheDisabled', { cacheDisabled: true });

  return new Promise((resolve, reject) => {
    type AuthRequest =
      | { kind: 'local' | 'verify'; status?: number }
      | { kind: 'login'; startedAt: number; verifyId: string };
    const requests = new Map<string, AuthRequest>();
    const verified = new Set<string>();
    let chronology = 0;
    let localSucceeded = false;
    let lastVerifyResponse: string | undefined;
    let successfulLogin: Extract<AuthRequest, { kind: 'login' }> | undefined;
    let landing: { url: string; navigatedAt: number } | undefined;
    let exporting = false;
    const fail = (): void => reject(new Error('Browser authentication did not finish.'));

    const tryExport = async (): Promise<void> => {
      if (
        !successfulLogin ||
        !verified.has(successfulLogin.verifyId) ||
        !landing ||
        landing.navigatedAt <= successfulLogin.startedAt ||
        exporting ||
        guest.isDestroyed() ||
        guest.isLoadingMainFrame() ||
        guest.getURL() !== landing.url
      )
        return;
      const authenticatedLanding = landing;
      exporting = true;
      try {
        const result = await guest.debugger.sendCommand('Network.getCookies', {
          urls: [entry.href, authenticatedLanding.url],
        });
        if (
          guest.isDestroyed() ||
          landing !== authenticatedLanding ||
          guest.getURL() !== authenticatedLanding.url
        )
          return;
        const cookies = readBrowserAuthenticationCookies(result.cookies, entry);
        if (!cookies.length) return fail();
        resolve(cookies);
      } catch {
        fail();
      } finally {
        exporting = false;
        if (landing !== authenticatedLanding) void tryExport();
      }
    };

    const observeLoginResponse = (request: AuthRequest | undefined, status: number): void => {
      if (
        request?.kind === 'login' &&
        status >= 200 &&
        status < 400 &&
        (!successfulLogin || successfulLogin.startedAt < request.startedAt)
      ) {
        successfulLogin = request;
        void tryExport();
      }
    };

    guest.once('destroyed', fail);
    guest.once('render-process-gone', fail);
    guest.debugger.once('detach', fail);
    guest.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) landing = undefined;
    });
    guest.on('did-navigate', (_event, url, status) => {
      landing = undefined;
      try {
        if (status >= 200 && status < 300 && new URL(url).origin === entry.origin)
          landing = { url, navigatedAt: ++chronology };
      } catch {
        /* The landing must be a valid URL on the business origin. */
      }
      void tryExport();
    });
    guest.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame && landing && new URL(url).origin === entry.origin) {
        landing = { ...landing, url };
        void tryExport();
      }
    });
    guest.on('did-stop-loading', () => {
      void tryExport();
    });

    guest.debugger.on('message', (_event, method, data) => {
      if (method === 'Network.requestWillBeSent') {
        if (data.redirectResponse) {
          observeLoginResponse(requests.get(data.requestId), data.redirectResponse.status);
          requests.delete(data.requestId);
        }
        if (
          data.request.method !== 'POST' ||
          !getBrowserAuthenticationProviderUrl(data.documentURL)
        )
          return;
        if (data.request.url === LOCAL_ENDPOINT) {
          requests.set(data.requestId, { kind: 'local' });
        } else {
          const url = getBrowserAuthenticationProviderUrl(data.request.url);
          if (localSucceeded && url && /\/spes-verify\/?$/iu.test(url.pathname)) {
            requests.set(data.requestId, { kind: 'verify' });
          } else if (lastVerifyResponse && url && /\/spes-login\/?$/iu.test(url.pathname)) {
            requests.set(data.requestId, {
              kind: 'login',
              startedAt: ++chronology,
              verifyId: lastVerifyResponse,
            });
          }
        }
      } else if (method === 'Network.responseReceived') {
        const request = requests.get(data.requestId);
        if (request?.kind === 'login') {
          observeLoginResponse(request, data.response.status);
        } else if (request) {
          request.status = data.response.status;
          if (request.kind === 'local' && request.status === 200) localSucceeded = true;
          if (request.kind === 'verify' && request.status === 200)
            lastVerifyResponse = data.requestId;
        }
      } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
        const request = requests.get(data.requestId);
        requests.delete(data.requestId);
        if (
          method === 'Network.loadingFinished' &&
          request?.kind === 'verify' &&
          request.status === 200 &&
          data.encodedDataLength <= MAX_VERIFY_BYTES
        ) {
          void guest.debugger
            .sendCommand('Network.getResponseBody', { requestId: data.requestId })
            .then(body => {
              if (verifyAuthenticationResponse(body)) {
                verified.add(data.requestId);
                return tryExport();
              }
            })
            .catch(() => {});
        }
      }
    });
    void guest.loadURL(entry.href).catch(() => {
      // Chromium can abort the initial load promise while following an in-page login redirect.
      // The native events above determine which navigation actually completed.
    });
  });
}

async function authenticate(
  entry: URL,
  proxy: ProxySettings,
): Promise<BrowserAuthenticationCookie[]> {
  const browserSession = session.fromPartition(PARTITION);
  if (!(await applyBrowserProxyPreference({ browserProxy: proxy }))) {
    throw new Error('Browser authentication proxy is unavailable.');
  }
  await registerBrowserProxySession(browserSession);
  ensureBrowserSessionPolicy(browserSession);
  restrictLocalAuthenticationRequests(browserSession);
  const window = new BrowserWindow({
    show: false,
    width: 1120,
    height: 820,
    webPreferences: {
      webviewTag: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  try {
    return await authenticateInGuest(await getAuthenticationGuest(window), entry);
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}

/** Helper mode is selected before normal application storage and services start. */
export function runBrowserAuthenticationHelper(): void {
  if (
    !app.isPackaged ||
    process.platform !== 'win32' ||
    basename(process.execPath).toLowerCase() !== BROWSER_AUTHENTICATION_EXECUTABLE ||
    !process.argv.includes(BROWSER_AUTHENTICATION_SWITCH) ||
    !process.connected ||
    !process.send
  ) {
    app.exit(1);
    return;
  }
  try {
    const profile = browserAuthenticationProfile();
    for (const key of ['appData', 'userData', 'sessionData', 'home'] as const)
      app.setPath(key, profile);
  } catch {
    app.exit(1);
    return;
  }
  // Finish sending the authenticated result after destroying the last window.
  app.on('window-all-closed', () => {});
  process.once('disconnect', () => app.exit(1));
  process.once('message', (message: unknown) => {
    if (
      !isBrowserAuthenticationMessage(message) ||
      message.type !== BrowserAuthenticationMessage.Authenticate
    ) {
      app.exit(1);
      return;
    }
    const entry =
      typeof message.entryUrl === 'string'
        ? normalizeBrowserAuthenticationEntry(message.entryUrl)
        : null;
    if (!entry) {
      app.exit(1);
      return;
    }
    const proxy = normalizeProxySettings(
      message.browserProxy as Partial<ProxySettings> | undefined,
      ProxyMode.SYSTEM,
    );
    void app
      .whenReady()
      .then(() => authenticate(new URL(entry), proxy))
      .then(cookies => {
        process.send?.(
          { type: BrowserAuthenticationMessage.Authenticated, cookies },
          (error: Error | null) => {
            app.exit(error ? 1 : 0);
          },
        );
      })
      .catch(() => app.exit(1));
  });
  process.send({ type: BrowserAuthenticationMessage.Ready }, (error: Error | null) => {
    if (error) app.exit(1);
  });
}
