import { registerBrowserProxySession } from '../core/network/systemProxyPreference';
import {
  isAllowedBrowserPanelNavigationUrl,
  isBlockedBrowserMetadataHost,
} from '../core/window/browserPanelSecurity';
import {
  captureBackgroundBrowserRequest,
  isBackgroundBrowserGuest,
} from './backgroundBrowserGuestRegistry';
import { browserSessionStorageKey, isSameBrowserSession } from './browserSessionIdentity';
import { claimBrowserAgentDownload } from './downloads/browserAgentDownloadCoordinator';

type PermissionCheck = NonNullable<Parameters<Electron.Session['setPermissionCheckHandler']>[0]>;
type PermissionRequest = NonNullable<
  Parameters<Electron.Session['setPermissionRequestHandler']>[0]
>;

export type BrowserSessionUiPolicy = {
  ownsGuest: (guest: Electron.WebContents | undefined, webContentsId?: number) => boolean;
  checkPermission: PermissionCheck;
  requestPermission: PermissionRequest;
  download: (
    event: Electron.Event,
    item: Electron.DownloadItem,
    origin?: Electron.WebContents,
  ) => void;
  headersReceived: (
    details: Electron.OnHeadersReceivedListenerDetails,
    callback: (response: Electron.HeadersReceivedResponse) => void,
  ) => void;
};

export type BrowserSessionGuestPolicy = {
  isCurrent: () => boolean;
  beforeRequest: (
    details: Electron.OnBeforeRequestListenerDetails,
    callback: (response: Electron.CallbackResponse) => void,
  ) => void | Promise<void>;
};

type GuestPolicy = {
  guest: Electron.WebContents;
  session: Electron.Session;
  handlers: BrowserSessionGuestPolicy;
};

type SessionPolicy = {
  ui?: { owner: symbol; handlers: Partial<BrowserSessionUiPolicy> };
  guests: Map<number, GuestPolicy>;
  knownGuestIds: Set<number>;
  knownGuests: WeakSet<Electron.WebContents>;
};

const policies = new WeakMap<Electron.Session, SessionPolicy>();
const persistentPolicies = new Map<string, SessionPolicy>();
const knownPolicyGuests = new WeakSet<Electron.WebContents>();

/** Read-only identity check; released pages never become browser tool targets. */
export const isBrowserSessionPolicyGuest = (guest: Electron.WebContents): boolean =>
  knownPolicyGuests.has(guest);

const isPolicyGuest = (
  state: SessionPolicy,
  guest?: Electron.WebContents | null,
  id = guest?.id,
): boolean =>
  Boolean(
    (guest && state.knownGuests.has(guest)) || (id !== undefined && state.knownGuestIds.has(id)),
  );

