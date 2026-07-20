import http from 'http';
import https from 'https';
import { ProxyAgent } from 'proxy-agent';

import {
  getOutboundHeaderPolicyConfig,
  getOutboundHeaderUserInfo,
} from './outboundHeaderPolicyConfig';
import {
  applyOutboundHeaders,
  resolveOutboundHeaderProxyConfig,
  shouldApplyOutboundHeadersForRequest,
} from './outboundHeaderProxy';
import { getFixedProxyUrl, isSystemProxyEnabled, resolveSystemProxyUrl } from './systemProxy';

const resolveConfiguredProxy = async (requestUrl: string): Promise<string | null> => {
  const fixedProxyUrl = getFixedProxyUrl();
  if (fixedProxyUrl) return fixedProxyUrl;
  if (!isSystemProxyEnabled()) return null;
  return resolveSystemProxyUrl(requestUrl);
};

/** Main-process fetch transport. It deliberately has no outbound-header policy. */
export const mainProcessFetch = async (
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
        response.on('data', chunk =>
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
        );
        response.once('error', reject);
        response.once('end', () => {
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

/** The only Main-process request allowed to opt into the outbound-header policy. */
export const mainProcessTitleFetch = async (
  requestUrl: string,
  init?: RequestInit,
): Promise<Response> => {
  const policy = resolveOutboundHeaderProxyConfig(getOutboundHeaderPolicyConfig());
  if (!shouldApplyOutboundHeadersForRequest(policy, requestUrl)) {
    return mainProcessFetch(requestUrl, init);
  }

  const headers = Object.fromEntries(new Headers(init?.headers).entries());
  const values = getOutboundHeaderUserInfo(undefined, policy.headerNames);
  applyOutboundHeaders(headers, values);
  return mainProcessFetch(requestUrl, { ...init, headers });
};
