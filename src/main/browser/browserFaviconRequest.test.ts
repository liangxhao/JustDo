import { EventEmitter } from 'node:events';

import type { Session } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  getBrowserProxyCredentials: vi.fn(),
}));

vi.mock('electron', () => ({ net: { request: mocks.request } }));
vi.mock('../core/network/systemProxyPreference', () => ({
  getBrowserProxyCredentials: mocks.getBrowserProxyCredentials,
}));

import { fetchBrowserFavicon } from './browserFaviconRequest';

const credentials = {
  host: 'proxy.example',
  port: 8080,
  username: 'test-user',
  password: 'test-password',
};
const target = 'https://example.com/favicon.ico';

const createSession = (response: Response = new Response('icon')) => {
  const fetch = vi.fn().mockResolvedValue(response);
  const browserSession = { fetch } as unknown as Session;
  return { fetch, browserSession };
};

const createRequest = () => {
  const request = Object.assign(new EventEmitter(), {
    abort: vi.fn(),
    end: vi.fn(),
  });
  request.abort.mockImplementation(() => request.emit('close'));
  mocks.request.mockReturnValue(request);
  return request;
};

const respond = (
  request: EventEmitter,
  body: Buffer = Buffer.from('icon'),
  headers: Record<string, string | string[]> = { 'content-type': ['image/png'] },
) => {
  const response = Object.assign(new EventEmitter(), { statusCode: 200, headers });
  request.emit('response', response);
  response.emit('data', body);
  response.emit('end');
  return response;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getBrowserProxyCredentials.mockReturnValue(credentials);
});

