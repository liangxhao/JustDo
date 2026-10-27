import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

import { app, session } from 'electron';

import { BROWSER_PANEL_PARTITION } from '../../../shared/browser/browser';
import {
  WEBPAGE_EMBED_OPEN_LINK_EVENT,
  WebpageEmbedIpc,
  type WebpageEmbedStateEvent,
} from '../../../shared/browser/webpageEmbed';
import { isSameBrowserSession } from '../../browser/browserSessionIdentity';
import { registerBrowserSessionGuestPolicy } from '../../browser/browserSessionPolicy';
import {
  BrowserProxyStatus,
  getBrowserProxySessionState,
  observeBrowserProxySession,
  registerBrowserProxySession,
} from '../network/systemProxyPreference';
import type { WebpageEmbedMountBinding } from './webpageEmbedGuest';

// No application origin, scripts or preload run in the shared browser profile.
const STARTUP_PREFIX = 'data:text/html;charset=utf-8,%3C!--webpage-embed%3A';

type Options = {
  ownsHost: (owner: Electron.WebContents, host: Electron.WebContents) => boolean;
  getCredentials: () => { host: string; port: number; username: string; password: string } | null;
  remoteUrl: (binding: WebpageEmbedMountBinding, value: string) => URL | undefined;
  isBlockedHost: (value: string) => boolean;
  hasProxyOnlyRoute: (value: string) => boolean;
};

type Mount = WebpageEmbedMountBinding & {
  partition: string;
  startupUrl: string;
  session: Electron.Session;
  active: boolean;
  prepared: boolean;
  attached: boolean;
  startupReady: boolean;
  started: boolean;
  navigationUrl?: string;
  host?: Electron.WebContents;
  guest?: Electron.WebContents;
  stopProxy?: () => void;
  releasePolicy?: () => void;
  stopOwner: () => void;
  stopHost?: () => void;
};

