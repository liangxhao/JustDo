import type { BrowserHistoryEntry } from '@shared/browser/browser';
import {
  getBrowserLocalFilePath,
  isTemporaryBrowserPreviewUrl,
} from '@shared/browser/browserHistory';

export interface RecentBrowserVisit {
  url: string;
  title: string;
  host: string;
  faviconUrl: string;
}

const MAX_RECENT_VISITS = 4;

export function selectRecentBrowserVisits(
  entries: readonly BrowserHistoryEntry[],
): RecentBrowserVisit[] {
  const visits: RecentBrowserVisit[] = [];
  const seen = new Set<string>();
  for (const entry of [...entries].sort((a, b) => b.lastVisitAt - a.lastVisitAt)) {
    try {
      const parsed = new URL(entry.url);
      const localFilePath = getBrowserLocalFilePath(entry.url);
      if (
        (!['https:', 'http:'].includes(parsed.protocol) && localFilePath === null) ||
        parsed.username ||
        parsed.password ||
        isTemporaryBrowserPreviewUrl(entry.url)
      )
        continue;
      const url = parsed.href;
      if (seen.has(url)) continue;
      seen.add(url);
      const host = localFilePath ?? parsed.hostname.replace(/^www\./, '');
      let faviconUrl = localFilePath === null ? new URL('/favicon.ico', parsed).href : '';
      if (entry.faviconUrl && localFilePath === null) {
        try {
          const icon = new URL(entry.faviconUrl);
          if (['https:', 'http:'].includes(icon.protocol) && !icon.username && !icon.password) {
            faviconUrl = icon.href;
          }
        } catch {
          // Old or invalid icon metadata falls back to the site's favicon.
        }
      }
      const fallbackTitle = localFilePath?.split(/[\\/]/u).pop() || host;
      visits.push({ url, host, title: entry.title.trim() || fallbackTitle, faviconUrl });
      if (visits.length === MAX_RECENT_VISITS) break;
    } catch {
      // Invalid or unsupported history entries are not launch targets.
    }
  }
  return visits;
}
