import crypto from 'crypto';
import http from 'http';
import https from 'https';
import { ProxyAgent } from 'proxy-agent';
import { Readable } from 'stream';

import {
  getOutboundHeaderPolicyConfig,
  getOutboundHeaderUserInfo,
} from './outboundHeaderPolicyConfig';
import {
  applyOutboundHeaders,
  resolveOutboundHeaderProxyConfig,
  resolveOutboundHeaderValuesForRequest,
  shouldApplyOutboundHeadersForRequest,
} from './outboundHeaderProxy';
import { getFixedProxyUrl, isSystemProxyEnabled, resolveSystemProxyUrl } from './systemProxy';

const resolveConfiguredProxy = async (requestUrl: string): Promise<string | null> => {
  const fixedProxyUrl = getFixedProxyUrl();
  if (fixedProxyUrl) return fixedProxyUrl;
  if (!isSystemProxyEnabled()) return null;
  return resolveSystemProxyUrl(requestUrl);
};

const prepareProxy = (requestUrl: string, signal?: AbortSignal | null): Promise<string | null> => {
  if (!signal) return resolveConfiguredProxy(requestUrl);
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new DOMException('Request was cancelled.', 'AbortError'));
    if (signal.aborted) { aborted(); return; }
    signal.addEventListener('abort', aborted, { once: true });
    void resolveConfiguredProxy(requestUrl).then(
      value => { signal.removeEventListener('abort', aborted); resolve(value); },
      error => { signal.removeEventListener('abort', aborted); reject(error); },
    );
  });
};

export const MainProcessOutboundHeaderSource = {
  ModelProbe: 'model-probe',
  SessionTitle: 'session-title',
  McpProbe: 'mcp-probe',
} as const;

export type MainProcessOutboundHeaderSource =
  (typeof MainProcessOutboundHeaderSource)[keyof typeof MainProcessOutboundHeaderSource];

/** Main-process fetch transport. It deliberately has no outbound-header policy. */
export const mainProcessFetch = async (
  requestUrl: string,
  init?: RequestInit,
  options?: { maxResponseBytes?: number; beforeDispatch?: () => void },
): Promise<Response> => {
  const proxyUrl = await prepareProxy(requestUrl, init?.signal);
  options?.beforeDispatch?.();
  if (!proxyUrl) return globalThis.fetch(requestUrl, init);

  const url = new URL(requestUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported proxy fetch protocol: ${url.protocol}`);
  }
  const body = init?.body;
  if (
    body !== undefined &&
    body !== null &&
    typeof body !== 'string' &&
    !ArrayBuffer.isView(body)
  ) {
    throw new Error('Proxy fetch only supports string and typed-array request bodies.');
  }

  const agent = new ProxyAgent({ getProxyForUrl: () => proxyUrl });
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise<Response>((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method: init?.method || 'GET',
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        agent,
        signal: init?.signal ?? undefined,
      },
      response => {
        const chunks: Buffer[] = [];
        let responseBytes = 0;
        let settled = false;
        response.on('data', chunk => {
          if (settled) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          responseBytes += buffer.length;
          if (options?.maxResponseBytes !== undefined && responseBytes > options.maxResponseBytes) {
            settled = true;
            response.destroy();
            reject(new Error('Response exceeded the configured size limit.'));
            return;
          }
          chunks.push(buffer);
        });
        response.once('error', error => {
          if (!settled) reject(error);
        });
        response.once('end', () => {
          if (settled) return;
          settled = true;
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) value.forEach(item => headers.append(name, item));
            else if (value !== undefined) headers.set(name, value);
          }
          const status = response.statusCode || 500;
          resolve(
            new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), {
              status,
              statusText: response.statusMessage,
              headers,
            }),
          );
        });
      },
    );
    request.once('error', reject);
    request.once('close', () => agent.destroy());
    if (body !== undefined && body !== null) request.write(body);
    request.end();
  });
};

const mainProcessStreamingFetch = async (
  requestUrl: string,
  init?: RequestInit,
): Promise<Response> => {
  const proxyUrl = await resolveConfiguredProxy(requestUrl);
  if (!proxyUrl) return globalThis.fetch(requestUrl, init);

  const url = new URL(requestUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported proxy fetch protocol: ${url.protocol}`);
  }
  const body = init?.body;
  if (
    body !== undefined &&
    body !== null &&
    typeof body !== 'string' &&
    !ArrayBuffer.isView(body)
  ) {
    throw new Error('Proxy fetch only supports string and typed-array request bodies.');
  }

  const agent = new ProxyAgent({ getProxyForUrl: () => proxyUrl });
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const destroyAgent = (): void => agent.destroy();
    const request = transport.request(
      url,
      {
        method: init?.method || 'GET',
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        agent,
        signal: init?.signal ?? undefined,
      },
      response => {
        response.once('close', destroyAgent);
        const status = response.statusCode || 500;
        if (init?.redirect === 'error' && status >= 300 && status < 400) {
          response.resume();
          settled = true;
          reject(new Error('Redirect response is not allowed for this request.'));
          return;
        }

        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) value.forEach(item => headers.append(name, item));
          else if (value !== undefined) headers.set(name, value);
        }
        const responseBody =
          init?.method?.toUpperCase() === 'HEAD' || [204, 205, 304].includes(status)
            ? null
            : (Readable.toWeb(response) as ReadableStream<Uint8Array>);
        settled = true;
        resolve(
          new Response(responseBody, {
            status,
            statusText: response.statusMessage,
            headers,
          }),
        );
      },
    );
    request.once('error', error => {
      destroyAgent();
      if (!settled) reject(error);
    });
    if (body !== undefined && body !== null) request.write(body);
    request.end();
  });
};

