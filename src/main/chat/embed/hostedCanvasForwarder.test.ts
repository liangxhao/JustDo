import http, { type IncomingMessage, type ServerResponse } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { createHostedCanvasForwarder, type HostedCanvasForwarder } from './hostedCanvasForwarder';
import type { HostedCanvasBinding } from './hostedCanvasSurface';

const NATIVE_CAPABILITY = 'native_lease_value_00000000000';
const DOCUMENT_PATH = '/__openclaw__/canvas/documents/cv_report/index.html';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
});

async function upstreamServer(
  handler?: (request: IncomingMessage, response: ServerResponse) => void,
) {
  const seen: Array<{ url: string; method: string; headers: IncomingMessage['headers'] }> = [];
  const server = http.createServer((request, response) => {
    seen.push({ url: request.url ?? '', method: request.method ?? '', headers: request.headers });
    if (handler) {
      handler(request, response);
      return;
    }
    const isAsset = request.url?.includes('asset.js');
    const body = isAsset
      ? 'window.loadedAsset = true;'
      : '<html><script src="./asset.js"></script>report</html>';
    response.writeHead(200, {
      'Content-Type': isAsset ? 'text/javascript' : 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Content-Security-Policy': "default-src 'self'; connect-src 'none'",
      'X-Frame-Options': 'SAMEORIGIN',
      'Set-Cookie': `nativeAuth=${NATIVE_CAPABILITY}; HttpOnly`,
      'Content-Location': `/__openclaw__/cap/${NATIVE_CAPABILITY}${DOCUMENT_PATH}`,
      'X-Internal-Token': NATIVE_CAPABILITY,
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test address.');
  const origin = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  let current = true;
  const retired = new Set<() => void>();
  const binding: HostedCanvasBinding = {
    gatewayOrigin: origin,
    generation: 1,
    profileId: 'test-profile',
    isCurrent: () => current,
    async getResourceUrl(resource) {
      return new URL(`${origin}/__openclaw__/cap/${NATIVE_CAPABILITY}${resource}`);
    },
    onRetired(listener) {
      retired.add(listener);
      return () => {
        retired.delete(listener);
      };
    },
  };
  return {
    seen,
    binding,
    origin,
    retire() {
      current = false;
      for (const listener of retired) listener();
      retired.clear();
    },
  };
}

async function mount(binding: HostedCanvasBinding, isMountCurrent = () => true) {
  const result = await createHostedCanvasForwarder({
    documentId: 'cv_report',
    entryPath: 'index.html',
    binding,
    isMountCurrent,
  });
  cleanups.push(() => result.close());
  return result;
}

function rawRequest(
  forwarder: HostedCanvasForwarder,
  pathname: string,
  method = 'GET',
  extraHeaders: Record<string, string> = {},
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const url = new URL(forwarder.origin);
    const request = http.request(
      {
        host: url.hostname,
        port: url.port,
        method,
        path: pathname,
        headers: { ...forwarder.requestHeaders, ...extraHeaders },
        agent: false,
      },
      response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => {
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    request.on('error', reject);
    request.end();
  });
}

describe('Main exact hosted Canvas document forwarding', () => {
  it('reads plain HTML and relative assets with no Widget receipt and keeps native credentials in Main', async () => {
    const upstream = await upstreamServer();
    const forwarder = await mount(upstream.binding);
    expect(upstream.seen.map(request => request.method)).toEqual(['HEAD']);
    expect(forwarder.entryUrl).toBe(`${forwarder.origin}${DOCUMENT_PATH}`);
    expect(forwarder.entryUrl).not.toContain(NATIVE_CAPABILITY);
    const page = await fetch(forwarder.entryUrl, {
      headers: {
        ...forwarder.requestHeaders,
        cookie: 'guestCookie=private',
        authorization: 'Bearer browser-private',
      },
    });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('report');
    expect(page.headers.get('content-security-policy')).toBe(
      "default-src 'self'; connect-src 'none'",
    );
    expect(page.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('set-cookie')).toBeNull();
    expect(page.headers.get('content-location')).toBeNull();
    expect(page.headers.get('x-internal-token')).toBeNull();
    const asset = await fetch(new URL('./asset.js?v=1', forwarder.entryUrl), {
      headers: forwarder.requestHeaders,
    });
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain('loadedAsset');
    expect(upstream.seen[1].headers.cookie).toBeUndefined();
    expect(upstream.seen[1].headers.authorization).toBeUndefined();
    expect(upstream.seen[1].headers['x-canvas-mount']).toBeUndefined();
    expect(upstream.seen[1].url).toBe(`/__openclaw__/cap/${NATIVE_CAPABILITY}${DOCUMENT_PATH}`);
  });

  it('uses a distinct authenticated origin for each mount and does not cache source HTML', async () => {
    const upstream = await upstreamServer();
    const a = await mount(upstream.binding);
    const b = await mount(upstream.binding);
    expect(a.origin).not.toBe(b.origin);
    expect(a.requestHeaders).not.toEqual(b.requestHeaders);
    expect((await fetch(a.entryUrl)).status).toBe(403);
    expect((await fetch(a.entryUrl, { headers: b.requestHeaders })).status).toBe(403);
    await fetch(a.entryUrl, { headers: a.requestHeaders });
    await fetch(a.entryUrl, { headers: a.requestHeaders });
    expect(upstream.seen.filter(request => request.method === 'GET')).toHaveLength(2);
    expect(a.isAllowedUrl(b.entryUrl)).toBe(false);
    expect(a.isAllowedUrl(`${a.origin}/health`)).toBe(false);
    expect(a.isAllowedUrl(a.entryUrl)).toBe(true);
  });

  it('rejects raw traversal, cross-document reads, control routes, writes and a forged Host before native access', async () => {
    const upstream = await upstreamServer();
    const forwarder = await mount(upstream.binding);
    const paths = [
      '/__openclaw__/canvas/documents/cv_other/index.html',
      '/__openclaw__/canvas/documents/cv_report/../cv_other/index.html',
      '/__openclaw__/canvas/documents/cv_report/%2e%2e/cv_other/index.html',
      '/__openclaw__/canvas/documents/cv_report/assets%2fprivate.html',
      '/__openclaw__/canvas/documents/cv_report/index.html?oc_cap=forged',
      '/__openclaw__/cap/forged/health',
      '/health',
    ];
    for (const pathname of paths) expect((await rawRequest(forwarder, pathname)).status).toBe(404);
    expect((await rawRequest(forwarder, DOCUMENT_PATH, 'POST')).status).toBe(405);
    expect(
      (await rawRequest(forwarder, DOCUMENT_PATH, 'GET', { host: 'gateway.example' })).status,
    ).toBe(403);
    expect(upstream.seen).toHaveLength(1);
  });

  it('refuses redirects and discards upstream errors without reflecting capability material', async () => {
    const upstream = await upstreamServer((request, response) => {
      if (request.method === 'HEAD') {
        response.writeHead(200, { 'Content-Type': 'text/html' }).end();
        return;
      }
      response.writeHead(302, {
        location: `${NATIVE_CAPABILITY}/private`,
        'Content-Type': 'text/plain',
      });
      response.end(`private upstream error ${NATIVE_CAPABILITY}`);
    });
    const forwarder = await mount(upstream.binding);
    const response = await fetch(forwarder.entryUrl, { headers: forwarder.requestHeaders });
    expect(response.status).toBe(503);
    expect(response.headers.get('location')).toBeNull();
    expect(await response.text()).not.toContain(NATIVE_CAPABILITY);
    expect(upstream.seen).toHaveLength(2);
  });

  it('rejects a policy containing the native capability without stripping that policy', async () => {
    const upstream = await upstreamServer((_request, response) => {
      response
        .writeHead(200, {
          'Content-Type': 'text/html',
          'Content-Security-Policy': `script-src http://127.0.0.1/__openclaw__/cap/${NATIVE_CAPABILITY}`,
        })
        .end();
    });
    await expect(mount(upstream.binding)).rejects.toThrow('Hosted document is unavailable.');
  });

  it('stops scope admission when a mount retires and closes its origin when the native client retires', async () => {
    const upstream = await upstreamServer();
    let current = true;
    const forwarder = await mount(upstream.binding, () => current);
    current = false;
    expect(forwarder.isAllowedUrl(forwarder.entryUrl)).toBe(false);
    expect((await fetch(forwarder.entryUrl, { headers: forwarder.requestHeaders })).status).toBe(
      403,
    );
    current = true;
    upstream.retire();
    expect(forwarder.isAllowedUrl(forwarder.entryUrl)).toBe(false);
    await expect(
      fetch(forwarder.entryUrl, { headers: forwarder.requestHeaders }),
    ).rejects.toThrow();
    await forwarder.close();
    await forwarder.close();
  });

  it('aborts an active static stream when its exact native client is retired', async () => {
    const upstream = await upstreamServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      if (request.method === 'HEAD') {
        response.end();
        return;
      }
      response.write('<html>partial document');
    });
    const forwarder = await mount(upstream.binding);
    const response = await fetch(forwarder.entryUrl, { headers: forwarder.requestHeaders });
    upstream.retire();
    await expect(response.text()).rejects.toThrow();
    expect(forwarder.isAllowedUrl(forwarder.entryUrl)).toBe(false);
  });

  it('rejects an absent document at initial HEAD without fetching or retaining a body', async () => {
    const upstream = await upstreamServer((_request, response) => {
      response.writeHead(404, { 'Content-Type': 'text/plain' }).end(`private ${NATIVE_CAPABILITY}`);
    });
    await expect(mount(upstream.binding)).rejects.toThrow('Hosted document is unavailable.');
    expect(upstream.seen.map(request => request.method)).toEqual(['HEAD']);
  });
});