describe('browser favicon proxy authentication', () => {
  it('preserves the usual session fetch path without adding authentication headers', async () => {
    const response = new Response('icon');
    const { browserSession, fetch } = createSession(response);
    const signal = new AbortController().signal;

    await expect(fetchBrowserFavicon(browserSession, target, signal)).resolves.toBe(response);

    expect(fetch).toHaveBeenCalledWith(target, {
      credentials: 'include',
      redirect: 'manual',
      signal,
    });
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('answers only the configured proxy challenge in the exact browser session after a 407', async () => {
    const unauthorized = new Response('proxy challenge', { status: 407 });
    const cancel = vi.spyOn(unauthorized.body!, 'cancel');
    const { browserSession } = createSession(unauthorized);
    const request = createRequest();
    const result = fetchBrowserFavicon(browserSession, target, new AbortController().signal);
    await vi.waitFor(() => expect(request.end).toHaveBeenCalledOnce());
    const callback = vi.fn();
    request.emit('login', { isProxy: true, host: 'PROXY.EXAMPLE', port: 8080 }, callback);
    respond(request);

    expect(await (await result).text()).toBe('icon');
    expect(callback).toHaveBeenCalledWith('test-user', 'test-password');
    expect(cancel).toHaveBeenCalledOnce();
    expect(mocks.request).toHaveBeenCalledWith({
      method: 'GET',
      url: target,
      session: browserSession,
      credentials: 'include',
      redirect: 'manual',
    });
  });

  it('answers an HTTPS CONNECT authentication failure through the native request', async () => {
    const { browserSession, fetch } = createSession();
    fetch.mockRejectedValue(new Error('net::ERR_TUNNEL_CONNECTION_FAILED'));
    const request = createRequest();
    const result = fetchBrowserFavicon(browserSession, target, new AbortController().signal);
    await vi.waitFor(() => expect(request.end).toHaveBeenCalled());
    respond(request);
    expect((await result).status).toBe(200);
  });

  it.each([
    ['source-server challenge', false, 'proxy.example', 8080],
    ['different proxy host', true, 'another.example', 8080],
    ['different proxy port', true, 'proxy.example', 9000],
    ['removed configuration', true, 'proxy.example', 8080],
  ])('withholds configured credentials from a %s', async (reason, isProxy, host, port) => {
    const { browserSession } = createSession(new Response(null, { status: 407 }));
    const request = createRequest();
    const result = fetchBrowserFavicon(browserSession, target, new AbortController().signal);
    await vi.waitFor(() => expect(request.end).toHaveBeenCalled());
    if (reason === 'removed configuration') mocks.getBrowserProxyCredentials.mockReturnValue(null);
    const callback = vi.fn();
    request.emit('login', { isProxy, host, port }, callback);
    respond(request);
    await result;
    expect(callback).toHaveBeenCalledWith();
  });

  it('does not repeat an unsuccessful credential attempt', async () => {
    const { browserSession } = createSession(new Response(null, { status: 407 }));
    const request = createRequest();
    const result = fetchBrowserFavicon(browserSession, target, new AbortController().signal);
    await vi.waitFor(() => expect(request.end).toHaveBeenCalled());
    const first = vi.fn();
    const second = vi.fn();
    request.emit('login', { isProxy: true, host: 'proxy.example', port: 8080 }, first);
    request.emit('login', { isProxy: true, host: 'proxy.example', port: 8080 }, second);
    respond(request);
    await result;
    expect(first).toHaveBeenCalledWith('test-user', 'test-password');
    expect(second).toHaveBeenCalledWith();
  });

  it.each([200, 401, 407])(
    'avoids an authentication fallback for status %s without credentials',
    async status => {
      mocks.getBrowserProxyCredentials.mockReturnValue(null);
      const response = new Response(null, { status });
      const { browserSession } = createSession(response);
      await expect(
        fetchBrowserFavicon(browserSession, target, new AbortController().signal),
      ).resolves.toBe(response);
      expect(mocks.request).not.toHaveBeenCalled();
    },
  );

  it('never handles an origin-server 401 using proxy credentials', async () => {
    const response = new Response(null, { status: 401 });
    const { browserSession } = createSession(response);
    await expect(
      fetchBrowserFavicon(browserSession, target, new AbortController().signal),
    ).resolves.toBe(response);
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('returns redirects to the caller for URL validation instead of following them', async () => {
    const { browserSession } = createSession(new Response(null, { status: 407 }));
    const request = createRequest();
    const result = fetchBrowserFavicon(browserSession, target, new AbortController().signal);
    await vi.waitFor(() => expect(request.end).toHaveBeenCalled());
    request.emit('redirect', 302, 'GET', 'http://169.254.169.254/icon', {
      location: ['http://169.254.169.254/icon'],
    });
    const response = await result;
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('http://169.254.169.254/icon');
    expect(mocks.request).toHaveBeenCalledOnce();
    expect(request.abort).toHaveBeenCalledOnce();
  });

  it.each(['declared', 'streamed'])('aborts an oversized %s authenticated response', async kind => {
    const { browserSession } = createSession(new Response(null, { status: 407 }));
    const request = createRequest();
    const result = fetchBrowserFavicon(browserSession, target, new AbortController().signal);
    const failure = expect(result).rejects.toThrow('size limit');
    await vi.waitFor(() => expect(request.end).toHaveBeenCalled());
    respond(
      request,
      kind === 'streamed' ? Buffer.alloc(256 * 1024 + 1) : Buffer.from('small'),
      kind === 'declared' ? { 'content-length': [String(256 * 1024 + 1)] } : {},
    );
    await failure;
    expect(request.abort).toHaveBeenCalledOnce();
  });

  it('cancels a pending authenticated request with the original timeout or navigation signal', async () => {
    const { browserSession } = createSession(new Response(null, { status: 407 }));
    const request = createRequest();
    const controller = new AbortController();
    const result = fetchBrowserFavicon(browserSession, target, controller.signal);
    const failure = expect(result).rejects.toThrow('navigation');
    await vi.waitFor(() => expect(request.end).toHaveBeenCalled());
    controller.abort(new Error('navigation'));
    await failure;
    expect(request.abort).toHaveBeenCalledOnce();
  });

  it('does not retry unrelated network failures', async () => {
    const { browserSession, fetch } = createSession();
    fetch.mockRejectedValue(new Error('net::ERR_NAME_NOT_RESOLVED'));
    await expect(
      fetchBrowserFavicon(browserSession, target, new AbortController().signal),
    ).rejects.toThrow('ERR_NAME_NOT_RESOLVED');
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('accepts string-valued native headers without splitting them into characters', async () => {
    const { browserSession } = createSession(new Response(null, { status: 407 }));
    const request = createRequest();
    const result = fetchBrowserFavicon(browserSession, target, new AbortController().signal);
    await vi.waitFor(() => expect(request.end).toHaveBeenCalled());
    respond(request, Buffer.from('icon'), { 'content-type': 'image/png' });
    expect((await result).headers.get('content-type')).toBe('image/png');
  });

  it.each(['error', 'abort'])('rejects an authenticated request that ends with %s', async kind => {
    const { browserSession } = createSession(new Response(null, { status: 407 }));
    const request = createRequest();
    const result = fetchBrowserFavicon(browserSession, target, new AbortController().signal);
    const failure = expect(result).rejects.toThrow();
    await vi.waitFor(() => expect(request.end).toHaveBeenCalled());
    request.emit(kind, new Error('request failed'));
    await failure;
  });

  it('allows a native close event before its queued authentication and response callbacks', async () => {
    const { browserSession } = createSession(new Response(null, { status: 407 }));
    const request = createRequest();
    const result = fetchBrowserFavicon(browserSession, target, new AbortController().signal);
    await vi.waitFor(() => expect(request.end).toHaveBeenCalled());
    request.emit('close');
    const callback = vi.fn();
    request.emit('login', { isProxy: true, host: 'proxy.example', port: 8080 }, callback);
    respond(request);
    expect((await result).status).toBe(200);
    expect(callback).toHaveBeenCalledWith('test-user', 'test-password');
  });

  it.each(['response', 'redirect'])(
    'rejects an unsupported %s status without leaking an event exception',
    async kind => {
      const { browserSession } = createSession(new Response(null, { status: 407 }));
      const request = createRequest();
      const result = fetchBrowserFavicon(browserSession, target, new AbortController().signal);
      const failure = expect(result).rejects.toThrow('200 to 599');
      await vi.waitFor(() => expect(request.end).toHaveBeenCalled());
      expect(() => {
        if (kind === 'redirect') request.emit('redirect', 600, 'GET', target, {});
        else {
          const response = Object.assign(new EventEmitter(), { statusCode: 600, headers: {} });
          request.emit('response', response);
          response.emit('end');
        }
      }).not.toThrow();
      await failure;
      expect(request.abort).toHaveBeenCalledOnce();
    },
  );

  it('rejects invalid native response headers through the promise', async () => {
    const { browserSession } = createSession(new Response(null, { status: 407 }));
    const request = createRequest();
    const result = fetchBrowserFavicon(browserSession, target, new AbortController().signal);
    const failure = expect(result).rejects.toThrow();
    await vi.waitFor(() => expect(request.end).toHaveBeenCalled());
    expect(() => respond(request, Buffer.from('icon'), { invalid: ['bad\nheader'] })).not.toThrow();
    await failure;
  });
});