/** One app-lifetime owner for each shared browser profile's session handlers. */
export const ensureBrowserSessionPolicy = (browserSession: Electron.Session): void => {
  const storageKey = browserSessionStorageKey(browserSession);
  const existing =
    policies.get(browserSession) ?? (storageKey ? persistentPolicies.get(storageKey) : undefined);
  if (existing) {
    policies.set(browserSession, existing);
    return;
  }
  const state: SessionPolicy = {
    guests: new Map(),
    knownGuestIds: new Set(),
    knownGuests: new WeakSet(),
  };
  policies.set(browserSession, state);
  if (storageKey) persistentPolicies.set(storageKey, state);

  browserSession.webRequest.onBeforeRequest((details, callback) => {
    const guestId = details.webContentsId ?? details.webContents?.id;
    if (isPolicyGuest(state, details.webContents, guestId)) {
      const entry = guestId === undefined ? undefined : state.guests.get(guestId);
      const current = (): boolean => {
        try {
          return Boolean(
            entry &&
            state.guests.get(entry.guest.id) === entry &&
            (details.webContents === undefined || details.webContents === entry.guest) &&
            (details.webContentsId === undefined || details.webContentsId === entry.guest.id) &&
            !entry.guest.isDestroyed() &&
            isSameBrowserSession(entry.session, browserSession) &&
            isSameBrowserSession(entry.guest.session, entry.session) &&
            entry.handlers.isCurrent(),
          );
        } catch {
          return false;
        }
      };
      let settled = false;
      const reply = (response: Electron.CallbackResponse): void => {
        if (settled) return;
        settled = true;
        callback(current() ? response : { cancel: true });
      };
      if (!entry || !current()) {
        reply({ cancel: true });
        return;
      }
      try {
        void Promise.resolve(entry.handlers.beforeRequest(details, reply)).catch(() =>
          reply({ cancel: true }),
        );
      } catch {
        reply({ cancel: true });
      }
      return;
    }
    // A worker without a page identity belongs to the profile. Its requests use
    // the browser baseline, never a tool run or its filesystem authority.
    const isCurrentPage = captureBackgroundBrowserRequest(browserSession, details);
    if (isCurrentPage && !isCurrentPage()) {
      callback({ cancel: true });
      return;
    }
    const mainFrame = details.resourceType === 'mainFrame';
    if (mainFrame && !isAllowedBrowserPanelNavigationUrl(details.url)) {
      callback({ cancel: true });
      return;
    }
    let url: URL;
    try {
      url = new URL(details.url);
    } catch {
      callback(mainFrame ? { cancel: true } : {});
      return;
    }
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
      callback({});
      return;
    }
    if (!url.hostname || isBlockedBrowserMetadataHost(url.hostname)) {
      callback({ cancel: true });
      return;
    }
    // Prepare a profile before its first sidebar connection too. A later
    // background create must not reset proxy connections on an already-live tab.
    void Promise.resolve()
      .then(() => registerBrowserProxySession(browserSession))
      .then(() => browserSession.resolveHost(url.hostname))
      .then(result => {
        callback({
          cancel:
            Boolean(isCurrentPage && !isCurrentPage()) ||
            !result.endpoints.length ||
            result.endpoints.some(endpoint => isBlockedBrowserMetadataHost(endpoint.address)),
        });
      })
      .catch(() => callback({ cancel: true }));
  });

  browserSession.setPermissionCheckHandler((guest, ...args) => {
    if (
      !guest ||
      guest.isDestroyed() ||
      !isSameBrowserSession(guest.session, browserSession) ||
      isBackgroundBrowserGuest(guest) ||
      isPolicyGuest(state, guest)
    )
      return false;
    return state.ui?.handlers.ownsGuest?.(guest, guest.id)
      ? (state.ui.handlers.checkPermission?.(guest, ...args) ?? false)
      : false;
  });
  browserSession.setPermissionRequestHandler((guest, permission, callback, details) => {
    const ui = state.ui;
    if (
      guest.isDestroyed() ||
      !isSameBrowserSession(guest.session, browserSession) ||
      isBackgroundBrowserGuest(guest) ||
      isPolicyGuest(state, guest) ||
      !ui?.handlers.requestPermission ||
      !ui.handlers.ownsGuest?.(guest, guest.id)
    ) {
      callback(false);
      return;
    }
    ui.handlers.requestPermission(
      guest,
      permission,
      granted => {
        callback(
          granted &&
            state.ui === ui &&
            !guest.isDestroyed() &&
            !isBackgroundBrowserGuest(guest) &&
            !isPolicyGuest(state, guest) &&
            ui.handlers.ownsGuest?.(guest, guest.id) === true,
        );
      },
      details,
    );
  });
  browserSession.setDevicePermissionHandler?.(() => false);
  browserSession.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  browserSession.webRequest.onHeadersReceived((details, callback) => {
    const background = captureBackgroundBrowserRequest(browserSession, details);
    if (
      !details.webContentsId ||
      details.webContentsId < 0 ||
      background ||
      isPolicyGuest(state, details.webContents, details.webContentsId) ||
      !state.ui?.handlers.ownsGuest?.(details.webContents, details.webContentsId) ||
      !state.ui?.handlers.headersReceived
    ) {
      callback({});
      return;
    }
    state.ui.handlers.headersReceived(details, callback);
  });
  browserSession.on('will-download', (event, item, origin?: Electron.WebContents) => {
    if (isPolicyGuest(state, origin)) {
      item.cancel();
      return;
    }
    // A source-less worker download must never fall through to a Save dialog.
    if (!origin || isBackgroundBrowserGuest(origin)) {
      const isCurrent = origin
        ? captureBackgroundBrowserRequest(browserSession, {
            webContentsId: origin.id,
            webContents: origin,
          })
        : null;
      if (!origin || !isCurrent?.()) {
        item.cancel();
        return;
      }
      const claim = claimBrowserAgentDownload(browserSession, item, origin);
      if (!claim || claim.cancelled || !claim.savePath || !isCurrent()) {
        item.cancel();
        return;
      }
      item.once('done', (_event, status) => claim.settle(item, status));
      try {
        item.setSavePath(claim.savePath);
      } catch {
        item.cancel();
      }
      return;
    }
    if (
      origin.isDestroyed() ||
      !isSameBrowserSession(origin.session, browserSession) ||
      !state.ui?.handlers.ownsGuest?.(origin, origin.id) ||
      !state.ui.handlers.download
    ) {
      item.cancel();
      return;
    }
    state.ui.handlers.download(event, item, origin);
  });
};

/** Adds one exact page's network policy without granting browser UI capabilities. */
export const registerBrowserSessionGuestPolicy = (
  guest: Electron.WebContents,
  handlers: BrowserSessionGuestPolicy,
): (() => void) => {
  if (guest.isDestroyed() || isBackgroundBrowserGuest(guest))
    throw new Error('The browser policy guest is unavailable.');
  const browserSession = guest.session;
  ensureBrowserSessionPolicy(browserSession);
  const state = policies.get(browserSession)!;
  if (isPolicyGuest(state, guest))
    throw new Error('The browser policy guest is already registered or retired.');
  const entry: GuestPolicy = { guest, session: browserSession, handlers: { ...handlers } };
  state.guests.set(guest.id, entry);
  // WebContents IDs are not recycled in this process. Retain only their identity
  // after release so delayed requests cannot acquire the profile baseline.
  state.knownGuestIds.add(guest.id);
  state.knownGuests.add(guest);
  knownPolicyGuests.add(guest);
  const release = (): void => {
    if (state.guests.get(guest.id) === entry) state.guests.delete(guest.id);
    guest.off('destroyed', release);
  };
  guest.once('destroyed', release);
  return release;
};

/** UI lifecycle changes delegates, never replaces the shared session handlers. */
export const configureBrowserSessionUi = (
  browserSession: Electron.Session,
  owner: symbol,
  handlers: Partial<BrowserSessionUiPolicy>,
): void => {
  ensureBrowserSessionPolicy(browserSession);
  const state = policies.get(browserSession)!;
  state.ui = {
    owner,
    handlers: { ...(state.ui?.owner === owner ? state.ui.handlers : {}), ...handlers },
  };
};

export const releaseBrowserSessionUi = (browserSession: Electron.Session, owner: symbol): void => {
  const state = policies.get(browserSession);
  if (state?.ui?.owner === owner) state.ui = undefined;
};
