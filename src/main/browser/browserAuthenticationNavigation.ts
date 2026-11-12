import {
  getBrowserProxyPreferenceSignature,
  type SystemProxySettings,
} from '../core/network/systemProxyPreference';
import {
  BROWSER_AUTHENTICATION_EXECUTABLE,
  getBrowserAuthenticationProviderUrl,
  normalizeBrowserAuthenticationEntry,
} from './authentication/browserAuthenticationConfig';
import {
  authenticateBrowserEntry,
  commitBrowserAuthenticationCookies,
  isBrowserAuthenticationAvailable,
  stopBrowserAuthenticationProcesses,
} from './authentication/browserAuthenticationProcess';
import { browserSessionStorageKey } from './browserSessionIdentity';
import { acquireBackgroundBrowserStorage } from './data/backgroundBrowserStorage';

type NavigationRequest = Pick<
  Electron.OnBeforeRequestListenerDetails,
  'id' | 'url' | 'method' | 'resourceType' | 'frame'
>;
type RedirectRequest = NavigationRequest &
  Pick<Electron.OnBeforeRedirectListenerDetails, 'redirectURL' | 'statusCode'>;
type DocumentResponse = NavigationRequest &
  Pick<Electron.OnResponseStartedListenerDetails, 'statusCode'>;
type AuthSettings = Pick<SystemProxySettings, 'browserProxy'>;
type ClientNavigation = {
  response?: string;
  document?: string;
  intent?: { target: string; entry: string; frame: Electron.WebFrameMain };
  replay?: string;
};
type Attempt = {
  guest: Electron.WebContents;
  session: Electron.Session;
  requestId: number;
  entry: string | null;
  controller: AbortController;
  redirectedTo: string | null;
  started: boolean;
  resuming?: boolean;
  release: () => void;
};

const authenticationTimeoutMs = 30_000;

function providerRequestUrl(value: string): string | null {
  const url = getBrowserAuthenticationProviderUrl(value);
  if (!url) return null;
  url.hash = '';
  return url.href;
}

/** The original navigation owns the helper and the right to commit its result. */
export class BrowserAuthenticationNavigation {
  private readonly active = new Map<Electron.Session, Map<number, Attempt>>();
  private readonly byGuest = new WeakMap<Electron.WebContents, Attempt>();
  private readonly clientNavigations = new WeakMap<Electron.WebContents, ClientNavigation>();
  private readonly operations = new Map<Electron.Session, Promise<Electron.CallbackResponse>>();
  private stopping = false;

  constructor(private readonly getSettings: () => AuthSettings | undefined) {}

  private watchClientNavigation(guest: Electron.WebContents): ClientNavigation {
    const existing = this.clientNavigations.get(guest);
    if (existing) return existing;
    const state: ClientNavigation = {};
    this.clientNavigations.set(guest, state);
    guest.on('did-start-navigation', event => {
      if (!event.isMainFrame || event.isSameDocument) return;
      state.intent = undefined;
      state.response = undefined;
      if (event.initiator || state.replay !== normalizeBrowserAuthenticationEntry(event.url))
        state.replay = undefined;
      const previous = this.byGuest.get(guest);
      if (!state.replay && previous?.started) previous.release();
    });
    guest.on('did-navigate', (_event, url, status) => {
      const committed = normalizeBrowserAuthenticationEntry(url);
      state.document =
        status >= 200 && status < 300 && state.response === committed ? state.response : undefined;
      // A newly attached webview may commit its initial blank document after
      // headers arrive for its first real page. Only consume matching evidence.
      if (state.response === committed) state.response = undefined;
      state.intent = undefined;
    });
    guest.on('will-frame-navigate', event => {
      if (!event.isMainFrame || !state.document) return;
      const frame = guest.mainFrame;
      const target = providerRequestUrl(event.url);
      if (
        target &&
        event.frame === frame &&
        event.initiator === frame &&
        normalizeBrowserAuthenticationEntry(frame.url) === state.document
      ) {
        state.intent = { target, entry: state.document, frame };
      }
    });
    return state;
  }

