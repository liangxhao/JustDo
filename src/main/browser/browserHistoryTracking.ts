import type { WebContents } from 'electron';

import { recordBrowserHistory, updateBrowserHistoryFavicon } from './browserDataImportService';
import { sanitizeBrowserHistoryUrl } from './browserDataSanitizers';

export function trackBrowserHistory(
  guest: Pick<WebContents, 'on' | 'getURL' | 'getTitle'>,
  shouldRecord: () => boolean,
): void {
  let faviconUrl: string | undefined;
  guest.on('did-start-navigation', details => {
    if (details.isMainFrame && !details.isSameDocument) faviconUrl = undefined;
  });
  guest.on('page-favicon-updated', (_event, favicons) => {
    if (!shouldRecord()) return;
    faviconUrl = favicons
      .map(sanitizeBrowserHistoryUrl)
      .find((value): value is string => Boolean(value));
    if (faviconUrl) updateBrowserHistoryFavicon(guest.getURL(), faviconUrl);
  });
  guest.on('did-stop-loading', () => {
    if (shouldRecord()) recordBrowserHistory(guest.getURL(), guest.getTitle(), faviconUrl);
  });
}
