import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

import { session, webFrameMain } from 'electron';

import {
  isWebpageEmbedMountId,
  WEBPAGE_EMBED_PAGE,
  type WebpageEmbedInitialization,
  WebpageEmbedIpc,
} from '../../../shared/browser/webpageEmbed';
import {
  BrowserProxyStatus,
  getBrowserProxyCredentials,
  getBrowserProxySessionState,
  observeBrowserProxySession,
  registerBrowserProxySession,
  unregisterBrowserProxySession,
} from '../network/systemProxyPreference';
import { isBlockedBrowserMetadataHost } from './browserPanelSecurity';
import { buildApplicationContentSecurityPolicy } from './renderer/applicationContentSecurityPolicy';
import { createBrowserSessionWebpageGuests } from './webpageBrowserGuest';

type ProxyCredentials = ReturnType<typeof getBrowserProxyCredentials>;

export interface WebpageEmbedMountBinding {
  mountId: string;
  owner: Electron.WebContents;
  shellUrl: string;
  targetUrl: string;
  gatewayOrigin?: string;
  isCurrent: () => boolean;
  shareBrowserSession?: boolean;
  allowsHostedRequest?: (url: string) => boolean;
  hostedRequestHeaders?: Readonly<Record<string, string>>;
  dispose?: () => void;
}

interface GuestOptions {
  preloadPath: string;
  ownsHost: (owner: Electron.WebContents, host: Electron.WebContents) => boolean;
  getCredentials?: () => ProxyCredentials;
  developmentCsp?: { isDev: boolean; devServerPort: number };
}

interface Mount extends WebpageEmbedMountBinding {
  partition: string;
  session: Electron.Session;
  active: boolean;
  prepared: boolean;
  guest?: Electron.WebContents;
  host?: Electron.WebContents;
  stopProxy?: () => void;
  initialProxy?: Promise<void>;
  cleanup: Array<() => void>;
}

const NETWORK_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:']);
const FORBIDDEN_HOSTED_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'host',
  'origin',
  'referer',
]);

/** DNS results are checked with the same rule as literal URLs, including mapped IPv4. */
export function isBlockedWebpageEmbedHost(value: string): boolean {
  let hostname = value
    .toLowerCase()
    .replace(/^\[|\]$/gu, '')
    .replace(/\.$/u, '');
  if (isIP(hostname) === 6) hostname = new URL(`http://[${hostname}]/`).hostname.slice(1, -1);
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === 'localhost.localdomain' ||
    hostname === '::' ||
    hostname === '::1' ||
    isBlockedBrowserMetadataHost(hostname)
  )
    return true;
  if (isIP(hostname) === 4) {
    const first = Number(hostname.split('.')[0]);
    return first === 0 || first === 127;
  }
  if (hostname.startsWith('::ffff:')) {
    const suffix = hostname.slice('::ffff:'.length);
    if (isIP(suffix) === 4) return isBlockedWebpageEmbedHost(suffix);
    const halves = suffix.split(':');
    if (halves.length === 2 && halves.every(part => /^[\da-f]{1,4}$/u.test(part))) {
      const address =
        ((Number.parseInt(halves[0], 16) << 16) | Number.parseInt(halves[1], 16)) >>> 0;
      return isBlockedWebpageEmbedHost(
        [address >>> 24, (address >>> 16) & 255, (address >>> 8) & 255, address & 255].join('.'),
      );
    }
  }
  return false;
}

/** Remote DNS is usable only when Chromium has no direct/fallback route. */
export function hasProxyOnlyWebpageRoute(value: string): boolean {
  const routes = value.split(';').map(route => route.trim());
  return (
    routes.length > 0 &&
    routes.every(route =>
      /^(?:PROXY|HTTPS|SOCKS|SOCKS5)\s+(?:\[[\da-f:]+\]|[^\s;:@/]+):\d{1,5}$/iu.test(route),
    )
  );
}

const httpOrigin = (value: string): string => {
  const url = new URL(value);
  if (url.protocol === 'ws:') url.protocol = 'http:';
  if (url.protocol === 'wss:') url.protocol = 'https:';
  return url.origin;
};

