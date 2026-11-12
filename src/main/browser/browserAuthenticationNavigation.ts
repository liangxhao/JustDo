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
  'id' | 'url' | 'method' | 'resourceType'
>;
type RedirectRequest = NavigationRequest &
  Pick<Electron.OnBeforeRedirectListenerDetails, 'redirectURL' | 'statusCode'>;
type AuthSettings = Pick<SystemProxySettings, 'browserProxy'>;
type Attempt = {
  guest: Electron.WebContents;
  session: Electron.Session;
  requestId: number;
  entry: string | null;
  controller: AbortController;
  redirectedTo: string | null;
  started: boolean;
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
  private readonly operations = new Map<Electron.Session, Promise<Electron.CallbackResponse>>();
  private stopping = false;

  constructor(private readonly getSettings: () => AuthSettings | undefined) {}

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
    const entry =
      request.method === 'GET' ? normalizeBrowserAuthenticationEntry(request.url) : null;
    const requests = this.active.get(session) ?? new Map<number, Attempt>();
    this.active.set(session, requests);
    const controller = new AbortController();
    const release = () => {
      if (requests.get(request.id) !== candidate) return;
      requests.delete(request.id);
      if (!requests.size) this.active.delete(session);
      if (this.byGuest.get(guest) === candidate) this.byGuest.delete(guest);
      guest.off('destroyed', release);
      controller.abort();
    };
    const candidate: Attempt = {
      guest,
      session,
      requestId: request.id,
      entry,
      controller,
      redirectedTo: null,
      started: false,
      release,
    };
    requests.set(request.id, candidate);
    this.byGuest.set(guest, candidate);
    guest.once('destroyed', release);
  }

  private async complete(
    attempt: Attempt,
    entry: string,
    settings: AuthSettings | undefined,
    ownsGuest: () => boolean,
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
    }).finally(() => this.operations.delete(session));
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
