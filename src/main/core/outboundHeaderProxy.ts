import crypto from 'crypto';
import { app } from 'electron';
import fs from 'fs';
import http from 'http';
import { Proxy } from 'http-mitm-proxy';
import https from 'https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import net from 'net';
import path from 'path';
import type { Duplex } from 'stream';

import { buildGatewayNetworkEnvironment } from './gatewayNetworkEnvironment';
import {
  getOutboundHeaderPolicyConfig,
  getOutboundHeaderUserInfo,
  resolveOutboundHeaderUserInfoPath,
  updateOutboundHeaderUserInfoCache,
} from './outboundHeaderPolicyConfig';
import { getFixedProxyUrl, isSystemProxyEnabled, resolveSystemProxyUrl } from './systemProxy';
import { buildOutboundHeaderTrustedCaBundle } from './trustedCertificates';

const LOOPBACK_HOST = '127.0.0.1';
const CA_DIRECTORY_NAME = 'outbound-header-proxy';
const CA_CERTIFICATE_PATH = path.join('certs', 'ca.pem');
const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HTTP_HEADER_VALUE_PATTERN = /^[\u0020-\u007e\u0080-\u00ff]*$/;
const LOCAL_PROXY_USERNAME = 'openclaw';

export type OutboundHeaderProxyConfig = {
  enabled: boolean;
  baseUrlWhitelist: readonly string[];
  headerNames: readonly string[];
};

export type OutboundHeaderProxyInfo = {
  proxyUrl: string;
  caCertificatePath: string;
  caBundlePath: string;
};

const normalizeBaseUrl = (value: string): string | null => {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
};

export const resolveOutboundHeaderProxyConfig = (
  policy: OutboundHeaderProxyConfig = getOutboundHeaderPolicyConfig(),
): OutboundHeaderProxyConfig => ({
  enabled: policy.enabled,
  headerNames: policy.headerNames
    .map(name => name.trim())
    .filter(name => HTTP_HEADER_NAME_PATTERN.test(name)),
  baseUrlWhitelist: policy.baseUrlWhitelist
    .map(normalizeBaseUrl)
    .filter((value): value is string => value !== null),
});

export const shouldInjectOutboundHeaders = (
  requestUrl: string,
  baseUrlWhitelist: readonly string[],
): boolean => {
  if (baseUrlWhitelist.length === 0) {
    return false;
  }

  try {
    const request = new URL(requestUrl);
    return baseUrlWhitelist.some(baseUrl => {
      const base = new URL(baseUrl);
      return (
        request.protocol === base.protocol &&
        request.hostname === base.hostname &&
        request.port === base.port &&
        request.pathname.startsWith(base.pathname)
      );
    });
  } catch {
    return false;
  }
};

export const shouldApplyOutboundHeadersForRequest = (
  config: OutboundHeaderProxyConfig,
  requestUrl: string,
): boolean => config.enabled && shouldInjectOutboundHeaders(requestUrl, config.baseUrlWhitelist);

export const isOutboundHeaderProxyActive = (config: OutboundHeaderProxyConfig): boolean =>
  config.enabled && config.baseUrlWhitelist.length > 0;

export const applyOutboundHeaders = (
  headers: Record<string, string | string[] | undefined>,
  headerValues: Readonly<Record<string, string>>,
): number => {
  let injectedHeaderCount = 0;
  for (const [headerName, value] of Object.entries(headerValues)) {
    if (!HTTP_HEADER_VALUE_PATTERN.test(value)) {
      console.warn(`[OutboundHeaderProxy] Skipped unsafe outbound header value: ${headerName}`);
      continue;
    }
    const existingKey =
      Object.keys(headers).find(key => key.toLowerCase() === headerName.toLowerCase()) ||
      headerName;
    headers[existingKey] = value;
    injectedHeaderCount += 1;
  }
  return injectedHeaderCount;
};