/** Browser pages share the sidebar's profile, while each mount owns only its page. */
export function createBrowserSessionWebpageGuests(options: Options) {
  const mounts = new Map<string, Mount>();
  const partitions = new Map<string, Mount>();
  const startups = new Map<string, Mount>();
  const guests = new WeakMap<Electron.WebContents, Mount>();
  const recognized = new WeakSet<Electron.WebContents>();
  const observing = new Map<Electron.WebContents, () => void>();
  const hosts = new Map<Electron.WebContents, { mounts: Set<Mount>; stop: () => void }>();
  let listening = false;

  const current = (mount: Mount) =>
    mount.active &&
    mounts.get(mount.mountId) === mount &&
    !mount.owner.isDestroyed() &&
    mount.isCurrent() &&
    (!mount.guest || (!mount.guest.isDestroyed() && guests.get(mount.guest) === mount));
  const ready = (mount: Mount) =>
    current(mount) &&
    getBrowserProxySessionState(mount.session).status === BrowserProxyStatus.READY;
  const emit = (mount: Mount, type: WebpageEmbedStateEvent['type']) => {
    if (current(mount)) mount.owner.send(WebpageEmbedIpc.Event, { mountId: mount.mountId, type });
  };
  const releaseMount = (mount: Mount) => {
    if (!mount.active) return;
    mount.active = false;
    mounts.delete(mount.mountId);
    partitions.delete(mount.partition);
    startups.delete(mount.startupUrl);
    mount.stopProxy?.();
    mount.releasePolicy?.();
    mount.stopOwner();
    mount.stopHost?.();
    // Never clear storage, unregister the proxy or close shared profile connections.
    if (mount.guest && !mount.guest.isDestroyed()) mount.guest.close();
    try {
      mount.dispose?.();
    } catch {
      console.error('[WebpageBrowserGuest] Failed to release the webpage mount.');
    }
  };
  const trackHost = (host: Electron.WebContents, mount: Mount) => {
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
        main: boolean,
      ) => {
        if (main && !inPlace) revoke();
      };
      host.once('destroyed', revoke);
      host.on('render-process-gone', revoke);
      host.on('did-start-navigation', navigation);
      binding = {
        mounts: owned,
        stop: () => {
          host.removeListener('destroyed', revoke);
          host.removeListener('render-process-gone', revoke);
          host.removeListener('did-start-navigation', navigation);
        },
      };
      hosts.set(host, binding);
    }
    binding.mounts.add(mount);
    return () => {
      binding.mounts.delete(mount);
      if (!binding.mounts.size) {
        binding.stop();
        hosts.delete(host);
      }
    };
  };
  const start = (mount: Mount) => {
    if (!mount.attached || !mount.startupReady || mount.started || !ready(mount) || !mount.guest)
      return;
    mount.started = true;
    mount.navigationUrl = mount.targetUrl;
    // Native failure/navigation events own the page outcome. A normal SSO or
    // user navigation can abort this initial load promise while its new page works.
    void mount.guest.loadURL(mount.targetUrl).catch(() => {});
  };
  const created = (_event: Electron.Event, guest: Electron.WebContents) => {
    if (guest.getType() !== 'webview') return;
    const stop = () => {
      guest.removeListener('did-start-navigation', firstNavigation);
      guest.removeListener('destroyed', stop);
      observing.delete(guest);
    };
    const firstNavigation = (
      _event: Electron.Event,
      url: string,
      inPlace: boolean,
      main: boolean,
    ) => {
      if (!main) return;
      stop();
      if (!url.startsWith(STARTUP_PREFIX)) return;
      recognized.add(guest);
      const mount = startups.get(url);
      if (
        !mount ||
        !current(mount) ||
        inPlace ||
        !mount.prepared ||
        mount.guest ||
        guest.hostWebContents !== mount.host ||
        !isSameBrowserSession(guest.session, mount.session)
      ) {
        guest.close();
        return;
      }
      mount.guest = guest;
      guests.set(guest, mount);
    };
    observing.set(guest, stop);
    guest.on('did-start-navigation', firstNavigation);
    guest.once('destroyed', stop);
  };

  return {
    has(mountId: string): boolean {
      return mounts.has(mountId);
    },
    registerMount(binding: WebpageEmbedMountBinding): { partition: string; viewerUrl: string } {
      if (
        mounts.has(binding.mountId) ||
        !options.remoteUrl(binding, binding.targetUrl) ||
        binding.hostedRequestHeaders ||
        binding.allowsHostedRequest
      )
        throw new Error('Browser webpage mount is unavailable.');
      if (!listening) {
        app.on('web-contents-created', created);
        listening = true;
      }
      const nonce = randomUUID();
      const partition = `webpage-embed:${binding.mountId}:${nonce}`;
      const startupUrl = `${STARTUP_PREFIX}${binding.mountId}%3A${nonce}--%3E`;
      const browserSession = session.fromPartition(BROWSER_PANEL_PARTITION);
      const mount: Mount = {
        ...binding,
        partition,
        startupUrl,
        session: browserSession,
        active: true,
        prepared: false,
        attached: false,
        startupReady: false,
        started: false,
        stopOwner: () => {},
      };
      mounts.set(mount.mountId, mount);
      partitions.set(partition, mount);
      startups.set(startupUrl, mount);
      mount.stopOwner = trackHost(binding.owner, mount);
      mount.stopProxy = observeBrowserProxySession(browserSession, state => {
        emit(mount, `proxy-${state.status}`);
        start(mount);
      });
      void registerBrowserProxySession(browserSession).catch(() => {});
      return { partition, viewerUrl: startupUrl };
    },
    prepare(
      event: Electron.Event,
      preferences: Electron.WebPreferences,
      params: Record<string, string>,
      host: Electron.WebContents,
    ): boolean {
      const mount = partitions.get(params.partition);
      if (!mount) {
        if (!params.src?.startsWith(STARTUP_PREFIX)) return false;
        // A startup URL is not enough: it must pass this prepared ticket path,
        // never the ordinary browser path with a different preload.
        event.preventDefault();
        return true;
      }
      if (
        !current(mount) ||
        mount.prepared ||
        params.src !== mount.startupUrl ||
        !options.ownsHost(mount.owner, host)
      ) {
        event.preventDefault();
        return true;
      }
      Object.assign(preferences, {
        partition: mount.partition,
        session: mount.session,
        preload: undefined,
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
      if (host !== mount.owner) mount.stopHost = trackHost(host, mount);
      return true;
    },
    attach(guest: Electron.WebContents, host: Electron.WebContents): boolean {
      if (!recognized.has(guest)) return false;
      const mount = guests.get(guest);
      if (
        !mount ||
        !current(mount) ||
        !mount.prepared ||
        mount.attached ||
        mount.host !== host ||
        !options.ownsHost(mount.owner, host) ||
        !isSameBrowserSession(guest.session, mount.session)
      ) {
        if (!guest.isDestroyed()) guest.close();
        return true;
      }
      mount.attached = true;
      mount.releasePolicy = registerBrowserSessionGuestPolicy(guest, {
        isCurrent: () => current(mount),
        beforeRequest: async (details, callback) => {
          if (details.url === mount.startupUrl && details.resourceType === 'mainFrame') {
            callback({});
            return;
          }
          if (!ready(mount)) {
            callback({ cancel: true });
            return;
          }
          let url: URL;
          try {
            url = new URL(details.url);
          } catch {
            callback({ cancel: true });
            return;
          }
          if (
            url.protocol === 'data:' ||
            ['about:blank', 'about:srcdoc'].includes(url.href) ||
            (url.protocol === 'blob:' && options.remoteUrl(mount, url.origin))
          ) {
            callback({});
            return;
          }
          const remote = options.remoteUrl(mount, details.url);
          if (
            !remote ||
            (details.resourceType === 'mainFrame' && !['http:', 'https:'].includes(remote.protocol))
          ) {
            callback({ cancel: true });
            return;
          }
          const generation = getBrowserProxySessionState(mount.session).generation;
          const route = await mount.session.resolveProxy(remote.href);
          let addresses: string[] | undefined;
          try {
            addresses = (
              await mount.session.resolveHost(remote.hostname.replace(/^\[|\]$/gu, ''))
            ).endpoints.map(endpoint => endpoint.address);
          } catch {
            /* An explicitly configured proxy may own DNS. */
          }
          const allowed = addresses?.length
            ? addresses.every(address => isIP(address) && !options.isBlockedHost(address))
            : options.hasProxyOnlyRoute(route);
          callback({
            cancel:
              !allowed ||
              !ready(mount) ||
              generation !== getBrowserProxySessionState(mount.session).generation,
          });
        },
      });
      const navigationAllowed = (url: string) => {
        if (url === mount.startupUrl) return false;
        if (['about:blank', 'about:srcdoc'].includes(url)) return ready(mount);
        const remote = options.remoteUrl(mount, url);
        return ready(mount) && Boolean(remote && ['http:', 'https:'].includes(remote.protocol));
      };
      const guardNavigation = (
        event: { isMainFrame: boolean; preventDefault(): void },
        url: string,
      ) => {
        if (navigationAllowed(url)) {
          if (event.isMainFrame) mount.navigationUrl = url;
          return;
        }
        event.preventDefault();
        if (event.isMainFrame && ready(mount)) emit(mount, 'failure');
      };
      guest.setWindowOpenHandler(details => {
        const target = options.remoteUrl(mount, details.url);
        if (
          ready(mount) &&
          !details.postBody &&
          target &&
          ['http:', 'https:'].includes(target.protocol)
        ) {
          mount.owner.send(WebpageEmbedIpc.Event, {
            mountId: mount.mountId,
            type: WEBPAGE_EMBED_OPEN_LINK_EVENT,
            url: target.href,
          });
        }
        // The existing sidebar owns new tabs; never create a page-owned window
        // or replay a submitted POST as a GET.
        return { action: 'deny' };
      });
      guest.on('will-frame-navigate', event => guardNavigation(event, event.url));
      guest.on('will-redirect', (event, url) => guardNavigation(event, url));
      guest.on('did-start-navigation', (_event, url, _inPlace, main) => {
        if (main) mount.navigationUrl = url;
      });
      guest.on('did-fail-load', (_event, code, _description, url, main) => {
        if (main && code !== -3 && url === mount.navigationUrl && ready(mount))
          emit(mount, 'failure');
      });
      guest.on('did-finish-load', () => {
        if (mount.started) emit(mount, 'initialized');
      });
      guest.on('login', (event, _details, info, callback) => {
        event.preventDefault();
        const credentials = options.getCredentials();
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
      const state = getBrowserProxySessionState(mount.session);
      emit(mount, `proxy-${state.status}`);
      // Wait for the inert startup document to commit; do not race its pending load.
      guest.once('dom-ready', () => {
        mount.startupReady = true;
        start(mount);
      });
      return true;
    },
    async retry(owner: Electron.WebContents, mountId: string): Promise<void> {
      const mount = mounts.get(mountId);
      if (!mount || mount.owner !== owner || !current(mount))
        throw new Error('Browser webpage is unavailable.');
      await registerBrowserProxySession(mount.session);
      if (!ready(mount)) throw new Error('Browser proxy is unavailable.');
      start(mount);
    },
    release(owner: Electron.WebContents, mountId: string): void {
      const mount = mounts.get(mountId);
      if (mount?.owner === owner) releaseMount(mount);
    },
    dispose(): void {
      if (listening) app.removeListener('web-contents-created', created);
      for (const stop of [...observing.values()]) stop();
      for (const mount of [...mounts.values()]) releaseMount(mount);
    },
  };
}
