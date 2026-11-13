import { app } from 'electron';

import { isLoopbackBaseUrl } from '../../core/network/systemProxy';
import { browserSessionStorageKey } from '../browserSessionIdentity';
import {
  BROWSER_AUTHENTICATION_LOCAL_ENDPOINT as AUTHENTICATION_URL,
  BROWSER_AUTHENTICATION_LOCAL_PORT,
} from './browserAuthenticationConfig';
const NETWORK_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:']);

type Details = Electron.OnBeforeSendHeadersListenerDetails;
type OwnsRequest = (details: Details) => boolean;

const profileOwners = new WeakMap<Electron.Session, OwnsRequest>();
const persistentProfileOwners = new Map<string, OwnsRequest>();
let relayPort: string | undefined;

function header(headers: Record<string, string>, name: string): string | undefined {
  const matches = Object.entries(headers).filter(([key]) => key.toLowerCase() === name);
  return matches.length === 1 ? matches[0]![1].trim() : undefined;
}

function isSecureRemoteOrigin(origin: string | undefined): origin is string {
  const url = origin ? URL.parse(origin) : null;
  if (!url || url.protocol !== 'https:' || url.origin !== origin || isLoopbackBaseUrl(origin))
    return false;
  const host = url.hostname.replace(/\.$/u, '');
  if (
    host === '0.0.0.0' || host === '[::]' || host === 'loopback' ||
    host === 'localhost.localdomain' || host === 'localhost6' || host === 'localhost6.localdomain6'
  ) return false;
  const mapped = /^\[::ffff:([\da-f]+):([\da-f]+)\]$/u.exec(host);
  return !mapped || (Number.parseInt(mapped[1], 16) >> 8 !== 127 &&
    (Number.parseInt(mapped[1], 16) !== 0 || Number.parseInt(mapped[2], 16) !== 0));
}

function permitsAuthentication(browserSession: Electron.Session, details: Details): boolean {
  if (
    details.resourceType === 'mainFrame' || details.resourceType === 'subFrame' ||
    (details.method !== 'POST' && details.method !== 'OPTIONS')
  ) return false;
  const origin = header(details.requestHeaders, 'origin');
  if (!isSecureRemoteOrigin(origin) || (details.frame && details.frame.origin !== origin))
    return false;
  if (
    details.method === 'OPTIONS' &&
    header(details.requestHeaders, 'access-control-request-method') !== 'POST'
  ) return false;
  const storageKey = browserSessionStorageKey(browserSession);
  const ownsRequest = profileOwners.get(browserSession) ??
    (storageKey ? persistentProfileOwners.get(storageKey) : undefined);
  return ownsRequest?.(details) === true;
}

export function registerBrowserTransportSession(
  browserSession: Electron.Session,
  ownsRequest: OwnsRequest,
): void {
  profileOwners.set(browserSession, ownsRequest);
  const storageKey = browserSessionStorageKey(browserSession);
  if (storageKey) persistentProfileOwners.set(storageKey, ownsRequest);
}

/** Compose into the session owner's header hook without changing request headers. */
export function isBrowserTransportRequestBlocked(
  browserSession: Electron.Session,
  details: Details,
): boolean {
  if (!relayPort) return false;
  const target = URL.parse(details.url);
  if (!target || !NETWORK_SCHEMES.has(target.protocol) ||
      target.hostname.replace(/\.+$/u, '') !== AUTHENTICATION_URL.hostname) return false;
  const targetPort = Number(target.port || (target.protocol === 'https:' || target.protocol === 'wss:' ? 443 : 80));
  if (targetPort === BROWSER_AUTHENTICATION_LOCAL_PORT) {
    try {
      return target.href !== AUTHENTICATION_URL.href || !permitsAuthentication(browserSession, details);
    } catch {
      // Missing or retired Chromium guest ownership cannot authorize this endpoint.
      return true;
    }
  }
  // Deny direct browser requests to the local listener. Alternate DNS names
  // and numeric address variants cannot pass the relay's TLS server-name check.
  return target.port === relayPort;
}

/** Install before app readiness. Roll back only if startup does not set the resolver rule. */
export function installBrowserTransportRequestGuard(port: number): () => void {
  if (!Number.isInteger(port) || port < 1024 || port > 65_535 || port === BROWSER_AUTHENTICATION_LOCAL_PORT) {
    throw new Error('Invalid browser authentication relay port.');
  }
  if (relayPort) throw new Error('Browser authentication request guard is already installed.');
  relayPort = String(port);
  const filter = {
    urls: [...NETWORK_SCHEMES].flatMap(scheme => [
      `${scheme}//${AUTHENTICATION_URL.hostname}:${BROWSER_AUTHENTICATION_LOCAL_PORT}/*`,
      `${scheme}//${AUTHENTICATION_URL.hostname}:${port}/*`,
    ]),
  };
  const install = (browserSession: Electron.Session) => {
    browserSession.webRequest.onBeforeSendHeaders(filter, (details, callback) =>
      callback(isBrowserTransportRequestBlocked(browserSession, details) ? { cancel: true } : {}),
    );
  };
  app.on('session-created', install);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    relayPort = undefined;
    app.removeListener('session-created', install);
  };
}
