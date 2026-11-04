import { createConnection, isIP } from 'node:net';

import type { WebContents } from 'electron';

import {
  BrowserProxyStatus,
  getBrowserProxyMode,
  getBrowserProxySessionState,
  observeBrowserProxySession,
} from '../core/network/systemProxyPreference';
import { isBlockedBrowserMetadataHost } from '../core/window/browserPanelSecurity';
import { browserSessionStorageKey } from './browserSessionIdentity';

const LOG_PREFIX = '[BrowserNetworkDiagnostics] ';
const FAILURE_LOG_INTERVAL_MS = 10_000;
const SESSION_CHECK_INTERVAL_MS = 30_000;
const CHECK_TIMEOUT_MS = 5_000;
const TCP_TIMEOUT_MS = 1_500;
const MAX_ACTIVE_CHECKS = 2;
const MAX_TRACKED_SESSIONS = 64;
const MAX_ORIGIN_LENGTH = 512;
const MAX_ROUTES = 4;
const MAX_PROXY_PROBES = 2;
const MAX_PROXY_ADDRESSES = 2;
const MAX_ROUTE_LENGTH = 4_096;
const PROXY_CONNECTION_FAILED = -130;
const ABORTED = -3;

const DiagnosticEvent = {
  LOAD_FAILED: 'load-failed',
  PROXY_CHECK: 'proxy-check',
} as const;

const CheckStatus = {
  COMPLETE: 'complete',
  FAILED: 'failed',
  TIMEOUT: 'timeout',
  CANCELLED: 'cancelled',
  BLOCKED: 'blocked',
  CONNECTED: 'connected',
} as const;

const CheckAdmission = {
  STARTED: 'started',
  BUSY: 'busy',
  COOLDOWN: 'cooldown',
} as const;

const CheckStage = {
  PROXY_RESOLUTION: 'proxy-resolution',
  PROXY_DNS: 'proxy-dns',
  PROXY_TCP: 'proxy-tcp',
} as const;

const PROXY_SCHEMES = {
  PROXY: 'http',
  HTTP: 'http',
  HTTPS: 'https',
  SOCKS: 'socks4',
  SOCKS4: 'socks4',
  SOCKS5: 'socks5',
} as const;

const SOCKET_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH',
  'EACCES', 'EPERM', 'ENOTFOUND', 'EAI_AGAIN', 'EADDRNOTAVAIL', 'ENETDOWN',
]);

type ProxyEndpoint = { scheme: string; host: string; port: number };
type ProxyRoute = ProxyEndpoint | { scheme: 'direct' };
type ParsedRoutes = { resolvedRoutes: ProxyRoute[]; unrecognizedRoutes: number; routesTruncated: boolean };
type AddressCheck = { address: string; status: string; error?: string };
type ProxyProbe = ProxyEndpoint & { status: string; error?: string; addresses?: AddressCheck[] };
type SessionChecks = { busy: boolean; lastStartedAt: number };

const registeredGuests = new WeakSet<WebContents>();
const sessionChecks = new WeakMap<Electron.Session, SessionChecks>();
const persistentSessionChecks = new Map<string, SessionChecks>();
let activeChecks = 0;
let nextDiagnosticId = 0;

const getSessionChecks = (browserSession: Electron.Session, now: number): SessionChecks | undefined => {
  const storageKey = browserSessionStorageKey(browserSession);
  if (storageKey) {
    for (const [key, checks] of persistentSessionChecks) {
      if (!checks.busy && now - checks.lastStartedAt >= SESSION_CHECK_INTERVAL_MS) {
        persistentSessionChecks.delete(key);
      }
    }
    const existing = persistentSessionChecks.get(storageKey);
    if (existing) return existing;
    if (persistentSessionChecks.size >= MAX_TRACKED_SESSIONS) return undefined;
    const checks = { busy: false, lastStartedAt: -Infinity };
    persistentSessionChecks.set(storageKey, checks);
    return checks;
  }
  let checks = sessionChecks.get(browserSession);
  if (!checks) {
    checks = { busy: false, lastStartedAt: -Infinity };
    sessionChecks.set(browserSession, checks);
  }
  return checks;
};