export const isIgnorableProxyClientError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const code = 'code' in error ? String(error.code).toUpperCase() : '';
  if (['ECONNRESET', 'ECONNABORTED', 'EPIPE'].includes(code)) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return /\b(?:socket hang up|connection reset|connection aborted|broken pipe)\b/i.test(message);
};

const MITM_DISCONNECT_ERROR_KINDS = new Set([
  'SERVER_TO_PROXY_RESPONSE_ERROR',
  'PROXY_TO_SERVER_REQUEST_ERROR',
  'CLIENT_TO_PROXY_REQUEST_ERROR',
  'CLIENT_TO_PROXY_SOCKET',
  'HTTPS_CLIENT_ERROR',
  'PROXY_TO_CLIENT_RESPONSE_ERROR',
]);

type MitmErrorHandler = (context: unknown, error: Error, kind: string) => void;
type MitmProxyWithInternalErrorHook = Proxy & {
  _onError?: (kind: string, context: unknown, error: Error) => void;
  _onSocketError?: (socketDescription: string, error: NodeJS.ErrnoException) => void;
  onErrorHandlers?: MitmErrorHandler[];
};

type MitmContextWithErrorHandlers = {
  onErrorHandlers?: MitmErrorHandler[];
};

type ProxyRequestContext = {
  isSSL?: boolean;
  connectRequest?: http.IncomingMessage;
  clientToProxyRequest: {
    headers: Record<string, string | string[] | undefined>;
  };
  proxyToServerRequestOptions?: {
    host?: string;
    port?: string | number;
    path?: string;
    headers?: Record<string, string | string[] | undefined>;
    agent?: unknown;
  };
};

const DEFAULT_HTTP_PORT = 80;
const DEFAULT_HTTPS_PORT = 443;
const UPSTREAM_CONNECT_TIMEOUT_MS = 30_000;

export const shouldSuppressMitmProxyErrorLog = (
  errorKind: string | undefined,
  error: unknown,
): boolean =>
  typeof errorKind === 'string' &&
  MITM_DISCONNECT_ERROR_KINDS.has(errorKind) &&
  isIgnorableProxyClientError(error);

export const suppressNoisyMitmDisconnectLogs = (proxy: Proxy): void => {
  const mitmProxy = proxy as MitmProxyWithInternalErrorHook;
  const originalOnError = mitmProxy._onError?.bind(proxy);
  const originalOnSocketError = mitmProxy._onSocketError?.bind(proxy);

  if (originalOnSocketError) {
    mitmProxy._onSocketError = (socketDescription, error) => {
      if (isIgnorableProxyClientError(error)) {
        return;
      }
      originalOnSocketError(socketDescription, error);
    };
  }

  if (!originalOnError) {
    return;
  }

  mitmProxy._onError = (kind, context, error) => {
    if (!shouldSuppressMitmProxyErrorLog(kind, error)) {
      originalOnError(kind, context, error);
      return;
    }

    for (const handler of mitmProxy.onErrorHandlers || []) {
      handler(context, error, kind);
    }
    for (const handler of (context as MitmContextWithErrorHandlers | null)?.onErrorHandlers || []) {
      handler(context, error, kind);
    }
  };
};

const isMitmSocketResetDebugMessage = (args: readonly unknown[]): boolean =>
  typeof args[0] === 'string' && /^Got ECONNRESET on [A-Z_]+, ignoring\.$/.test(args[0]);

const isMitmSocketErrorHeader = (args: readonly unknown[]): boolean =>
  args.length === 1 && args[0] === 'Socket error:';

let mitmConsoleFilterRefCount = 0;
let originalConsoleDebug: typeof console.debug | null = null;
let originalConsoleError: typeof console.error | null = null;
let pendingMitmSocketErrorHeader: Parameters<typeof console.error> | null = null;

const flushPendingMitmSocketErrorHeader = (): void => {
  if (!pendingMitmSocketErrorHeader || !originalConsoleError) {
    return;
  }
  originalConsoleError(...pendingMitmSocketErrorHeader);
  pendingMitmSocketErrorHeader = null;
};

