import { randomBytes, timingSafeEqual } from 'node:crypto';
import http, { type ClientRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import { pipeline } from 'node:stream';

import { canonicalHostedCanvasResource, hostedCanvasEntryResource } from './hostedCanvasPaths';
import type { HostedCanvasBinding } from './hostedCanvasSurface';

const MOUNT_HEADER = 'x-canvas-mount';
const STATIC_TIMEOUT_MS = 30_000;
const POLICY_HEADERS = [
  'content-type',
  'content-length',
  'content-security-policy',
  'content-security-policy-report-only',
  'cross-origin-embedder-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'x-frame-options',
  'x-content-type-options',
  'referrer-policy',
  'permissions-policy',
] as const;

export interface HostedCanvasForwarder {
  readonly origin: string;
  readonly entryUrl: string;
  /** Main-only guest session headers. Never send through IPC or put in a URL. */
  readonly requestHeaders: Readonly<Record<string, string>>;
  isAllowedUrl(url: string): boolean;
  close(): Promise<void>;
}

interface ForwarderOptions {
  documentId: string;
  entryPath: string;
  binding: HostedCanvasBinding;
  isMountCurrent(): boolean;
}

function matchesSecret(value: string | string[] | undefined, secret: string): boolean {
  if (typeof value !== 'string') return false;
  const received = Buffer.from(value);
  const expected = Buffer.from(secret);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function replyFailure(response: ServerResponse, status: number): void {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(status === 404 ? 'Document unavailable.' : 'Document request unavailable.');
}

function safeResponseHeaders(
  response: IncomingMessage,
  upstream: URL,
): Record<string, string> | null {
  const headers: Record<string, string> = {};
  const capability = upstream.pathname.split('/')[3];
  if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')
    return null;
  for (const name of POLICY_HEADERS) {
    const value = response.headers[name];
    if (value === undefined) continue;
    // Multiple CSP policies intersect. Preserve them as one comma-separated
    // policy list rather than silently dropping any server policy.
    const joined = Array.isArray(value) ? value.join(', ') : value;
    if (joined.length > 32_768 || /[\r\n]/.test(joined)) return null;
    let decoded = joined;
    for (let depth = 0; depth <= 3; depth++) {
      if (decoded.includes('/__openclaw__/cap/') || (capability && decoded.includes(capability)))
        return null;
      if (depth === 3) break;
      try {
        const next = decodeURIComponent(decoded);
        if (next === decoded) break;
        decoded = next;
      } catch {
        break;
      }
    }
    if (
      name === 'content-length' &&
      (!/^\d+$/.test(joined) || !Number.isSafeInteger(Number(joined)))
    )
      return null;
    headers[name] = joined;
  }
  if (!headers['content-type']) return null;
  // The capability route is never the document's public address. Prevent the
  // replacement mount address from leaking as an external page's Referer too.
  headers['referrer-policy'] = 'no-referrer';
  headers['cache-control'] = 'no-store';
  return headers;
}

/**
 * One origin and one read-only document scope per mount. This transports the
 * native HTTP representation without reading disk, retaining HTML, changing CSP,
 * forwarding browser credentials, or making application/API requests for HTML.
 */
export async function createHostedCanvasForwarder(
  options: ForwarderOptions,
): Promise<HostedCanvasForwarder> {
  const entryResource = hostedCanvasEntryResource(options.documentId, options.entryPath);
  if (!entryResource || !options.binding.isCurrent() || !options.isMountCurrent()) {
    throw new Error('Hosted document is unavailable.');
  }
  const secret = randomBytes(32).toString('base64url');
  const requests = new Set<ClientRequest>();
  const responses = new Set<ServerResponse>();
  let closed = false;
  let origin = '';
  let closePromise: Promise<void> | null = null;
  let unsubscribeRetired: () => void = () => {};
  const isCurrent = () => !closed && options.isMountCurrent() && options.binding.isCurrent();

  const read = async (
    resource: string,
    method: 'GET' | 'HEAD',
    response?: ServerResponse,
  ): Promise<void> => {
    const upstream = await options.binding.getResourceUrl(resource);
    const nativePrefix = /^\/__openclaw__\/cap\/[A-Za-z0-9_-]{16,256}/.exec(upstream.pathname)?.[0];
    if (
      !isCurrent() ||
      upstream.origin !== options.binding.gatewayOrigin ||
      !nativePrefix ||
      `${upstream.pathname.slice(nativePrefix.length)}${upstream.search}` !== resource ||
      upstream.username ||
      upstream.password ||
      upstream.hash
    )
      throw new Error('Hosted document is unavailable.');
    await new Promise<void>((resolve, reject) => {
      let complete = false;
      const finish = (error?: Error) => {
        if (complete) return;
        complete = true;
        requests.delete(request);
        response?.removeListener('close', cancel);
        if (error) reject(error);
        else resolve();
      };
      const transport = upstream.protocol === 'https:' ? https : http;
      const request = transport.request(
        upstream,
        {
          method,
          agent: false,
          headers: { accept: '*/*', 'accept-encoding': 'identity' },
        },
        nativeResponse => {
          if (!isCurrent()) {
            nativeResponse.destroy();
            request.destroy();
            finish(new Error('Hosted document is unavailable.'));
            return;
          }
          const headers = safeResponseHeaders(nativeResponse, upstream);
          if (nativeResponse.statusCode !== 200 || !headers) {
            const status = nativeResponse.statusCode === 404 ? 404 : 503;
            nativeResponse.destroy();
            if (response) replyFailure(response, status);
            finish(new Error('Hosted document is unavailable.'));
            return;
          }
          if (!response) {
            // The initial HEAD proves that the independently staged document is
            // authenticated and readable. No document body is fetched or cached.
            nativeResponse.resume();
            nativeResponse.once('end', () => finish());
            nativeResponse.once('error', () =>
              finish(new Error('Hosted document is unavailable.')),
            );
            return;
          }
          response.writeHead(200, headers);
          if (method === 'HEAD') {
            nativeResponse.resume();
            response.end();
            finish();
            return;
          }
          nativeResponse.on('data', () => {
            if (!isCurrent()) {
              nativeResponse.destroy();
              response.destroy();
            }
          });
          pipeline(nativeResponse, response, error =>
            finish(error ? new Error('Hosted document is unavailable.') : undefined),
          );
        },
      );
      const cancel = () => {
        request.destroy();
        finish(new Error('Hosted document request ended.'));
      };
      requests.add(request);
      response?.once('close', cancel);
      request.setTimeout(STATIC_TIMEOUT_MS, () =>
        request.destroy(new Error('Hosted document request timed out.')),
      );
      request.once('error', () => finish(new Error('Hosted document is unavailable.')));
      request.end();
    });
  };

  const server = http.createServer((request, response) => {
    responses.add(response);
    response.once('close', () => {
      responses.delete(response);
    });
    if (
      !isCurrent() ||
      request.headers.host !== new URL(origin).host ||
      !matchesSecret(request.headers[MOUNT_HEADER], secret)
    ) {
      replyFailure(response, 403);
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      replyFailure(response, 405);
      return;
    }
    const resource = canonicalHostedCanvasResource(request.url ?? '', options.documentId);
    if (!resource) {
      replyFailure(response, 404);
      return;
    }
    void read(resource, request.method, response).catch(() => {
      replyFailure(response, 503);
    });
  });
  server.maxConnections = 32;
  server.headersTimeout = STATIC_TIMEOUT_MS;
  server.requestTimeout = STATIC_TIMEOUT_MS;
  server.keepAliveTimeout = 1000;

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closed = true;
    unsubscribeRetired();
    for (const request of requests) request.destroy();
    for (const response of responses) response.destroy();
    closePromise = new Promise(resolve => {
      server.closeAllConnections();
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
    return closePromise;
  };

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Hosted document is unavailable.');
    origin = `http://127.0.0.1:${address.port}`;
    unsubscribeRetired = options.binding.onRetired(() => {
      void close();
    });
    await read(entryResource, 'HEAD');
    if (!isCurrent()) throw new Error('Hosted document is unavailable.');
  } catch {
    await close();
    throw new Error('Hosted document is unavailable.');
  }

  return {
    origin,
    entryUrl: `${origin}${entryResource}`,
    requestHeaders: Object.freeze({ [MOUNT_HEADER]: secret }),
    isAllowedUrl(rawUrl) {
      if (!isCurrent()) return false;
      try {
        const url = new URL(rawUrl);
        if (url.origin !== origin || url.username || url.password) return false;
        return (
          canonicalHostedCanvasResource(`${url.pathname}${url.search}`, options.documentId) !== null
        );
      } catch {
        return false;
      }
    },
    close,
  };
}