  observeDocumentResponse(session: Electron.Session, request: DocumentResponse): void {
    if (request.resourceType !== 'mainFrame') return;
    const attempt = this.active.get(session)?.get(request.id);
    if (
      !attempt?.entry ||
      attempt.started ||
      request.method !== 'GET' ||
      request.statusCode < 200 ||
      request.statusCode >= 300
    )
      return;
    const state = this.clientNavigations.get(attempt.guest);
    if (state) state.response = normalizeBrowserAuthenticationEntry(request.url) ?? undefined;
  }

  observeRedirect(session: Electron.Session, request: RedirectRequest): void {
    const attempt = this.active.get(session)?.get(request.id);
    if (!attempt?.entry || attempt.started) return;
    attempt.redirectedTo =
      request.resourceType === 'mainFrame' &&
      request.method === 'GET' &&
      request.statusCode >= 300 &&
      request.statusCode < 400
        ? providerRequestUrl(request.redirectURL)
        : null;
  }

  finish(session: Electron.Session, requestId: number): void {
    this.active.get(session)?.get(requestId)?.release();
  }

  beforeRequest(
    session: Electron.Session,
    guest: Electron.WebContents,
    request: NavigationRequest,
    ownsGuest: () => boolean,
  ): (() => Promise<Electron.CallbackResponse>) | undefined {
    if (this.stopping || !BROWSER_AUTHENTICATION_EXECUTABLE || request.resourceType !== 'mainFrame')
      return;
    const previous = this.byGuest.get(guest);
    if (previous && (previous.session !== session || previous.requestId !== request.id))
      previous.release();
    const attempt = this.active.get(session)?.get(request.id);
    if (!ownsGuest()) {
      if (attempt?.guest === guest) attempt.release();
      return;
    }
    const client = this.watchClientNavigation(guest);
    if (attempt) {
      if (attempt.guest !== guest || attempt.started || !attempt.entry) return;
      const redirectedTo = attempt.redirectedTo;
      attempt.redirectedTo = null;
      if (request.method !== 'GET' || !request.url.startsWith('https:')) {
        attempt.entry = null;
        return;
      }
      if (!redirectedTo || redirectedTo !== providerRequestUrl(request.url)) return;
      attempt.started = true;
      if (!isBrowserAuthenticationAvailable()) return;
      const entry = attempt.entry;
      const settings = this.getSettings();
      return () => this.complete(attempt, entry, settings, ownsGuest);
    }

    // Keep the first native request even when it is ineligible. A POST
    // followed by a 303 to a GET must not become a replayable navigation.
    client.response = undefined;
    const intent = client.intent;
    client.intent = undefined;
    const clientEntry =
      request.method === 'GET' &&
      intent &&
      request.frame === intent.frame &&
      providerRequestUrl(request.url) === intent.target
        ? intent.entry
        : null;
    const requestedEntry =
      request.method === 'GET' ? normalizeBrowserAuthenticationEntry(request.url) : null;
    const isReplay = Boolean(client.replay && client.replay === requestedEntry);
    client.replay = undefined;
    const entry = isReplay ? null : (clientEntry ?? requestedEntry);
    const requests = this.active.get(session) ?? new Map<number, Attempt>();
    this.active.set(session, requests);
    const controller = new AbortController();
    const release = () => {
      if (requests.get(request.id) !== candidate) return;
      requests.delete(request.id);
      if (!requests.size) this.active.delete(session);
      if (this.byGuest.get(guest) === candidate) this.byGuest.delete(guest);
      guest.off('destroyed', release);
      if (!candidate.resuming) controller.abort();
    };
    const candidate: Attempt = {
      guest,
      session,
      requestId: request.id,
      entry,
      controller,
      redirectedTo: null,
      started: Boolean(clientEntry),
      release,
    };
    requests.set(request.id, candidate);
    this.byGuest.set(guest, candidate);
    guest.once('destroyed', release);
    if (clientEntry && isBrowserAuthenticationAvailable()) {
      const settings = this.getSettings();
      return () => this.complete(candidate, clientEntry, settings, ownsGuest, client);
    }
  }