export const installNoisyMitmConsoleFilter = (): void => {
  mitmConsoleFilterRefCount += 1;
  if (mitmConsoleFilterRefCount > 1) {
    return;
  }

  originalConsoleDebug = console.debug.bind(console);
  originalConsoleError = console.error.bind(console);

  console.debug = (...args: Parameters<typeof console.debug>) => {
    if (isMitmSocketResetDebugMessage(args)) {
      return;
    }
    originalConsoleDebug?.(...args);
  };

  console.error = (...args: Parameters<typeof console.error>) => {
    if (pendingMitmSocketErrorHeader) {
      if (args.length === 1 && isIgnorableProxyClientError(args[0])) {
        pendingMitmSocketErrorHeader = null;
        return;
      }
      flushPendingMitmSocketErrorHeader();
    }

    if (isMitmSocketErrorHeader(args)) {
      pendingMitmSocketErrorHeader = args;
      return;
    }

    originalConsoleError?.(...args);
  };
};

export const uninstallNoisyMitmConsoleFilter = (): void => {
  if (mitmConsoleFilterRefCount === 0) {
    return;
  }

  mitmConsoleFilterRefCount -= 1;
  if (mitmConsoleFilterRefCount > 0) {
    return;
  }

  flushPendingMitmSocketErrorHeader();
  if (originalConsoleDebug) {
    console.debug = originalConsoleDebug;
  }
  if (originalConsoleError) {
    console.error = originalConsoleError;
  }
  originalConsoleDebug = null;
  originalConsoleError = null;
};

const getDefaultPort = (protocol: string): number =>
  protocol === 'https:' ? DEFAULT_HTTPS_PORT : DEFAULT_HTTP_PORT;

const toOriginFormPath = (requestUrl: string): string => {
  try {
    const url = new URL(requestUrl);
    return `${url.pathname}${url.search}`;
  } catch {
    return requestUrl;
  }
};

const resolveConfiguredUpstreamProxy = async (requestUrl: string): Promise<string | null> => {
  const fixedProxyUrl = getFixedProxyUrl();
  if (fixedProxyUrl) {
    return fixedProxyUrl;
  }

  if (!isSystemProxyEnabled()) {
    return null;
  }

  return resolveSystemProxyUrl(requestUrl);
};

const setProxyAuthorizationHeader = (
  proxyUrl: URL,
  headers: Record<string, string | string[] | undefined>,
): void => {
  if (!proxyUrl.username && !proxyUrl.password) {
    return;
  }

  const auth = `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`;
  headers['Proxy-Authorization'] = `Basic ${Buffer.from(auth).toString('base64')}`;
};

const applyUpstreamProxyForRequest = async (
  context: ProxyRequestContext,
  requestUrl: string,
  resolveUpstreamProxy: (targetUrl: string) => Promise<string | null>,
): Promise<void> => {
  const upstreamProxyUrl = await resolveUpstreamProxy(requestUrl);
  if (!upstreamProxyUrl || !context.proxyToServerRequestOptions) {
    return;
  }

  const proxyUrl = new URL(upstreamProxyUrl);
  const proxyProtocol = proxyUrl.protocol;

  if (context.isSSL) {
    if (proxyProtocol !== 'http:' && proxyProtocol !== 'https:') {
      throw new Error(`Unsupported upstream proxy for HTTPS: ${proxyProtocol}`);
    }
    context.proxyToServerRequestOptions.agent = new HttpsProxyAgent(upstreamProxyUrl);
    return;
  }

  if (proxyProtocol === 'https:') {
    context.proxyToServerRequestOptions.agent = new HttpsProxyAgent(upstreamProxyUrl);
    context.proxyToServerRequestOptions.path = toOriginFormPath(requestUrl);
    return;
  }

  if (proxyProtocol !== 'http:') {
    throw new Error(`Unsupported upstream proxy for HTTP: ${proxyProtocol}`);
  }

  const headers = context.proxyToServerRequestOptions.headers ?? {};
  context.proxyToServerRequestOptions.headers = headers;
  context.proxyToServerRequestOptions.host = proxyUrl.hostname;
  context.proxyToServerRequestOptions.port = proxyUrl.port || getDefaultPort(proxyProtocol);
  context.proxyToServerRequestOptions.path = requestUrl;
  setProxyAuthorizationHeader(proxyUrl, headers);
  headers['Proxy-Connection'] = 'close';
};

