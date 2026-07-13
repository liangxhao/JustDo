import { app, session } from 'electron';
import fs from 'fs';
import { Proxy } from 'http-mitm-proxy';
import { HttpsProxyAgent } from 'https-proxy-agent';
import path from 'path';

import {
  getOutboundHeaderPolicyConfig,
  getOutboundHeaderUserInfo,
  resolveOutboundHeaderUserInfoPath,
  updateOutboundHeaderUserInfoCache,
} from './outboundHeaderPolicyConfig';
import {
  configureOutboundProxyBypass,
  getFixedProxyUrl,
  isSystemProxyEnabled,
  resolveSystemProxyUrl,
  restoreOriginalProxyEnv,
} from './systemProxy';

const LOOPBACK_HOST = '127.0.0.1';
const CA_DIRECTORY_NAME = 'outbound-header-proxy';
const CA_CERTIFICATE_PATH = path.join('certs', 'ca.pem');
const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HTTP_HEADER_VALUE_PATTERN = /^[\u0020-\u007e\u0080-\u00ff]*$/;
const OUTBOUND_HEADER_PROXY_ENV_KEYS = [
  'NODE_EXTRA_CA_CERTS',
  'NODE_USE_ENV_PROXY',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'SSL_CERT_FILE',
] as const;
const originalOutboundHeaderProxyEnv = OUTBOUND_HEADER_PROXY_ENV_KEYS.reduce(
  (acc, key) => {
    acc[key] = process.env[key];
    return acc;
  },
  {} as Record<(typeof OUTBOUND_HEADER_PROXY_ENV_KEYS)[number], string | undefined>,
);

export type OutboundHeaderProxyConfig = {
  enabled: boolean;
  baseUrlWhitelist: readonly string[];
  headerNames: readonly string[];
};

export type OutboundHeaderProxyInfo = {
  proxyUrl: string;
  caCertificatePath: string;
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
): void => {
  for (const [headerName, value] of Object.entries(headerValues)) {
    if (!HTTP_HEADER_VALUE_PATTERN.test(value)) {
      console.warn(`[OutboundHeaderProxy] Skipped unsafe outbound header value: ${headerName}`);
      continue;
    }
    const existingKey =
      Object.keys(headers).find(key => key.toLowerCase() === headerName.toLowerCase()) ||
      headerName;
    headers[existingKey] = value;
  }
};

export const applyOutboundProxyEnv = (
  env: NodeJS.ProcessEnv,
  info: OutboundHeaderProxyInfo,
  config: OutboundHeaderProxyConfig,
  bypassEntries: readonly string[] = [],
): void => {
  if (!isOutboundHeaderProxyActive(config)) {
    return;
  }

  env.http_proxy = info.proxyUrl;
  env.https_proxy = info.proxyUrl;
  env.HTTP_PROXY = info.proxyUrl;
  env.HTTPS_PROXY = info.proxyUrl;
  env.NODE_EXTRA_CA_CERTS = info.caCertificatePath;
  env.NODE_USE_ENV_PROXY = '1';
  env.REQUESTS_CA_BUNDLE = info.caCertificatePath;
  env.CURL_CA_BUNDLE = info.caCertificatePath;
  env.SSL_CERT_FILE = info.caCertificatePath;
  // Only bypass the specific loopback endpoints that must stay direct.
  // We intentionally avoid broad loopback bypasses here so local services like
  // LiteLLM can still be reached through the local MITM proxy and receive
  // injected headers.
  configureOutboundProxyBypass(env, bypassEntries);
};

export const restoreOutboundProxyEnv = (env: NodeJS.ProcessEnv): void => {
  for (const key of OUTBOUND_HEADER_PROXY_ENV_KEYS) {
    const originalValue = originalOutboundHeaderProxyEnv[key];
    if (typeof originalValue === 'string') {
      env[key] = originalValue;
    } else {
      delete env[key];
    }
  }
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
  'PROXY_TO_CLIENT_RESPONSE_ERROR',
]);

type MitmErrorHandler = (context: unknown, error: Error, kind: string) => void;
type MitmProxyWithInternalErrorHook = Proxy & {
  _onError?: (kind: string, context: unknown, error: Error) => void;
  onErrorHandlers?: MitmErrorHandler[];
};

type MitmContextWithErrorHandlers = {
  onErrorHandlers?: MitmErrorHandler[];
};

