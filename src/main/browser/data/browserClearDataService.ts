import { session } from 'electron';

import {
  BROWSER_IMPORTED_PROFILE_PARTITION,
  BROWSER_PANEL_PARTITION,
  type BrowserClearDataRange,
  type BrowserClearDataRequest,
  type BrowserClearDataResult,
  type BrowserClearDataSummary,
  type BrowserClearDataSummaryResult,
  browserPartitionForProfile,
  isBrowserClearDataRange,
} from '../../../shared/browser/browser';
import {
  clearBrowserDownloadsSince,
  clearBrowserHistoryFaviconDataSince,
  clearBrowserHistorySince,
  clearImportedCredentialsSince,
  countBrowserDownloadsSince,
  countBrowserHistorySince,
  countImportedCredentialsSince,
  listImportedBrowserProfiles,
} from './browserDataImportService';

const RANGE_DURATION_MS: Record<Exclude<BrowserClearDataRange, 'all'>, number> = {
  hour: 60 * 60 * 1_000,
  day: 24 * 60 * 60 * 1_000,
  week: 7 * 24 * 60 * 60 * 1_000,
  'four-weeks': 28 * 24 * 60 * 60 * 1_000,
};

export const browserClearDataSince = (
  range: BrowserClearDataRange,
  now = Date.now(),
): number | null => (range === 'all' ? null : now - RANGE_DURATION_MS[range]);

const isValidSelection = (value: unknown): value is BrowserClearDataRequest['selection'] => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return ['history', 'cookiesAndSiteData', 'cache', 'downloads', 'autofill'].every(
    key => typeof record[key] === 'boolean',
  );
};

export const isBrowserClearDataRequest = (value: unknown): value is BrowserClearDataRequest => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return isBrowserClearDataRange(record.range) && isValidSelection(record.selection);
};

const cookieSiteCount = async (): Promise<number> => {
  const partitions = new Set([
    BROWSER_PANEL_PARTITION,
    BROWSER_IMPORTED_PROFILE_PARTITION,
    ...listImportedBrowserProfiles().map(browserPartitionForProfile),
  ]);
  const cookies = (
    await Promise.all(
      [...partitions].map(partition =>
        session.fromPartition(partition).cookies.get({}),
      ),
    )
  ).flat();
  return new Set(cookies.map(cookie => cookie.domain.replace(/^\./, '').toLowerCase())).size;
};

export const getBrowserClearDataSummary = async (
  range: BrowserClearDataRange,
): Promise<BrowserClearDataSummaryResult> => {
  try {
    const since = browserClearDataSince(range);
    const history = countBrowserHistorySince(since);
    const [cookieSites] = await Promise.all([cookieSiteCount()]);
    return {
      success: true,
      summary: {
        history: history.count,
        latestHistoryOrigin: history.latestOrigin,
        cookieSites,
        downloads: countBrowserDownloadsSince(since),
        autofill: countImportedCredentialsSince(since),
      },
    };
  } catch {
    return { success: false };
  }
};

export const clearBrowserData = async (
  request: BrowserClearDataRequest,
): Promise<BrowserClearDataResult> => {
  if (!isBrowserClearDataRequest(request) || !Object.values(request.selection).some(Boolean)) {
    return { success: false, errorCode: 'invalid-request' };
  }
  const since = browserClearDataSince(request.range);
  const failedCategories: Array<keyof BrowserClearDataRequest['selection']> = [];
  const cleared: BrowserClearDataSummary = {
    history: 0,
    latestHistoryOrigin: '',
    cookieSites: 0,
    downloads: 0,
    autofill: 0,
  };
  const browserSessions = [
    ...new Set([
      BROWSER_PANEL_PARTITION,
      BROWSER_IMPORTED_PROFILE_PARTITION,
      ...listImportedBrowserProfiles().map(browserPartitionForProfile),
    ]),
  ].map(partition => session.fromPartition(partition));
  if (request.selection.cookiesAndSiteData) {
    try {
      let cookieSites = 0;
      try {
        cookieSites = await cookieSiteCount();
      } catch {
        // The count is informational and must not prevent the requested deletion.
      }
      await Promise.all(
        browserSessions.map(browserSession =>
          browserSession.clearStorageData({
            storages: [
              'cookies',
              'filesystem',
              'indexdb',
              'localstorage',
              'websql',
              'serviceworkers',
              'cachestorage',
            ],
          }),
        ),
      );
      cleared.cookieSites = cookieSites;
    } catch {
      failedCategories.push('cookiesAndSiteData');
    }
  }
  if (request.selection.cache) {
    try {
      clearBrowserHistoryFaviconDataSince(since);
      await Promise.all(
        browserSessions.map(browserSession => browserSession.clearData({ dataTypes: ['cache'] })),
      );
    } catch {
      failedCategories.push('cache');
    }
  }
  if (request.selection.history) {
    try {
      cleared.history = clearBrowserHistorySince(since);
    } catch {
      failedCategories.push('history');
    }
  }
  if (request.selection.downloads) {
    try {
      cleared.downloads = clearBrowserDownloadsSince(since);
    } catch {
      failedCategories.push('downloads');
    }
  }
  if (request.selection.autofill) {
    try {
      cleared.autofill = clearImportedCredentialsSince(since);
    } catch {
      failedCategories.push('autofill');
    }
  }

  return failedCategories.length
    ? { success: false, errorCode: 'clear-failed', cleared, failedCategories }
    : { success: true, cleared };
};
