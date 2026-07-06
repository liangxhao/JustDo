import { app, session } from 'electron';
import fs from 'fs';
import type http from 'http';
import { Proxy } from 'http-mitm-proxy';
import type https from 'https';
import path from 'path';
import { ProxyAgent } from 'proxy-agent';

import {
  getOutboundHeaderPolicyConfig,
  getOutboundHeaderUserInfo,
  resolveOutboundHeaderUserInfoPath,
  updateOutboundHeaderUserInfoCache,
} from './outboundHeaderPolicyConfig';
import { isSystemProxyEnabled, resolveSystemProxyUrl } from './systemProxy';

const LOOPBACK_HOST = '127.0.0.1';
const CA_DIRECTORY_NAME = 'outbound-header-proxy';
const CA_CERTIFICATE_PATH = path.join('certs', 'ca.pem');
const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

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
      return request.protocol === base.protocol
        && request.hostname === base.hostname
        && request.port === base.port
        && request.pathname.startsWith(base.pathname);
    });
  } catch {
    return false;
  }
};

export const applyOutboundHeaders = (
  headers: Record<string, string | string[] | undefined>,
  headerValues: Readonly<Record<string, string>>,
): void => {
  for (const [headerName, value] of Object.entries(headerValues)) {
    const existingKey =
      Object.keys(headers).find(key => key.toLowerCase() === headerName.toLowerCase())
      || headerName;
    headers[existingKey] = value;
  }
};

export const applyOutboundProxyEnv = (
  env: NodeJS.ProcessEnv,
  info: OutboundHeaderProxyInfo,
): void => {
  env.http_proxy = info.proxyUrl;
  env.https_proxy = info.proxyUrl;
  env.HTTP_PROXY = info.proxyUrl;
  env.HTTPS_PROXY = info.proxyUrl;
  env.NODE_EXTRA_CA_CERTS = info.caCertificatePath;
  env.NODE_USE_ENV_PROXY = '1';
  env.REQUESTS_CA_BUNDLE = info.caCertificatePath;
  env.CURL_CA_BUNDLE = info.caCertificatePath;
  env.SSL_CERT_FILE = info.caCertificatePath;
  // Every child request must enter the local header proxy first. The proxy
  // itself still honors the application's system proxy/DIRECT resolution.
  env.no_proxy = '';
  env.NO_PROXY = '';
};

export class OutboundHeaderProxy {
  private proxy: Proxy | null = null;
  private upstreamAgent: ProxyAgent | null = null;
  private info: OutboundHeaderProxyInfo | null = null;
  private originalFetch: typeof globalThis.fetch | null = null;
  private readonly configuredPolicy: OutboundHeaderProxyConfig | null;
  private readonly userInfoPath: string;
  private readonly resolveUpstreamProxy: (targetUrl: string) => Promise<string | null>;

  constructor(
    config?: OutboundHeaderProxyConfig,
    resolveUpstreamProxy = async (targetUrl: string): Promise<string | null> => {
      if (!isSystemProxyEnabled()) {
        return null;
      }
      return resolveSystemProxyUrl(targetUrl);
    },
    userInfoPath = resolveOutboundHeaderUserInfoPath(),
  ) {
    this.configuredPolicy = config ? resolveOutboundHeaderProxyConfig(config) : null;
    this.resolveUpstreamProxy = resolveUpstreamProxy;
    this.userInfoPath = userInfoPath;
    if (!config) {
      updateOutboundHeaderUserInfoCache(this.userInfoPath);
    }
  }

  private getConfig(): OutboundHeaderProxyConfig {
    return this.configuredPolicy ?? resolveOutboundHeaderProxyConfig();
  }

  async start(): Promise<OutboundHeaderProxyInfo> {
    if (this.info) {
      return this.info;
    }

    const caDirectory = path.join(app.getPath('userData'), CA_DIRECTORY_NAME);
    fs.mkdirSync(caDirectory, { recursive: true });

    const upstreamAgent = new ProxyAgent({
      keepAlive: true,
      getProxyForUrl: async (targetUrl: string) =>
        (await this.resolveUpstreamProxy(targetUrl)) || '',
    });
    const proxy = new Proxy();
    proxy.onRequest((context, callback) => {
      const requestPath = context.clientToProxyRequest.url || '/';
      const requestUrl = /^https?:\/\//i.test(requestPath)
        ? requestPath
        : `${context.isSSL ? 'https' : 'http'}://${context.clientToProxyRequest.headers.host || ''}${requestPath}`;
      const config = this.getConfig();
      if (config.enabled && shouldInjectOutboundHeaders(requestUrl, config.baseUrlWhitelist)) {
        const upstreamHeaders = context.proxyToServerRequestOptions?.headers;
        if (!upstreamHeaders || Array.isArray(upstreamHeaders)) {
          callback(new Error(`Upstream request headers are unavailable for ${requestUrl}`));
          return;
        }
        applyOutboundHeaders(
          upstreamHeaders,
          getOutboundHeaderUserInfo(this.userInfoPath, config.headerNames),
        );
      }
      callback();
    });
    proxy.onError((_context, error, errorKind) => {
      console.warn(`[OutboundHeaderProxy] ${errorKind || 'proxy error'}:`, error);
    });

    await new Promise<void>((resolve, reject) => {
      proxy.listen(
        {
          host: LOOPBACK_HOST,
          port: 0,
          sslCaDir: caDirectory,
          // ProxyAgent implements Node's agent contract through agent-base. The
          // MITM package types are narrower and only declare concrete core agents.
          httpAgent: upstreamAgent as unknown as http.Agent,
          httpsAgent: upstreamAgent as unknown as https.Agent,
        },
        error => error ? reject(error) : resolve(),
      );
    });

    const caCertificatePath = path.join(caDirectory, CA_CERTIFICATE_PATH);
    if (!fs.existsSync(caCertificatePath)) {
      proxy.close();
      throw new Error(`Proxy CA certificate was not created: ${caCertificatePath}`);
    }

    this.proxy = proxy;
    this.upstreamAgent = upstreamAgent;
    this.info = {
      proxyUrl: `http://${LOOPBACK_HOST}:${proxy.httpPort}`,
      caCertificatePath,
    };
    applyOutboundProxyEnv(process.env, this.info);
    this.registerGlobalFetchInjection();
    this.registerElectronHeaderInjection();
    console.log(`[OutboundHeaderProxy] listening on ${this.info.proxyUrl}`);
    return this.info;
  }

  stop(): void {
    this.proxy?.close();
    this.upstreamAgent?.destroy();
    this.proxy = null;
    this.upstreamAgent = null;
    this.info = null;
    if (this.originalFetch) {
      globalThis.fetch = this.originalFetch;
      this.originalFetch = null;
    }
  }

  reapplyProcessEnvironment(): void {
    if (this.info) {
      applyOutboundProxyEnv(process.env, this.info);
    }
  }

  private registerElectronHeaderInjection(): void {
    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
      const requestHeaders = { ...details.requestHeaders };
      const config = this.getConfig();
      if (config.enabled && shouldInjectOutboundHeaders(details.url, config.baseUrlWhitelist)) {
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
      if (!config.enabled || !shouldInjectOutboundHeaders(requestUrl, config.baseUrlWhitelist)) {
        return originalFetch(input, init);
      }

      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
      const headerValues = getOutboundHeaderUserInfo(
        this.userInfoPath,
        config.headerNames,
      );
      for (const [name, value] of Object.entries(headerValues)) {
        headers.set(name, value);
      }
      return originalFetch(input, { ...init, headers });
    };
  }
}