type ProxyRequestContext = {
  isSSL?: boolean;
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
): Promise<void> => {
  const upstreamProxyUrl = await resolveConfiguredUpstreamProxy(requestUrl);
  if (!upstreamProxyUrl || !context.proxyToServerRequestOptions) {
    return;
  }

  const proxyUrl = new URL(upstreamProxyUrl);
  const proxyProtocol = proxyUrl.protocol;

  if (context.isSSL) {
    if (proxyProtocol !== 'http:' && proxyProtocol !== 'https:') {
      console.warn(`[OutboundHeaderProxy] Unsupported upstream proxy for HTTPS: ${proxyProtocol}`);
      return;
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
    console.warn(`[OutboundHeaderProxy] Unsupported upstream proxy for HTTP: ${proxyProtocol}`);
    return;
  }

  const headers = context.proxyToServerRequestOptions.headers ?? {};
  context.proxyToServerRequestOptions.headers = headers;
  context.proxyToServerRequestOptions.host = proxyUrl.hostname;
  context.proxyToServerRequestOptions.port = proxyUrl.port || getDefaultPort(proxyProtocol);
  context.proxyToServerRequestOptions.path = requestUrl;
  setProxyAuthorizationHeader(proxyUrl, headers);
  headers['Proxy-Connection'] = 'close';
};

export class OutboundHeaderProxy {
  private proxy: Proxy | null = null;
  private info: OutboundHeaderProxyInfo | null = null;
  private originalFetch: typeof globalThis.fetch | null = null;
  private bypassEntries: readonly string[] = [];
  private readonly configuredPolicy: OutboundHeaderProxyConfig | null;
  private readonly userInfoPath: string;

  constructor(
    config?: OutboundHeaderProxyConfig,
    _resolveUpstreamProxy?: (targetUrl: string) => Promise<string | null>,
    userInfoPath = resolveOutboundHeaderUserInfoPath(),
  ) {
    this.configuredPolicy = config ? resolveOutboundHeaderProxyConfig(config) : null;
    this.userInfoPath = userInfoPath;
    if (!config) {
      updateOutboundHeaderUserInfoCache(this.userInfoPath);
    }
  }

  private getConfig(): OutboundHeaderProxyConfig {
    return this.configuredPolicy ?? resolveOutboundHeaderProxyConfig();
  }

  setProxyBypassEntries(entries: readonly string[]): void {
    this.bypassEntries = entries;
    this.reapplyProcessEnvironment();
  }

  async start(): Promise<OutboundHeaderProxyInfo> {
    if (this.info) {
      return this.info;
    }

    const caDirectory = path.join(app.getPath('userData'), CA_DIRECTORY_NAME);
    fs.mkdirSync(caDirectory, { recursive: true });

    const proxy = new Proxy();
    suppressNoisyMitmDisconnectLogs(proxy);
    proxy.onRequest((context, callback) => {
      void (async () => {
        const requestContext = context as ProxyRequestContext;
        const requestPath = context.clientToProxyRequest.url || '/';
        const requestUrl = /^https?:\/\//i.test(requestPath)
          ? requestPath
          : `${context.isSSL ? 'https' : 'http'}://${context.clientToProxyRequest.headers.host || ''}${requestPath}`;
        await applyUpstreamProxyForRequest(requestContext, requestUrl);
        const config = this.getConfig();
        if (!shouldApplyOutboundHeadersForRequest(config, requestUrl)) {
          callback();
          return;
        }

        const upstreamHeaders = context.proxyToServerRequestOptions?.headers;
        if (!upstreamHeaders || Array.isArray(upstreamHeaders)) {
          callback(new Error(`Upstream request headers are unavailable for ${requestUrl}`));
          return;
        }
        applyOutboundHeaders(
          upstreamHeaders,
          getOutboundHeaderUserInfo(this.userInfoPath, config.headerNames),
        );
        callback();
      })().catch(error => callback(error instanceof Error ? error : new Error(String(error))));
    });
    proxy.onError((_context, error, errorKind) => {
      if (isIgnorableProxyClientError(error)) {
        console.debug(`[OutboundHeaderProxy] ${errorKind || 'proxy client disconnected'}:`, error);
        return;
      }
      console.warn(`[OutboundHeaderProxy] ${errorKind || 'proxy error'}:`, error);
    });

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

    const caCertificatePath = path.join(caDirectory, CA_CERTIFICATE_PATH);
    if (!fs.existsSync(caCertificatePath)) {
      proxy.close();
      throw new Error(`Proxy CA certificate was not created: ${caCertificatePath}`);
    }

    this.proxy = proxy;
    this.info = {
      proxyUrl: `http://${LOOPBACK_HOST}:${proxy.httpPort}`,
      caCertificatePath,
    };
    applyOutboundProxyEnv(process.env, this.info, this.getConfig(), this.bypassEntries);
    this.registerGlobalFetchInjection();
    this.registerElectronHeaderInjection();
    console.log(`[OutboundHeaderProxy] listening on ${this.info.proxyUrl}`);
    return this.info;
  }

  stop(): void {
    this.proxy?.close();
    this.proxy = null;
    this.info = null;
    restoreOriginalProxyEnv();
    restoreOutboundProxyEnv(process.env);
    if (this.originalFetch) {
      globalThis.fetch = this.originalFetch;
      this.originalFetch = null;
    }
  }

  reapplyProcessEnvironment(): void {
    if (this.info) {
      applyOutboundProxyEnv(process.env, this.info, this.getConfig(), this.bypassEntries);
    }
  }

  private registerElectronHeaderInjection(): void {
    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
      const requestHeaders = { ...details.requestHeaders };
      const config = this.getConfig();
      if (shouldApplyOutboundHeadersForRequest(config, details.url)) {
        applyOutboundHeaders(
          requestHeaders,
          getOutboundHeaderUserInfo(this.userInfoPath, config.headerNames),
        );
      }
      callback({ requestHeaders });
    });
  }

  private registerGlobalFetchInjection(): void {
    if (this.originalFetch) {
      return;
    }

    const originalFetch = globalThis.fetch.bind(globalThis);
    this.originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const requestUrl =
        input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
      const config = this.getConfig();
      if (!shouldApplyOutboundHeadersForRequest(config, requestUrl)) {
        return originalFetch(input, init);
      }

      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
      const headerValues = getOutboundHeaderUserInfo(this.userInfoPath, config.headerNames);
      for (const [name, value] of Object.entries(headerValues)) {
        headers.set(name, value);
      }
      return originalFetch(input, { ...init, headers });
    };
  }
}
