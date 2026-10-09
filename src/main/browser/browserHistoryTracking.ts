import type { WebContents } from 'electron';

import {
  recordBrowserHistory,
  updateBrowserHistoryFavicon,
  updateBrowserHistoryFaviconData,
} from './browserDataImportService';
import { sanitizeBrowserHistoryUrl } from './browserDataSanitizers';
import { getBrowserFaviconCacheSignal } from './browserFaviconCache';

export function trackBrowserHistory(
  guest: Pick<WebContents, 'on' | 'getURL' | 'getTitle'>,
  shouldRecord: () => boolean,
): (dataUrl: string, cacheSignal?: AbortSignal) => void {
  let faviconUrl: string | undefined;
  let faviconDataUrl: string | undefined;
  let faviconCacheSignal: AbortSignal | undefined;
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
    persistHistory(() => recordBrowserHistory(guest.getURL(), guest.getTitle(), faviconUrl));
    if (faviconDataUrl && !faviconCacheSignal?.aborted) saveFaviconData(faviconDataUrl);
  });
  return (dataUrl, cacheSignal = getBrowserFaviconCacheSignal()) => {
    if (!shouldRecord() || cacheSignal.aborted) return;
    faviconDataUrl = dataUrl;
    faviconCacheSignal = cacheSignal;
    saveFaviconData(dataUrl);
  };
}