export const applyMainProcessOutboundHeaderPolicy = (
  requestUrl: string,
  requestHeaders: HeadersInit | undefined,
  source: MainProcessOutboundHeaderSource,
): Record<string, string> => {
  const headers = Object.fromEntries(new Headers(requestHeaders).entries());
  const policy = resolveOutboundHeaderProxyConfig(getOutboundHeaderPolicyConfig());
  if (!shouldApplyOutboundHeadersForRequest(policy, requestUrl)) {
    return headers;
  }

  const values = resolveOutboundHeaderValuesForRequest(policy, requestUrl, getOutboundHeaderUserInfo());
  const injectedHeaderCount = applyOutboundHeaders(headers, values, headerName =>
    console.warn(
      `[MainProcessOutboundHeaderPolicy] source=${source} skipped unsafe outbound header value: ${headerName}`,
    ),
  );
  console.log(
    `[MainProcessOutboundHeaderPolicy] source=${source} outbound header policy matched requestId=${crypto.randomUUID()} origin=${new URL(requestUrl).origin} matched=true injectedHeaderCount=${injectedHeaderCount}`,
  );
  return headers;
};

/** Title-generation fetch with outbound-header policy support. */
export const mainProcessTitleFetch = async (
  requestUrl: string,
  init?: RequestInit,
): Promise<Response> => {
  const headers = applyMainProcessOutboundHeaderPolicy(
    requestUrl,
    init?.headers,
    MainProcessOutboundHeaderSource.SessionTitle,
  );
  return mainProcessFetch(requestUrl, { ...init, headers, redirect: 'error' });
};

/** MCP probe fetch with outbound-header policy support and streaming responses. */
export const mainProcessMcpProbeFetch = async (
  requestUrl: string | URL,
  init?: RequestInit,
): Promise<Response> => {
  const normalizedUrl = requestUrl.toString();
  const headers = applyMainProcessOutboundHeaderPolicy(
    normalizedUrl,
    init?.headers,
    MainProcessOutboundHeaderSource.McpProbe,
  );
  return mainProcessStreamingFetch(normalizedUrl, { ...init, headers, redirect: 'error' });
};
