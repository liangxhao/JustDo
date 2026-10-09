import type { WebContents } from 'electron';
import { EventEmitter } from 'events';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../data/browserDataImportService', () => ({
  recordBrowserHistory: vi.fn(),
  updateBrowserHistoryFavicon: vi.fn(),
  updateBrowserHistoryFaviconData: vi.fn(),
}));

import {
  recordBrowserHistory,
  updateBrowserHistoryFavicon,
  updateBrowserHistoryFaviconData,
} from '../data/browserDataImportService';
import { trackBrowserFavicon } from './browserFavicon';
import { getBrowserFaviconCacheSignal, invalidateBrowserFaviconCache } from './browserFaviconCache';
import { trackBrowserHistory } from './browserHistoryTracking';

function createGuest(shouldRecord = () => true) {
  const guest = Object.assign(new EventEmitter(), {
    getURL: vi.fn(() => 'https://example.com/docs'),
    getTitle: vi.fn(() => 'Docs'),
  });
  const recordData = trackBrowserHistory(
    guest as unknown as Pick<WebContents, 'on' | 'getURL' | 'getTitle'>,
    shouldRecord,
  );
  return Object.assign(guest, { recordData });
}

beforeEach(() => vi.clearAllMocks());

describe('browser history tracking', () => {
  test.each(['favicon', 'visit'])(
    'still publishes tab images when %s metadata cannot be saved',
    async kind => {
      const guest = Object.assign(createGuest(), {
        id: 7,
        isDestroyed: () => false,
        session: {
          fetch: vi.fn(
            async () => new Response('icon', { headers: { 'content-type': 'image/png' } }),
          ),
        },
      });
      const publish = vi.fn();
      trackBrowserFavicon(guest as unknown as WebContents, publish);
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const write = kind === 'favicon' ? updateBrowserHistoryFavicon : recordBrowserHistory;
      vi.mocked(write).mockImplementationOnce(() => {
        throw new Error('Database is locked');
      });
      if (kind === 'favicon')
        guest.emit('page-favicon-updated', {}, ['https://example.com/icon.png']);
      else guest.emit('did-stop-loading');
      await vi.waitFor(() =>
        expect(publish).toHaveBeenCalledWith(
          expect.objectContaining({ faviconUrl: 'data:image/png;base64,aWNvbg==' }),
          expect.any(AbortSignal),
        ),
      );
      expect(warning).toHaveBeenCalledOnce();
      warning.mockRestore();
    },
  );
  test('does not restore images captured before cache clearing, including late callbacks', () => {
    const guest = createGuest();
    const cacheSignal = getBrowserFaviconCacheSignal();
    guest.recordData('data:image/png;base64,aWNvbg==', cacheSignal);
    vi.mocked(updateBrowserHistoryFaviconData).mockClear();
    invalidateBrowserFaviconCache();
    guest.emit('did-stop-loading');
    guest.recordData('data:image/png;base64,b2xk', cacheSignal);
    expect(updateBrowserHistoryFaviconData).not.toHaveBeenCalled();
    guest.recordData('data:image/png;base64,bmV3');
    expect(updateBrowserHistoryFaviconData).toHaveBeenCalledWith(
      'https://example.com/docs',
      'data:image/png;base64,bmV3',
    );
  });

  test('keeps image persistence failures from interrupting the consumer', () => {
    const guest = createGuest();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(updateBrowserHistoryFaviconData).mockImplementationOnce(() => {
      throw new Error('Database is read-only');
    });
    expect(() => guest.recordData('data:image/png;base64,aWNvbg==')).not.toThrow();
    guest.emit('did-stop-loading');
    expect(recordBrowserHistory).toHaveBeenCalledTimes(1);
    expect(updateBrowserHistoryFaviconData).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledOnce();
    warning.mockRestore();
  });
  test('saves images arriving before or after the visit is recorded without adding visits', () => {
    const guest = createGuest();
    const dataUrl = 'data:image/png;base64,aWNvbg==';
    guest.recordData(dataUrl);
    guest.emit('did-stop-loading');
    expect(recordBrowserHistory).toHaveBeenCalledTimes(1);
    expect(updateBrowserHistoryFaviconData).toHaveBeenCalledTimes(2);
    guest.recordData('data:image/png;base64,bmV3');
    expect(recordBrowserHistory).toHaveBeenCalledTimes(1);
    expect(updateBrowserHistoryFaviconData).toHaveBeenLastCalledWith(
      'https://example.com/docs',
      'data:image/png;base64,bmV3',
    );
    guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    guest.getURL.mockReturnValue('https://other.example/');
    guest.emit('did-stop-loading');
    expect(updateBrowserHistoryFaviconData).toHaveBeenCalledTimes(3);
  });
  test('records the website favicon when it arrives before the page finishes loading', () => {
    const guest = createGuest();
    guest.emit('page-favicon-updated', {}, [
      'file:///icon.png',
      'https://cdn.example.com/brand.svg',
    ]);
    guest.emit('did-stop-loading');
    expect(recordBrowserHistory).toHaveBeenCalledWith(
      'https://example.com/docs',
      'Docs',
      'https://cdn.example.com/brand.svg',
    );
  });

  test('updates a late favicon independently of the visit count and time', () => {
    const guest = createGuest();
    guest.emit('did-stop-loading');
    guest.emit('page-favicon-updated', {}, ['https://example.com/brand.png']);
    expect(recordBrowserHistory).toHaveBeenCalledTimes(1);
    expect(recordBrowserHistory).toHaveBeenCalledWith(
      'https://example.com/docs',
      'Docs',
      undefined,
    );
    expect(updateBrowserHistoryFavicon).toHaveBeenCalledWith(
      'https://example.com/docs',
      'https://example.com/brand.png',
    );
  });

  test('clears the previous icon when navigating the main frame to a new document', () => {
    const guest = createGuest();
    guest.emit('page-favicon-updated', {}, ['https://example.com/brand.png']);
    guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    guest.getURL.mockReturnValue('https://other.example.com/');
    guest.emit('did-stop-loading');
    expect(recordBrowserHistory).toHaveBeenLastCalledWith(
      'https://other.example.com/',
      'Docs',
      undefined,
    );
  });

  test.each([
    { isMainFrame: false, isSameDocument: false },
    { isMainFrame: true, isSameDocument: true },
  ])('preserves the icon for subframe or same-document navigation: %j', details => {
    const guest = createGuest();
    guest.emit('page-favicon-updated', {}, ['https://example.com/brand.png']);
    guest.emit('did-start-navigation', details);
    guest.emit('did-stop-loading');
    expect(recordBrowserHistory).toHaveBeenCalledWith(
      'https://example.com/docs',
      'Docs',
      'https://example.com/brand.png',
    );
  });

  test('does not persist visits or icons for an excluded local preview', () => {
    const guest = createGuest(() => false);
    guest.recordData('data:image/png;base64,aWNvbg==');
    guest.emit('page-favicon-updated', {}, ['https://example.com/brand.png']);
    guest.emit('did-stop-loading');
    expect(recordBrowserHistory).not.toHaveBeenCalled();
    expect(updateBrowserHistoryFavicon).not.toHaveBeenCalled();
    expect(updateBrowserHistoryFaviconData).not.toHaveBeenCalled();
  });
});
