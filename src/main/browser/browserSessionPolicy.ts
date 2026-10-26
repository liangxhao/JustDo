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

type SessionPolicy = {
  ui?: { owner: symbol; handlers: Partial<BrowserSessionUiPolicy> };
};

const policies = new WeakMap<Electron.Session, SessionPolicy>();
const persistentPolicies = new Map<string, SessionPolicy>();

/** One app-lifetime owner for each shared browser profile's session handlers. */
export const ensureBrowserSessionPolicy = (browserSession: Electron.Session): void => {
  const storageKey = browserSessionStorageKey(browserSession);
  const existing =
    policies.get(browserSession) ?? (storageKey ? persistentPolicies.get(storageKey) : undefined);
  if (existing) {
    policies.set(browserSession, existing);
    return;
  }
  const state: SessionPolicy = {};
  policies.set(browserSession, state);
  if (storageKey) persistentPolicies.set(storageKey, state);

  browserSession.webRequest.onBeforeRequest((details, callback) => {
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
      isBackgroundBrowserGuest(guest)
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
      !state.ui?.handlers.ownsGuest?.(details.webContents, details.webContentsId) ||
      !state.ui?.handlers.headersReceived
    ) {
      callback({});
      return;
    }
    state.ui.handlers.headersReceived(details, callback);
  });
  browserSession.on('will-download', (event, item, origin?: Electron.WebContents) => {
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