type ConnectAuthority = { hostname: string; port: number };

const parseConnectAuthority = (authority: string | undefined): ConnectAuthority | null => {
  if (!authority) return null;
  try {
    const parsed = new URL(`https://${authority}`);
    const port = parsed.port ? Number(parsed.port) : DEFAULT_HTTPS_PORT;
    if (!parsed.hostname || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { hostname: parsed.hostname, port };
  } catch {
    return null;
  }
};

const isLoopbackHostname = (hostname: string): boolean => {
  const normalized = hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  const mappedIpv4 = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  const isMappedIpv4Loopback = !!mappedIpv4 && Number.parseInt(mappedIpv4[1], 16) >> 8 === 127;
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '::1' ||
    normalized === '0.0.0.0' ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized) ||
    /^::ffff:127(?:\.\d{1,3}){3}$/.test(normalized) ||
    isMappedIpv4Loopback
  );
};

const excludeLoopbackWhitelistEntries = (
  config: OutboundHeaderProxyConfig,
): OutboundHeaderProxyConfig => {
  const baseUrlWhitelist = config.baseUrlWhitelist.filter(value => {
    try {
      return !isLoopbackHostname(new URL(value).hostname);
    } catch {
      return true;
    }
  });
  if (baseUrlWhitelist.length !== config.baseUrlWhitelist.length) {
    console.warn(
      `[OutboundHeaderProxy] Ignored ${config.baseUrlWhitelist.length - baseUrlWhitelist.length} loopback whitelist entry or entries; loopback remains direct.`,
    );
  }
  return { ...config, baseUrlWhitelist };
};

const findWhitelistBypassConflict = (
  config: OutboundHeaderProxyConfig,
  env: NodeJS.ProcessEnv,
): string | null => {
  const entries = [env.NO_PROXY, env.no_proxy]
    .flatMap(value => (value || '').split(','))
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
  for (const baseUrl of config.baseUrlWhitelist) {
    const url = new URL(baseUrl);
    const hostname = url.hostname.toLowerCase();
    const port = url.port || String(getDefaultPort(url.protocol));
    const conflict = entries.find(entry => {
      if (entry === '*') return true;
      const lastColon = entry.lastIndexOf(':');
      const hasPort = lastColon > 0 && /^\d+$/.test(entry.slice(lastColon + 1));
      const entryHost = (hasPort ? entry.slice(0, lastColon) : entry)
        .replace(/^\*\./, '')
        .replace(/^\./, '');
      if (hasPort && entry.slice(lastColon + 1) !== port) return false;
      return hostname === entryHost || hostname.endsWith(`.${entryHost}`);
    });
    if (conflict) return conflict;
  }
  return null;
};

const isConnectInterceptionCandidate = (
  authority: ConnectAuthority,
  protocol: 'http:' | 'https:',
  config: OutboundHeaderProxyConfig,
): boolean =>
  config.baseUrlWhitelist.some(value => {
    const url = new URL(value);
    return (
      url.protocol === protocol &&
      url.hostname.toLowerCase() === authority.hostname.toLowerCase() &&
      Number(url.port || getDefaultPort(url.protocol)) === authority.port
    );
  });

const detectConnectProtocol = (data: Buffer): 'http:' | 'https:' =>
  data[0] === 0x16 || data[0] === 0x80 || data[0] === 0x00 ? 'https:' : 'http:';

const writeConnectionEstablished = (socket: Duplex): void => {
  socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
};

