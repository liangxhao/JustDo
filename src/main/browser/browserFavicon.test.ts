import type { WebContents } from 'electron';
import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { trackBrowserFavicon } from './browserFavicon';
import { invalidateBrowserFaviconCache } from './browserFaviconCache';

const iconDataUrl = 'data:image/png;base64,aWNvbg==';
const iconResponse = () => new Response('icon', { headers: { 'content-type': 'image/png' } });

function createGuest(allowResource?: (url: string) => boolean) {
  const fetch = vi.fn().mockImplementation(async () => iconResponse());
  const publish = vi.fn();
  const guest = Object.assign(new EventEmitter(), {
    id: 7,
    getURL: vi.fn(() => 'https://example.com/docs'),
    isDestroyed: vi.fn(() => false),
    session: { fetch },
  });
  trackBrowserFavicon(guest as unknown as WebContents, publish, allowResource);
  return { guest, fetch, publish };
}

afterEach(() => vi.useRealTimers());

describe('browser tab favicons', () => {
  it('fetches native icon URLs through the exact guest session with browser cookies', async () => {
    const { guest, fetch, publish } = createGuest();
    guest.emit('page-favicon-updated', {}, ['https://cdn.example.com/icon.png']);
    await vi.waitFor(() =>
      expect(publish).toHaveBeenCalledWith(
        {
          guestId: 7,
          url: 'https://example.com/docs',
          faviconUrl: iconDataUrl,
        },
        expect.any(AbortSignal),
      ),
    );
    expect(fetch).toHaveBeenCalledWith('https://cdn.example.com/icon.png', {
      credentials: 'include',
      redirect: 'manual',
      signal: expect.any(AbortSignal),
    });
    guest.emit('page-favicon-updated', {}, ['https://cdn.example.com/icon.png']);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('tries later native candidates and then the site favicon when icons fail', async () => {
    const { guest, fetch, publish } = createGuest();
    fetch
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValueOnce(
        new Response('not an image', { headers: { 'content-type': 'text/html' } }),
      );
    guest.emit('page-favicon-updated', {}, [
      'https://cdn.example.com/one',
      'https://cdn.example.com/two',
    ]);
    await vi.waitFor(() => expect(publish).toHaveBeenCalled());
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://cdn.example.com/one',
      'https://cdn.example.com/two',
      'https://example.com/favicon.ico',
    ]);
  });

  it('loads the site favicon when no native icon event arrives', async () => {
    const { guest, fetch, publish } = createGuest();
    guest.emit('did-stop-loading');
    await vi.waitFor(() => expect(publish).toHaveBeenCalled());
    expect(fetch.mock.calls[0][0]).toBe('https://example.com/favicon.ico');
  });

  it('recognizes ICO files served without an image MIME type', async () => {
    const { guest, fetch, publish } = createGuest();
    const data = new Uint8Array([0, 0, 1, 0, 1, 0]);
    fetch.mockResolvedValueOnce(
      new Response(data, { headers: { 'content-type': 'application/octet-stream' } }),
    );
    guest.emit('page-favicon-updated', {}, ['https://example.com/favicon.ico']);
    await vi.waitFor(() =>
      expect(publish).toHaveBeenCalledWith(
        {
          guestId: 7,
          url: 'https://example.com/docs',
          faviconUrl: 'data:image/x-icon;base64,AAABAAEA',
        },
        expect.any(AbortSignal),
      ),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('follows allowed relative redirects in the same browser session', async () => {
    const { guest, fetch, publish } = createGuest();
    fetch.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: '/icon.png' } }),
    );
    guest.emit('page-favicon-updated', {}, ['https://example.com/redirect']);
    await vi.waitFor(() => expect(publish).toHaveBeenCalled());
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://example.com/redirect',
      'https://example.com/icon.png',
    ]);
  });

  it('uses bounded inline icons without a network request', async () => {
    const { guest, fetch, publish } = createGuest();
    guest.emit('page-favicon-updated', {}, [iconDataUrl]);
    expect(fetch).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(publish).toHaveBeenCalledWith(
        {
          guestId: 7,
          url: 'https://example.com/docs',
          faviconUrl: iconDataUrl,
        },
        expect.any(AbortSignal),
      ),
    );
  });

  it('rejects privileged URLs, metadata addresses, credentials and out-of-scope resources', async () => {
    const { guest, fetch, publish } = createGuest(
      url => new URL(url).origin === 'https://example.com',
    );
    guest.emit('page-favicon-updated', {}, [
      'file:///private/icon.png',
      'https://169.254.169.254/icon',
      'https://user:password@example.com/icon',
      'https://other.example/icon',
    ]);
    await vi.waitFor(() => expect(publish).toHaveBeenCalled());
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['https://example.com/favicon.ico']);
  });

  it('validates redirect targets before fetching them', async () => {
    const { guest, fetch, publish } = createGuest();
    fetch.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/icon' } }),
    );
    guest.emit('page-favicon-updated', {}, ['https://example.com/redirect']);
    await vi.waitFor(() => expect(publish).toHaveBeenCalled());
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://example.com/redirect',
      'https://example.com/favicon.ico',
    ]);
  });

  it.each([true, false])('rejects oversized icons with declared size: %s', async declared => {
    const { guest, fetch, publish } = createGuest();
    fetch.mockResolvedValueOnce(
      new Response(new Uint8Array(256 * 1024 + 1), {
        headers: {
          'content-type': 'image/png',
          ...(declared ? { 'content-length': String(256 * 1024 + 1) } : {}),
        },
      }),
    );
    guest.emit('page-favicon-updated', {}, ['https://example.com/large']);
    await vi.waitFor(() => expect(publish).toHaveBeenCalled());
    expect(publish.mock.calls[0][0].faviconUrl).toBe(iconDataUrl);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['navigation', 'destroyed', 'new icon', 'cache clearing'])(
    'discards a pending icon after %s',
    async reason => {
      const { guest, fetch, publish } = createGuest();
      let resolve!: (response: Response) => void;
      fetch.mockImplementationOnce(
        () =>
          new Promise<Response>(done => {
            resolve = done;
          }),
      );
      guest.emit('page-favicon-updated', {}, ['https://example.com/old']);
      const signal = fetch.mock.calls[0][1].signal as AbortSignal;
      if (reason === 'navigation') {
        guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
        guest.getURL.mockReturnValue('https://new.example/');
        guest.emit('did-navigate', {}, 'https://new.example/');
        expect(publish).toHaveBeenCalledWith({ guestId: 7, url: 'https://new.example/' });
      } else if (reason === 'destroyed') guest.emit('destroyed');
      else if (reason === 'cache clearing') invalidateBrowserFaviconCache();
      else guest.emit('page-favicon-updated', {}, ['https://example.com/new']);
      expect(signal.aborted).toBe(true);
      resolve(iconResponse());
      await vi.waitFor(() =>
        expect(publish).toHaveBeenCalledTimes(
          reason === 'destroyed' || reason === 'cache clearing' ? 0 : 1,
        ),
      );
      if (reason === 'navigation') expect(publish.mock.calls[0][0].faviconUrl).toBeUndefined();
    },
  );

  it('preserves a pending favicon during same-document and subframe navigation', async () => {
    const { guest, fetch, publish } = createGuest();
    guest.emit('page-favicon-updated', {}, ['https://example.com/icon']);
    guest.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(false);
    await vi.waitFor(() => expect(publish).toHaveBeenCalled());
  });

  it('aborts stalled requests at the timeout', async () => {
    vi.useFakeTimers();
    const { guest, fetch, publish } = createGuest();
    fetch.mockImplementation(
      (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );
    guest.emit('page-favicon-updated', {}, ['https://example.com/icon']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(publish).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('contains consumer failures and still accepts later native updates', async () => {
    const { guest, publish } = createGuest();
    publish.mockImplementationOnce(() => {
      throw new Error('Consumer is unavailable');
    });
    guest.emit('page-favicon-updated', {}, ['https://example.com/first.png']);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    guest.emit('page-favicon-updated', {}, ['https://example.com/second.png']);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
  });
});
