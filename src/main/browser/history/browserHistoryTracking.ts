import type { WebContents } from 'electron';

import {
  type BrowserHistoryVisit,
  recordBrowserHistory,
  updateBrowserHistoryFavicon,
  updateBrowserHistoryFaviconData,
  updateBrowserHistoryTitle,
} from '../data/browserDataImportService';
import { sanitizeBrowserHistoryUrl } from '../data/browserDataSanitizers';
import { getBrowserFaviconCacheSignal } from './browserFaviconCache';

export function trackBrowserHistory(
  guest: Pick<WebContents, 'on' | 'getURL' | 'getTitle'>,
  shouldRecord: () => boolean,
): (dataUrl: string, cacheSignal?: AbortSignal) => void {
  let faviconUrl: string | undefined;
  let faviconDataUrl: string | undefined;
  let faviconCacheSignal: AbortSignal | undefined;
  let lastVisit: { url: string; title: string; visit: BrowserHistoryVisit } | undefined;
  const persistHistory = (write: () => void) => {
    try {
      write();
    } catch {
      console.warn('[BrowserHistory] Could not persist browser history metadata.');
    }
  };
  const saveFaviconData = (dataUrl: string) =>
    persistHistory(() => updateBrowserHistoryFaviconData(guest.getURL(), dataUrl));
  guest.on('did-start-navigation', details => {
    if (details.isMainFrame && !details.isSameDocument) {
      lastVisit = undefined;
      faviconUrl = undefined;
      faviconDataUrl = undefined;
      faviconCacheSignal = undefined;
    }
  });
  guest.on('page-favicon-updated', (_event, favicons) => {
    if (!shouldRecord()) return;
    faviconUrl = favicons
      .map(sanitizeBrowserHistoryUrl)
      .find((value): value is string => Boolean(value));
    if (faviconUrl) persistHistory(() => updateBrowserHistoryFavicon(guest.getURL(), faviconUrl!));
  });
  guest.on('did-stop-loading', () => {
    if (!shouldRecord()) return;
    persistHistory(() => {
      const url = guest.getURL();
      const title = guest.getTitle();
      const visit = recordBrowserHistory(url, title, faviconUrl);
      lastVisit = visit ? { url, title, visit } : undefined;
    });
    if (faviconDataUrl && !faviconCacheSignal?.aborted) saveFaviconData(faviconDataUrl);
  });
  guest.on('page-title-updated', (_event, title) => {
    const visit = lastVisit;
    if (!visit || !shouldRecord() || !title.trim() || title === visit.title || guest.getURL() !== visit.url) return;
    persistHistory(() => {
      updateBrowserHistoryTitle(visit.url, title, visit.visit);
      lastVisit = { ...visit, title };
    });
  });
  return (dataUrl, cacheSignal = getBrowserFaviconCacheSignal()) => {
    if (!shouldRecord() || cacheSignal.aborted) return;
    faviconDataUrl = dataUrl;
    faviconCacheSignal = cacheSignal;
    saveFaviconData(dataUrl);
  };
}