  private async complete(
    attempt: Attempt,
    entry: string,
    settings: AuthSettings | undefined,
    ownsGuest: () => boolean,
    client?: ClientNavigation,
  ): Promise<Electron.CallbackResponse> {
    const { session, controller } = attempt;
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(authenticationTimeoutMs),
    ]);
    const current = () => {
      try {
        return (
          !controller.signal.aborted &&
          ownsGuest() &&
          this.active.get(session)?.get(attempt.requestId) === attempt
        );
      } catch {
        return false;
      }
    };
    const mayCommit = () => {
      if (signal.aborted || !current()) return false;
      try {
        return (
          getBrowserProxyPreferenceSignature(this.getSettings()) ===
          getBrowserProxyPreferenceSignature(settings)
        );
      } catch {
        return false;
      }
    };
    if (!current()) return { cancel: true };
    if (this.operations.has(session) || !mayCommit()) return {};
    const fallback = (): Electron.CallbackResponse => (current() ? {} : { cancel: true });
    let committing = false;
    const operation = this.handoff(session, entry, settings, signal, mayCommit, fallback, () => {
      committing = true;
    })
      .then(async response => {
        if (!client || response.redirectURL !== entry) return response;
        if (!mayCommit()) return fallback();
        // A renderer-initiated request retains its cross-site cookie context on
        // redirect. Supersede it with a browser navigation before releasing it.
        client.replay = entry;
        attempt.resuming = true;
        try {
          const replay = attempt.guest.loadURL(entry);
          const outcome = await Promise.race([
            replay.then(
              () => 'started',
              () => 'failed',
            ),
            new Promise<'started'>(resolve => setImmediate(() => resolve('started'))),
          ]);
          if (outcome === 'failed' && client.replay === entry && current()) {
            client.replay = undefined;
            attempt.resuming = false;
            return fallback();
          }
        } catch {
          client.replay = undefined;
          attempt.resuming = false;
          return fallback();
        }
        return { cancel: true };
      })
      .finally(() => this.operations.delete(session));
    this.operations.set(session, operation);
    let onAbort: (() => void) | undefined;
    const deadline = new Promise<Electron.CallbackResponse>(resolve => {
      // An in-flight cookie write must finish or roll back before the profile
      // can safely continue the original sign-in request.
      onAbort = () => resolve(committing ? { cancel: true } : fallback());
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try {
      return await Promise.race([operation, deadline]);
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  private async handoff(
    session: Electron.Session,
    entry: string,
    settings: AuthSettings | undefined,
    signal: AbortSignal,
    mayCommit: () => boolean,
    fallback: () => Electron.CallbackResponse,
    beginCommit: () => void,
  ): Promise<Electron.CallbackResponse> {
    let releaseStorage: (() => void) | undefined;
    try {
      releaseStorage = acquireBackgroundBrowserStorage(browserSessionStorageKey(session) ?? entry);
      const cookies = await authenticateBrowserEntry(entry, settings?.browserProxy, signal);
      if (!mayCommit()) return fallback();
      beginCommit();
      await commitBrowserAuthenticationCookies(session, entry, cookies, mayCommit);
      if (!mayCommit()) return fallback();
      // Electron retains the request ID across this redirect, so the existing
      // attempt also prevents a second helper on the resumed navigation.
      console.info('[BrowserAuthentication] Handed off the authenticated browser session.');
      return { redirectURL: entry };
    } catch {
      if (!signal.aborted)
        console.warn('[BrowserAuthentication] Automatic authentication could not finish.');
      return fallback();
    } finally {
      releaseStorage?.();
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const requests of this.active.values()) {
      for (const attempt of requests.values()) attempt.release();
    }
    await Promise.allSettled([stopBrowserAuthenticationProcesses(), ...this.operations.values()]);
  }
}
