import type { WebContents } from 'electron';
import { EventEmitter } from 'events';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('./browserDataImportService', () => ({
  recordBrowserHistory: vi.fn(),
  updateBrowserHistoryFavicon: vi.fn(),
}));

import { recordBrowserHistory, updateBrowserHistoryFavicon } from './browserDataImportService';
import { trackBrowserHistory } from './browserHistoryTracking';

function createGuest(shouldRecord = () => true) {
  const guest = Object.assign(new EventEmitter(), {
    getURL: vi.fn(() => 'https://example.com/docs'),
    getTitle: vi.fn(() => 'Docs'),
  });
  trackBrowserHistory(
    guest as unknown as Pick<WebContents, 'on' | 'getURL' | 'getTitle'>,
    shouldRecord,
  );
  return guest;
}

beforeEach(() => vi.clearAllMocks());

describe('browser history tracking', () => {
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
    guest.emit('page-favicon-updated', {}, ['https://example.com/brand.png']);
    guest.emit('did-stop-loading');
    expect(recordBrowserHistory).not.toHaveBeenCalled();
    expect(updateBrowserHistoryFavicon).not.toHaveBeenCalled();
  });
});