/** Canonicalize expanded and IPv4-mapped IPv6 before checking metadata exclusions. */
const normalizeProxyHost = (host: string): string => {
  const normalized = host.toLowerCase().replace(/\.$/u, '');
  if (isIP(normalized) !== 6) return normalized;
  const canonical = new URL(`http://[${normalized}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/u.exec(canonical);
  if (!mapped) return canonical;
  const high = Number.parseInt(mapped[1], 16);
  const low = Number.parseInt(mapped[2], 16);
  return [high >>> 8, high & 255, low >>> 8, low & 255].join('.');
};

/** One string argument keeps console, persisted Main logs and grep exports single-line. */
const writeDiagnostic = (record: Record<string, unknown>): void => {
  console.warn(LOG_PREFIX + JSON.stringify(record));
};

const networkErrorName = (value: string): string =>
  /^(?:net::)?ERR_[A-Z0-9_]{1,64}$/u.test(value)
    ? value.replace(/^net::/u, '')
    : 'UNKNOWN';

const diagnosticErrorCode = (error: unknown): string => {
  if (!error || typeof error !== 'object') return 'UNKNOWN';
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code === 'string' && SOCKET_ERROR_CODES.has(code)) return code;
  return typeof message === 'string' ? networkErrorName(message) : 'UNKNOWN';
};

/** Never expose the raw PAC response: it can contain credentials or arbitrary text. */
const parseProxyRoutes = (value: string): ParsedRoutes => {
  const parts = value.slice(0, MAX_ROUTE_LENGTH).split(';', MAX_ROUTES + 1);
  const resolvedRoutes: ProxyRoute[] = [];
  let unrecognizedRoutes = 0;
  for (const part of parts.slice(0, MAX_ROUTES)) {
    const text = part.trim();
    if (text === 'DIRECT') {
      resolvedRoutes.push({ scheme: 'direct' });
      continue;
    }
    const match = /^(PROXY|HTTP|HTTPS|SOCKS|SOCKS4|SOCKS5) ([A-Za-z0-9._-]+|\[[0-9a-fA-F:.]+\]):([0-9]{1,5})$/u.exec(text);
    if (match) {
      const host = normalizeProxyHost(match[2].replace(/^\[|\]$/gu, ''));
      const port = Number(match[3]);
      if (host.length <= 253 && port > 0 && port <= 65_535 && (!host.includes(':') || isIP(host))) {
        resolvedRoutes.push({ scheme: PROXY_SCHEMES[match[1] as keyof typeof PROXY_SCHEMES], host, port });
        continue;
      }
    }
    unrecognizedRoutes += 1;
  }
  return {
    resolvedRoutes,
    unrecognizedRoutes,
    routesTruncated: value.length > MAX_ROUTE_LENGTH || parts.length > MAX_ROUTES,
  };
};

const withAbort = <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
    void operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });

/** Connect only to an already-resolved proxy IP. Send no HTTP, TLS or authentication bytes. */
const checkProxyAddress = (
  address: string,
  port: number,
  signal: AbortSignal,
): Promise<AddressCheck> => new Promise(resolve => {
  if (signal.aborted) {
    resolve({ address, status: CheckStatus.CANCELLED });
    return;
  }
  let socket: ReturnType<typeof createConnection>;
  try {
    socket = createConnection({ host: address, port });
  } catch (error) {
    resolve({ address, status: CheckStatus.FAILED, error: diagnosticErrorCode(error) });
    return;
  }
  let settled = false;
  const finish = (status: string, error?: string) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    socket.destroy();
    resolve({ address, status, ...(error ? { error } : {}) });
  };
  const cancel = () => finish(CheckStatus.CANCELLED);
  const timer = setTimeout(() => finish(CheckStatus.TIMEOUT), TCP_TIMEOUT_MS);
  timer.unref();
  signal.addEventListener('abort', cancel, { once: true });
  socket.once('connect', () => finish(CheckStatus.CONNECTED));
  // Retain an error listener through destroy, including cancellation during connect.
  socket.on('error', error => finish(CheckStatus.FAILED, diagnosticErrorCode(error)));
});

/** Passive failure evidence plus bounded, best-effort diagnostics for ordinary sidebar guests. */
export const registerBrowserNetworkDiagnostics = (guest: WebContents): void => {
  if (registeredGuests.has(guest) || guest.isDestroyed()) return;
  registeredGuests.add(guest);
  let lastFailureAt = -Infinity;
  let currentCheck: AbortController | undefined;
  const cancelCheck = () => currentCheck?.abort(CheckStatus.CANCELLED);
  const onNavigation = (_event: Electron.Event, _url: string, inPlace: boolean, mainFrame: boolean) => {
    if (mainFrame && !inPlace) cancelCheck();
  };
  const onFailure = (
    _event: Electron.Event,
    errorCode: number,
    description: string,
    failedUrl: string,
    mainFrame: boolean,
  ) => {
    if (!mainFrame || errorCode === ABORTED || guest.isDestroyed()) return;
    let url: URL;
    try {
      url = new URL(failedUrl);
    } catch {
      return;
    }
    if (!['http:', 'https:'].includes(url.protocol)) return;
    const now = Date.now();
    if (now - lastFailureAt < FAILURE_LOG_INTERVAL_MS) return;
    lastFailureAt = now;
    const browserSession = guest.session;
    const proxyState = getBrowserProxySessionState(browserSession);
    const checks = getSessionChecks(browserSession, now);
    const admission = !checks || checks.busy || activeChecks >= MAX_ACTIVE_CHECKS
      ? CheckAdmission.BUSY
      : now - checks.lastStartedAt < SESSION_CHECK_INTERVAL_MS
        ? CheckAdmission.COOLDOWN
        : CheckAdmission.STARTED;
    const context = {
      diagnosticId: ++nextDiagnosticId,
      guestId: guest.id,
      origin: url.origin.slice(0, MAX_ORIGIN_LENGTH),
      originTruncated: url.origin.length > MAX_ORIGIN_LENGTH,
      errorCode,
      error: networkErrorName(description),
      proxyMode: getBrowserProxyMode(),
      proxyGeneration: proxyState.generation,
      proxyStatus: proxyState.status,
    };
    writeDiagnostic({ event: DiagnosticEvent.LOAD_FAILED, ...context, check: admission });
    if (admission !== CheckAdmission.STARTED || !checks) return;

    const controller = new AbortController();
    currentCheck = controller;
    const { signal } = controller;
    const nativeOperations = new Set<Promise<unknown>>();
    const nativeCall = <T>(operation: Promise<T>): Promise<T> => {
      nativeOperations.add(operation);
      void operation.then(
        () => nativeOperations.delete(operation),
        () => nativeOperations.delete(operation),
      );
      return withAbort(operation, signal);
    };
    checks.busy = true;
    checks.lastStartedAt = now;
    activeChecks += 1;
    const timeout = setTimeout(() => controller.abort(CheckStatus.TIMEOUT), CHECK_TIMEOUT_MS);
    timeout.unref();
    const stopObserving = observeBrowserProxySession(browserSession, state => {
      if (state.generation !== proxyState.generation) controller.abort(CheckStatus.CANCELLED);
    });
    let routes: ParsedRoutes | undefined;
    let probes: ProxyProbe[] = [];
    let stage: (typeof CheckStage)[keyof typeof CheckStage] = CheckStage.PROXY_RESOLUTION;
    const collect = async () => {
      if (signal.aborted) return;
      // Keep the complete URL for PAC evaluation, but only log its origin.
      routes = parseProxyRoutes(await nativeCall(browserSession.resolveProxy(failedUrl)));
      if (errorCode !== PROXY_CONNECTION_FAILED || proxyState.status !== BrowserProxyStatus.READY) return;
      const endpoints = routes.resolvedRoutes
        .filter((route): route is ProxyEndpoint => 'host' in route)
        .slice(0, MAX_PROXY_PROBES);
      for (const endpoint of endpoints) {
        if (signal.aborted) return;
        if (isBlockedBrowserMetadataHost(endpoint.host)) {
          probes = [...probes, { ...endpoint, status: CheckStatus.BLOCKED }];
          continue;
        }
        let addresses: string[];
        try {
          stage = CheckStage.PROXY_DNS;
          addresses = isIP(endpoint.host)
            ? [endpoint.host]
            : (await nativeCall(browserSession.resolveHost(endpoint.host))).endpoints.map(item => normalizeProxyHost(item.address));
        } catch (error) {
          if (signal.aborted) return;
          probes = [...probes, { ...endpoint, status: CheckStatus.FAILED, error: diagnosticErrorCode(error) }];
          continue;
        }
        if (addresses.some(address => !isIP(address) || isBlockedBrowserMetadataHost(address))) {
          probes = [...probes, { ...endpoint, status: CheckStatus.BLOCKED }];
          continue;
        }
        if (!addresses.length) {
          probes = [...probes, { ...endpoint, status: CheckStatus.FAILED, error: 'NO_ADDRESSES' }];
          continue;
        }
        let results: AddressCheck[] = [];
        stage = CheckStage.PROXY_TCP;
        for (const address of [...new Set(addresses)].slice(0, MAX_PROXY_ADDRESSES)) {
          if (signal.aborted) return;
          results = [...results, await checkProxyAddress(address, endpoint.port, signal)];
        }
        probes = [...probes, { ...endpoint, status: CheckStatus.COMPLETE, addresses: results }];
      }
    };
    void collect().then(
      () => {
        if (!signal.aborted) writeDiagnostic({
          event: DiagnosticEvent.PROXY_CHECK, ...context, status: CheckStatus.COMPLETE,
          routeObservation: 'after-failure', ...routes, probeTransport: 'main-tcp', probes,
        });
      },
      error => {
        if (!signal.aborted) writeDiagnostic({
          event: DiagnosticEvent.PROXY_CHECK, ...context, status: CheckStatus.FAILED,
          stage, checkError: diagnosticErrorCode(error),
        });
      },
    ).finally(() => {
      if (signal.reason === CheckStatus.TIMEOUT) writeDiagnostic({
        event: DiagnosticEvent.PROXY_CHECK, ...context, status: CheckStatus.TIMEOUT,
        stage, routeObservation: 'after-failure', ...routes, probeTransport: 'main-tcp', probes,
      });
      clearTimeout(timeout);
      stopObserving();
      if (currentCheck === controller) currentCheck = undefined;
      // Native resolution cannot be cancelled. Keep its slot until it really settles
      // so repeated timeouts cannot accumulate unbounded native operations.
      void Promise.allSettled([...nativeOperations]).then(() => {
        checks.busy = false;
        activeChecks -= 1;
      });
    });
  };
  guest.on('did-fail-load', onFailure);
  guest.on('did-start-navigation', onNavigation);
  guest.once('destroyed', () => {
    cancelCheck();
    guest.removeListener('did-fail-load', onFailure);
    guest.removeListener('did-start-navigation', onNavigation);
  });
};