const doesConnectAuthorityMatchRequest = (
  context: ProxyRequestContext,
  requestUrl: string,
): boolean => {
  if (!context.connectRequest) return !context.isSSL;
  const authority = parseConnectAuthority(context.connectRequest?.url);
  if (!authority) return false;
  try {
    const request = new URL(requestUrl);
    return (
      request.hostname.toLowerCase() === authority.hostname.toLowerCase() &&
      Number(request.port || getDefaultPort(request.protocol)) === authority.port
    );
  } catch {
    return false;
  }
};

const doesForwardTargetMatchRequest = (
  context: ProxyRequestContext,
  requestUrl: string,
): boolean => {
  const options = context.proxyToServerRequestOptions;
  if (!options?.host) return false;
  try {
    const request = new URL(requestUrl);
    const targetHost = String(options.host)
      .replace(/^\[|\]$/g, '')
      .toLowerCase();
    const targetPort = Number(options.port || getDefaultPort(request.protocol));
    return (
      request.hostname.toLowerCase() === targetHost &&
      Number(request.port || getDefaultPort(request.protocol)) === targetPort
    );
  } catch {
    return false;
  }
};

const safeEqual = (actual: string, expected: string): boolean => {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  );
};

const consumeLocalProxyAuthorization = (
  headers: http.IncomingHttpHeaders,
  capability: string,
): boolean => {
  const raw = headers['proxy-authorization'];
  delete headers['proxy-authorization'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value?.startsWith('Basic ')) return false;
  try {
    const decoded = Buffer.from(value.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    return (
      separator >= 0 &&
      safeEqual(decoded.slice(0, separator), LOCAL_PROXY_USERNAME) &&
      safeEqual(decoded.slice(separator + 1), capability)
    );
  } catch {
    return false;
  }
};

const writeProxyAuthenticationRequired = (socket: Duplex): void => {
  socket.end(
    'HTTP/1.1 407 Proxy Authentication Required\r\n' +
      'Proxy-Authenticate: Basic realm="OpenClaw Gateway"\r\n' +
      'Connection: close\r\n\r\n',
  );
};

const connectRawTunnel = async (
  clientSocket: Duplex,
  head: Buffer,
  authority: ConnectAuthority,
  upstreamProxyUrl: string | null,
  connectionEstablished = false,
): Promise<void> => {
  const attach = (upstreamSocket: Duplex): void => {
    if ('destroyed' in clientSocket && clientSocket.destroyed) {
      upstreamSocket.destroy();
      return;
    }
    if (!connectionEstablished) writeConnectionEstablished(clientSocket);
    if (head.length > 0) upstreamSocket.write(head);
    clientSocket.pipe(upstreamSocket);
    upstreamSocket.pipe(clientSocket);
    clientSocket.once('error', () => upstreamSocket.destroy());
    upstreamSocket.once('error', () => clientSocket.destroy());
    clientSocket.once('close', () => upstreamSocket.destroy());
    upstreamSocket.once('close', () => clientSocket.destroy());
  };

  if (!upstreamProxyUrl) {
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(authority.port, authority.hostname);
      socket.setTimeout(UPSTREAM_CONNECT_TIMEOUT_MS, () =>
        socket.destroy(new Error('Direct CONNECT target timed out.')),
      );
      socket.once('connect', () => {
        socket.setTimeout(0);
        attach(socket);
        resolve();
      });
      socket.once('error', reject);
    });
    return;
  }

  const proxyUrl = new URL(upstreamProxyUrl);
  if (proxyUrl.protocol !== 'http:' && proxyUrl.protocol !== 'https:') {
    throw new Error(`Unsupported upstream CONNECT proxy protocol: ${proxyUrl.protocol}`);
  }
  await new Promise<void>((resolve, reject) => {
    const headers: Record<string, string> = {
      Host: `${authority.hostname}:${authority.port}`,
    };
    setProxyAuthorizationHeader(proxyUrl, headers);
    const request = (proxyUrl.protocol === 'https:' ? https : http).request({
      protocol: proxyUrl.protocol,
      hostname: proxyUrl.hostname,
      port: proxyUrl.port || getDefaultPort(proxyUrl.protocol),
      method: 'CONNECT',
      path: `${authority.hostname}:${authority.port}`,
      headers,
    });
    request.once('connect', (response, socket, responseHead) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Upstream proxy CONNECT returned ${response.statusCode || 0}`));
        return;
      }
      attach(socket);
      if (responseHead.length > 0) clientSocket.write(responseHead);
      resolve();
    });
    request.once('error', reject);
    request.setTimeout(UPSTREAM_CONNECT_TIMEOUT_MS, () =>
      request.destroy(new Error('Upstream proxy CONNECT timed out.')),
    );
    request.end();
  });
};

export class OutboundHeaderProxy {
  private proxy: Proxy | null = null;
  private info: OutboundHeaderProxyInfo | null = null;
  private bypassEntries: readonly string[] = [];
  private capability: string | null = null;
  private activePolicy: OutboundHeaderProxyConfig | null = null;
  private activeHeaderValues: Readonly<Record<string, string>> = Object.freeze({});
  private readonly authenticatedConnectCapabilities = new WeakMap<http.IncomingMessage, string>();
  private readonly authenticatedConnectSockets = new Set<Duplex>();
  private readonly configuredPolicy: OutboundHeaderProxyConfig | null;
  private readonly resolveUpstreamProxy: (targetUrl: string) => Promise<string | null>;
  private readonly userInfoPath: string;
  private readonly caDirectory: string | null;

  constructor(
    config?: OutboundHeaderProxyConfig,
    resolveUpstreamProxy: (
      targetUrl: string,
    ) => Promise<string | null> = resolveConfiguredUpstreamProxy,
    userInfoPath = resolveOutboundHeaderUserInfoPath(),
    caDirectory: string | null = null,
  ) {
    this.configuredPolicy = config ? resolveOutboundHeaderProxyConfig(config) : null;
    this.resolveUpstreamProxy = resolveUpstreamProxy;
    this.userInfoPath = userInfoPath;
    this.caDirectory = caDirectory;
    if (!config) {
      updateOutboundHeaderUserInfoCache(this.userInfoPath);
    }
  }

  private getConfig(): OutboundHeaderProxyConfig {
    return this.configuredPolicy ?? resolveOutboundHeaderProxyConfig();
  }

  setProxyBypassEntries(entries: readonly string[]): void {
    this.bypassEntries = Object.freeze([...entries]);
  }

  async start(): Promise<OutboundHeaderProxyInfo | null> {
    if (this.info) {
      return this.info;
    }

    if (!this.configuredPolicy) {
      updateOutboundHeaderUserInfoCache(this.userInfoPath);
    }
    const config = excludeLoopbackWhitelistEntries(this.getConfig());
    if (!isOutboundHeaderProxyActive(config)) {
      return null;
    }
    this.activePolicy = Object.freeze({
      ...config,
      baseUrlWhitelist: Object.freeze([...config.baseUrlWhitelist]),
      headerNames: Object.freeze([...config.headerNames]),
    });
    this.activeHeaderValues = Object.freeze({
      ...getOutboundHeaderUserInfo(this.userInfoPath, config.headerNames),
    });
    this.capability = crypto.randomBytes(32).toString('base64url');

    const userDataDirectory = this.caDirectory
      ? path.dirname(this.caDirectory)
      : app.getPath('userData');
    const caDirectory = this.caDirectory ?? path.join(userDataDirectory, CA_DIRECTORY_NAME);
    fs.mkdirSync(caDirectory, { recursive: true });

    const proxy = new Proxy();
    const proxyInternals = proxy as Proxy & {
      connectRequests: Record<string, http.IncomingMessage>;
      _onHttpServerConnect: (request: http.IncomingMessage, socket: Duplex, head: Buffer) => void;
      _onHttpServerConnectData: (
        request: http.IncomingMessage,
        socket: Duplex,
        head: Buffer,
      ) => void;
      _onHttpServerRequest: (
        isSSL: boolean,
        request: http.IncomingMessage,
        response: http.ServerResponse,
      ) => void;
    };
    const originalRequest = proxyInternals._onHttpServerRequest.bind(proxy);
    proxyInternals._onHttpServerConnect = (request, socket, head) => {
      socket.once('error', () => socket.destroy());
      const capability = this.capability;
      if (!capability || !consumeLocalProxyAuthorization(request.headers, capability)) {
        writeProxyAuthenticationRequired(socket);
        return;
      }
      const authority = parseConnectAuthority(request.url);
      if (!authority) {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        return;
      }
      this.authenticatedConnectCapabilities.set(request, capability);
      this.authenticatedConnectSockets.add(socket);
      socket.once('close', () => this.authenticatedConnectSockets.delete(socket));
      const handleTunnelData = (data: Buffer): void => {
        socket.pause();
        const protocol = detectConnectProtocol(data);
        if (isConnectInterceptionCandidate(authority, protocol, this.activePolicy!)) {
          proxyInternals._onHttpServerConnectData(request, socket, data);
          return;
        }
        void this.resolveUpstreamProxy(`${protocol}//${authority.hostname}:${authority.port}/`)
          .then(upstreamProxyUrl =>
            connectRawTunnel(socket, data, authority, upstreamProxyUrl, true),
          )
          .catch(error => {
            console.warn('[OutboundHeaderProxy] Raw CONNECT tunnel failed:', error);
            socket.destroy();
          });
      };
      writeConnectionEstablished(socket);
      if (head.length > 0) {
        handleTunnelData(head);
      } else {
        socket.once('data', handleTunnelData);
      }
    };
    proxyInternals._onHttpServerRequest = (isSSL, request, response) => {
      if (!isSSL) {
        const capability = this.capability;
        const connectRequest =
          proxyInternals.connectRequests[
            `${request.socket.remotePort}:${request.socket.localPort}`
          ];
        const hasAuthenticatedConnect =
          !!capability &&
          !!connectRequest &&
          this.authenticatedConnectCapabilities.get(connectRequest) === capability;
        if (
          !hasAuthenticatedConnect &&
          (!capability || !consumeLocalProxyAuthorization(request.headers, capability))
        ) {
          response.writeHead(407, {
            'Proxy-Authenticate': 'Basic realm="OpenClaw Gateway"',
            Connection: 'close',
          });
          response.end();
          return;
        }
      }
      originalRequest(isSSL, request, response);
    };
    proxy.onRequest((context, callback) => {
      void (async () => {
        const requestContext = context as ProxyRequestContext;
        const requestPath = context.clientToProxyRequest.url || '/';
        const requestUrl = /^https?:\/\//i.test(requestPath)
          ? requestPath
          : `${context.isSSL ? 'https' : 'http'}://${context.clientToProxyRequest.headers.host || ''}${requestPath}`;
        if (!doesConnectAuthorityMatchRequest(requestContext, requestUrl)) {
          callback(new Error('CONNECT authority does not match the decrypted request authority.'));
          return;
        }
        if (
          (requestContext.isSSL && !requestContext.connectRequest) ||
          (requestContext.connectRequest &&
            this.authenticatedConnectCapabilities.get(requestContext.connectRequest) !==
              this.capability)
        ) {
          callback(new Error('CONNECT proxy capability is no longer valid.'));
          return;
        }
        if (!doesForwardTargetMatchRequest(requestContext, requestUrl)) {
          callback(new Error('Request authority does not match the forwarding target.'));
          return;
        }
        const upstreamHeaders = context.proxyToServerRequestOptions?.headers;
        if (upstreamHeaders && !Array.isArray(upstreamHeaders)) {
          delete upstreamHeaders['proxy-authorization'];
          delete upstreamHeaders['Proxy-Authorization'];
        }
        await applyUpstreamProxyForRequest(requestContext, requestUrl, this.resolveUpstreamProxy);
        const activePolicy = this.activePolicy;
        const matched =
          !!activePolicy && shouldApplyOutboundHeadersForRequest(activePolicy, requestUrl);
        if (!matched) {
          callback();
          return;
        }

        if (!upstreamHeaders || Array.isArray(upstreamHeaders)) {
          callback(new Error(`Upstream request headers are unavailable for ${requestUrl}`));
          return;
        }
        const injectedHeaderCount = applyOutboundHeaders(upstreamHeaders, this.activeHeaderValues);
        console.log(
          `[OutboundHeaderProxy] outbound header policy matched requestId=${crypto.randomUUID()} origin=${new URL(requestUrl).origin} matched=true injectedHeaderCount=${injectedHeaderCount}`,
        );
        callback();
      })().catch(error => callback(error instanceof Error ? error : new Error(String(error))));
    });
    proxy.onError((_context, error, errorKind) => {
      if (isIgnorableProxyClientError(error)) {
        return;
      }
      console.warn(`[OutboundHeaderProxy] ${errorKind || 'proxy error'}:`, error);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        proxy.listen(
          {
            host: LOOPBACK_HOST,
            port: 0,
            sslCaDir: caDirectory,
          },
          error => (error ? reject(error) : resolve()),
        );
      });
    } catch (error) {
      if (proxy.httpServer) proxy.close();
      this.capability = null;
      this.activePolicy = null;
      this.activeHeaderValues = Object.freeze({});
      throw error;
    }

    const caCertificatePath = path.join(caDirectory, CA_CERTIFICATE_PATH);
    if (!fs.existsSync(caCertificatePath)) {
      proxy.close();
      this.capability = null;
      this.activePolicy = null;
      this.activeHeaderValues = Object.freeze({});
      throw new Error(`Proxy CA certificate was not created: ${caCertificatePath}`);
    }

    this.proxy = proxy;
    this.info = {
      proxyUrl: `http://${LOOPBACK_HOST}:${proxy.httpPort}`,
      caCertificatePath,
      caBundlePath:
        buildOutboundHeaderTrustedCaBundle(userDataDirectory, caCertificatePath) ??
        caCertificatePath,
    };
    console.log(`[OutboundHeaderProxy] listening on ${this.info.proxyUrl}`);
    return this.info;
  }

  stop(): void {
    this.destroyAuthenticatedConnectSockets();
    this.proxy?.close();
    this.proxy = null;
    this.info = null;
    this.capability = null;
    this.activePolicy = null;
    this.activeHeaderValues = Object.freeze({});
  }

  rotateGatewayCapability(): void {
    if (this.info && this.activePolicy) {
      this.destroyAuthenticatedConnectSockets();
      this.capability = crypto.randomBytes(32).toString('base64url');
    }
  }

  private destroyAuthenticatedConnectSockets(): void {
    for (const socket of this.authenticatedConnectSockets) socket.destroy();
    this.authenticatedConnectSockets.clear();
  }

  buildGatewayEnvironment(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    if (!this.info || !this.capability || !this.activePolicy) {
      return { ...baseEnv };
    }
    const bypassConflict = findWhitelistBypassConflict(this.activePolicy, baseEnv);
    if (bypassConflict) {
      throw new Error(
        `Outbound Header Proxy whitelist conflicts with NO_PROXY entry: ${bypassConflict}`,
      );
    }
    const proxyUrl = new URL(this.info.proxyUrl);
    proxyUrl.username = LOCAL_PROXY_USERNAME;
    proxyUrl.password = this.capability;
    return buildGatewayNetworkEnvironment(
      baseEnv,
      { proxyUrl: proxyUrl.toString(), caBundlePath: this.info.caBundlePath },
      this.bypassEntries,
    );
  }
}