function shellMount(value: string, ownerUrl: string): string | undefined {
  try {
    const url = new URL(value);
    const owner = new URL(ownerUrl);
    const mount = url.searchParams.get('mount');
    if (
      !['http:', 'https:'].includes(owner.protocol) ||
      url.origin !== owner.origin ||
      url.username ||
      url.password ||
      url.hash ||
      url.pathname !== WEBPAGE_EMBED_PAGE ||
      [...url.searchParams].length !== 1 ||
      !isWebpageEmbedMountId(mount)
    )
      return;
    return mount;
  } catch {
    return;
  }
}

/** A fixed shell owns browser-only frames; it never receives native Widget authority. */
export function createWebpageEmbedGuests(options: GuestOptions) {
  const mounts = new Map<string, Mount>();
  const partitions = new Map<string, Mount>();
  const guests = new Map<Electron.WebContents, Mount>();
  const hosts = new Map<Electron.WebContents, { mounts: Set<Mount>; stop: () => void }>();

  const current = (mount: Mount) =>
    mount.active &&
    mounts.get(mount.mountId) === mount &&
    !mount.owner.isDestroyed() &&
    mount.isCurrent();
  const ready = (mount: Mount) =>
    current(mount) &&
    getBrowserProxySessionState(mount.session).status === BrowserProxyStatus.READY;
  const hosted = (mount: Mount, url: string) =>
    current(mount) && mount.allowsHostedRequest?.(url) === true;

  const remoteUrl = (
    mount: Pick<Mount, 'shellUrl' | 'gatewayOrigin'>,
    value: string,
  ): URL | undefined => {
    try {
      const url = new URL(value);
      if (!NETWORK_PROTOCOLS.has(url.protocol) || url.username || url.password) return;
      const origin = httpOrigin(url.href);
      if (
        origin === new URL(mount.shellUrl).origin ||
        (mount.gatewayOrigin && origin === httpOrigin(mount.gatewayOrigin)) ||
        isBlockedWebpageEmbedHost(url.hostname)
      )
        return;
      return url;
    } catch {
      return;
    }
  };
  const navigationAllowed = (mount: Mount, value: string) =>
    ready(mount) &&
    (hosted(mount, value) ||
      Boolean(remoteUrl(mount, value)) ||
      value === 'about:blank' ||
      value === 'about:srcdoc');

  const browserPages = createBrowserSessionWebpageGuests({
    ownsHost: options.ownsHost,
    getCredentials: options.getCredentials ?? getBrowserProxyCredentials,
    remoteUrl,
    isBlockedHost: isBlockedWebpageEmbedHost,
    hasProxyOnlyRoute: hasProxyOnlyWebpageRoute,
  });

  const releaseMount = (mount: Mount): void => {
    if (!mount.active) return;
    mount.active = false;
    mounts.delete(mount.mountId);
    partitions.delete(mount.partition);
    if (mount.guest) guests.delete(mount.guest);
    mount.stopProxy?.();
    for (const cleanup of mount.cleanup) cleanup();
    mount.cleanup = [];
    for (const [host, binding] of hosts) {
      binding.mounts.delete(mount);
      if (!binding.mounts.size) {
        binding.stop();
        hosts.delete(host);
      }
    }
    unregisterBrowserProxySession(mount.session);
    // Electron retains named sessions. Replace callbacks so released sessions
    // cannot send requests or keep their owner and prepared capability alive.
    mount.session.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: true }));
    mount.session.webRequest.onBeforeSendHeaders((_details, callback) =>
      callback({ cancel: true }),
    );
    void Promise.resolve()
      .then(() => mount.session.closeAllConnections())
      .catch(() => {});
    void Promise.resolve()
      .then(() => mount.session.clearStorageData())
      .catch(() => {});
    if (mount.guest && !mount.guest.isDestroyed()) mount.guest.close();
    try {
      mount.dispose?.();
    } catch {
      console.error('[WebpageEmbedGuest] Failed to release static transport.');
    }
  };

  const trackHost = (host: Electron.WebContents, mount: Mount): void => {
    let binding = hosts.get(host);
    if (!binding) {
      const owned = new Set<Mount>();
      const revoke = () => {
        for (const entry of [...owned]) releaseMount(entry);
      };
      const navigation = (
        _event: Electron.Event,
        _url: string,
        inPlace: boolean,
        mainFrame: boolean,
      ) => {
        if (mainFrame && !inPlace) revoke();
      };
      const stop = () => {
        host.removeListener('destroyed', revoke);
        host.removeListener('render-process-gone', revoke);
        host.removeListener('did-start-navigation', navigation);
      };
      binding = { mounts: owned, stop };
      hosts.set(host, binding);
      host.once('destroyed', revoke);
      host.on('render-process-gone', revoke);
      host.on('did-start-navigation', navigation);
    }
    binding.mounts.add(mount);
  };

  const configureNetwork = (mount: Mount): void => {
    const appOrigin = new URL(mount.shellUrl).origin;
    const shellRequest = (details: {
      url: string;
      resourceType: string;
      frame?: Electron.WebFrameMain | null;
    }) => {
      try {
        return (
          current(mount) &&
          new URL(details.url).origin === appOrigin &&
          ((details.resourceType === 'mainFrame' && details.url === mount.shellUrl) ||
            (mount.guest &&
              details.frame === mount.guest.mainFrame &&
              details.resourceType !== 'mainFrame' &&
              details.resourceType !== 'subFrame'))
        );
      } catch {
        return false;
      }
    };
    mount.session.webRequest.onBeforeRequest((details, callback) => {
      let url: URL;
      try {
        url = new URL(details.url);
      } catch {
        callback({ cancel: true });
        return;
      }
      // The shell must be able to display a proxy error while page requests are
      // paused. Only its own main frame may fetch the application's static assets.
      if (shellRequest(details)) {
        callback({});
        return;
      }
      if (!ready(mount) || details.resourceType === 'mainFrame') {
        callback({ cancel: true });
        return;
      }
      if (hosted(mount, details.url)) {
        callback({});
        return;
      }
      if (
        url.protocol === 'data:' ||
        (url.protocol === 'about:' && ['about:blank', 'about:srcdoc'].includes(url.href)) ||
        (url.protocol === 'blob:' && (url.origin === 'null' || remoteUrl(mount, url.origin)))
      ) {
        callback({});
        return;
      }
      const remote = remoteUrl(mount, details.url);
      if (!remote) {
        callback({ cancel: true });
        return;
      }
      const generation = getBrowserProxySessionState(mount.session).generation;
      void (async () => {
        // PAC/OS routing belongs to this session. A proxy-only route may resolve
        // names remotely; local DNS failure alone does not prove it unreachable.
        const route = await mount.session.resolveProxy(remote.href);
        let addresses: string[] | undefined;
        try {
          const resolved = await mount.session.resolveHost(
            remote.hostname.replace(/^\[|\]$/gu, ''),
          );
          addresses = resolved.endpoints.map(endpoint => endpoint.address);
        } catch {
          /* The explicitly configured proxy may own DNS for this name. */
        }
        const targetAllowed = addresses?.length
          ? addresses.every(address => isIP(address) && !isBlockedWebpageEmbedHost(address))
          : hasProxyOnlyWebpageRoute(route);
        const allowed =
          targetAllowed &&
          ready(mount) &&
          generation === getBrowserProxySessionState(mount.session).generation;
        callback(allowed ? {} : { cancel: true });
      })().catch(() => callback({ cancel: true }));
    });
    const headerNames = new Set(
      Object.keys(mount.hostedRequestHeaders ?? {}).map(name => name.toLowerCase()),
    );
    mount.session.webRequest.onBeforeSendHeaders((details, callback) => {
      if (!ready(mount) && !shellRequest(details)) {
        callback({ cancel: true });
        return;
      }
      const headers = { ...details.requestHeaders };
      // Strip on every request, including redirects, before considering an
      // exact scoped re-add. The random mount secret is never a Gateway token.
      for (const name of Object.keys(headers))
        if (headerNames.has(name.toLowerCase())) delete headers[name];
      if (ready(mount) && hosted(mount, details.url))
        Object.assign(headers, mount.hostedRequestHeaders);
      callback({ requestHeaders: headers });
    });
  };

  return {
    registerMount(binding: WebpageEmbedMountBinding): { partition: string; viewerUrl?: string } {
      if (
        !isWebpageEmbedMountId(binding.mountId) ||
        mounts.has(binding.mountId) ||
        browserPages.has(binding.mountId) ||
        binding.owner.isDestroyed() ||
        !binding.isCurrent() ||
        shellMount(binding.shellUrl, binding.owner.getURL()) !== binding.mountId
      )
        throw new Error('Webpage embed mount is unavailable.');
      for (const [name, value] of Object.entries(binding.hostedRequestHeaders ?? {})) {
        if (
          !/^[!#$%&'*+.^_`|~\da-z-]+$/iu.test(name) ||
          FORBIDDEN_HOSTED_HEADERS.has(name.toLowerCase()) ||
          /[\r\n]/u.test(value)
        )
          throw new Error('Invalid webpage embed transport header.');
      }
      if (
        !remoteUrl(binding, binding.targetUrl) &&
        binding.allowsHostedRequest?.(binding.targetUrl) !== true
      )
        throw new Error('Webpage embed target is not allowed.');
      if (binding.shareBrowserSession) return browserPages.registerMount(binding);
      const partition = `webpage-embed:${binding.mountId}:${randomUUID()}`;
      const targetSession = session.fromPartition(partition, { cache: false });
      const mount: Mount = {
        ...binding,
        partition,
        session: targetSession,
        active: true,
        prepared: false,
        cleanup: [],
      };
      mounts.set(binding.mountId, mount);
      partitions.set(partition, mount);
      targetSession.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      targetSession.setPermissionCheckHandler(() => false);
      if (options.developmentCsp?.isDev) {
        const appOrigin = new URL(binding.shellUrl).origin;
        const policy = buildApplicationContentSecurityPolicy(options.developmentCsp);
        targetSession.webRequest.onHeadersReceived((details, callback) => {
          let isShellOrigin = false;
          try {
            isShellOrigin = new URL(details.url).origin === appOrigin;
          } catch {
            /* Untrusted URL. */
          }
          callback({
            responseHeaders: isShellOrigin
              ? { ...details.responseHeaders, 'Content-Security-Policy': policy }
              : details.responseHeaders,
          });
        });
      }
      const download = (event: Electron.Event) => event.preventDefault();
      targetSession.on('will-download', download);
      mount.cleanup.push(() => targetSession.removeListener('will-download', download));
      configureNetwork(mount);
      mount.stopProxy = observeBrowserProxySession(targetSession, state => {
        if (mount.guest && current(mount) && !mount.guest.isDestroyed())
          mount.guest.send(WebpageEmbedIpc.ProxyState, state);
      });
      trackHost(binding.owner, mount);
      mount.initialProxy = registerBrowserProxySession(targetSession);
      void mount.initialProxy.catch(() => {});
      return { partition };
    },

    prepare(
      event: Electron.Event,
      preferences: Electron.WebPreferences,
      params: Record<string, string>,
      host: Electron.WebContents,
    ): boolean {
      if (browserPages.prepare(event, preferences, params, host)) return true;
      const mount = partitions.get(params.partition);
      if (!mount)
        return params.partition?.startsWith('webpage-embed:')
          ? (event.preventDefault(), true)
          : false;
      if (
        !current(mount) ||
        mount.prepared ||
        params.src !== mount.shellUrl ||
        !options.ownsHost(mount.owner, host)
      ) {
        event.preventDefault();
        return true;
      }
      Object.assign(preferences, {
        partition: mount.partition,
        session: mount.session,
        preload: options.preloadPath,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        plugins: false,
        spellcheck: false,
        disableDialogs: true,
        navigateOnDragDrop: false,
      });
      mount.prepared = true;
      mount.host = host;
      trackHost(host, mount);
      return true;
    },

    attach(guest: Electron.WebContents, host: Electron.WebContents): boolean {
      if (browserPages.attach(guest, host)) return true;
      const mount = [...mounts.values()].find(entry => entry.session === guest.session);
      if (!mount) return false;
      if (
        !current(mount) ||
        !mount.prepared ||
        mount.guest ||
        mount.host !== host ||
        !options.ownsHost(mount.owner, host) ||
        guest.getType() !== 'webview'
      ) {
        guest.close();
        return true;
      }
      mount.guest = guest;
      guests.set(guest, mount);
      guest.setWindowOpenHandler(() => ({ action: 'deny' }));
      guest.on('will-navigate', event => event.preventDefault());
      const guardNavigation = (
        event: { isMainFrame: boolean; frame: Electron.WebFrameMain | null; preventDefault(): void },
        url: string,
      ) => {
        if (!event.isMainFrame && navigationAllowed(mount, url)) return;
        event.preventDefault();
        // Chromium emits no load-failure event for a prevented redirect. Keep
        // proxy pauses and failures in nested frames out of the page failure path.
        if (!event.isMainFrame && ready(mount) && event.frame?.parent === guest.mainFrame)
          guest.send(WebpageEmbedIpc.NativeFailure);
      };
      guest.on('will-frame-navigate', event => {
        guardNavigation(event, event.url);
      });
      guest.on('will-redirect', (event, url) => {
        guardNavigation(event, url);
      });
      let navigated = false;
      let pageNavigation: { processId: number; routingId: number; url: string } | undefined;
      const directPageFrame = (processId: number, routingId: number) => {
        try {
          return webFrameMain.fromId(processId, routingId)?.parent === guest.mainFrame;
        } catch {
          return false;
        }
      };
      guest.on('will-redirect', (event, url) => {
        if (
          !event.isMainFrame &&
          pageNavigation &&
          event.frame?.parent === guest.mainFrame &&
          event.frame.processId === pageNavigation.processId &&
          event.frame.routingId === pageNavigation.routingId
        )
          pageNavigation.url = url;
      });
      guest.on('did-start-navigation', (_event, url, inPlace, mainFrame, processId, routingId) => {
        if (!mainFrame) {
          if (!inPlace && directPageFrame(processId, routingId))
            pageNavigation = { processId, routingId, url };
          return;
        }
        if (navigated || inPlace || url !== mount.shellUrl) {
          releaseMount(mount);
          return;
        }
        navigated = true;
      });
      guest.on(
        'did-fail-load',
        (_event, code, _description, url, mainFrame, processId, routingId) => {
          if (
            code === -3 ||
            mainFrame ||
            !current(mount) ||
            !pageNavigation ||
            pageNavigation.processId !== processId ||
            pageNavigation.routingId !== routingId ||
            pageNavigation.url !== url
          )
            return;
          guest.send(WebpageEmbedIpc.NativeFailure);
        },
      );
      guest.on('login', (event, _details, info, callback) => {
        event.preventDefault();
        const credentials = (options.getCredentials ?? getBrowserProxyCredentials)();
        if (
          ready(mount) &&
          info.isProxy &&
          credentials &&
          info.host.toLowerCase().replace(/^\[|\]$/gu, '') === credentials.host.toLowerCase() &&
          info.port === credentials.port
        )
          callback(credentials.username, credentials.password);
        else callback();
      });
      guest.once('destroyed', () => releaseMount(mount));
      guest.once('render-process-gone', () => releaseMount(mount));
      return true;
    },

    async read(event: Electron.IpcMainInvokeEvent): Promise<WebpageEmbedInitialization> {
      const mount = guests.get(event.sender);
      if (
        !mount ||
        !current(mount) ||
        event.senderFrame !== event.sender.mainFrame ||
        event.senderFrame.url !== mount.shellUrl
      )
        throw new Error('Webpage embed viewer is unavailable.');
      await mount.initialProxy?.catch(() => {});
      if (!current(mount) || guests.get(event.sender) !== mount)
        throw new Error('Webpage embed viewer is unavailable.');
      return {
        mountId: mount.mountId,
        targetUrl: mount.targetUrl,
        proxy: getBrowserProxySessionState(mount.session),
      };
    },

    async retry(owner: Electron.WebContents, mountId: string): Promise<void> {
      if (browserPages.has(mountId)) return browserPages.retry(owner, mountId);
      const mount = mounts.get(mountId);
      if (!mount || mount.owner !== owner || !current(mount))
        throw new Error('Webpage embed viewer is unavailable.');
      await registerBrowserProxySession(mount.session);
      if (!ready(mount)) throw new Error('Webpage embed viewer is unavailable.');
    },

    release(owner: Electron.WebContents, mountId: string): void {
      browserPages.release(owner, mountId);
      const mount = mounts.get(mountId);
      if (mount?.owner === owner) releaseMount(mount);
    },

    dispose(): void {
      browserPages.dispose();
      for (const mount of [...mounts.values()]) releaseMount(mount);
    },
  };
}
