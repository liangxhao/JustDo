import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clearData: vi.fn(),
  clearStorageData: vi.fn(),
  getCookies: vi.fn(),
  clearDownloads: vi.fn(),
  clearHistory: vi.fn(),
  clearFaviconData: vi.fn(),
  clearCredentials: vi.fn(),
  countDownloads: vi.fn(),
  countHistory: vi.fn(),
  countCredentials: vi.fn(),
  listProfiles: vi.fn(),
}));

vi.mock('electron', () => ({
  session: {
    fromPartition: vi.fn(() => ({
      clearData: mocks.clearData,
      clearStorageData: mocks.clearStorageData,
      cookies: { get: mocks.getCookies },
    })),
  },
}));

vi.mock('./browserDataImportService', () => ({
  clearBrowserDownloadsSince: mocks.clearDownloads,
  clearBrowserHistorySince: mocks.clearHistory,
  clearBrowserHistoryFaviconDataSince: mocks.clearFaviconData,
  clearImportedCredentialsSince: mocks.clearCredentials,
  countBrowserDownloadsSince: mocks.countDownloads,
  countBrowserHistorySince: mocks.countHistory,
  countImportedCredentialsSince: mocks.countCredentials,
  listImportedBrowserProfiles: mocks.listProfiles,
}));

import {
  browserClearDataSince,
  clearBrowserData,
  getBrowserClearDataSummary,
  isBrowserClearDataRequest,
} from './browserClearDataService';

describe('browserClearDataService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.clearData.mockResolvedValue(undefined);
    mocks.clearStorageData.mockResolvedValue(undefined);
    mocks.getCookies.mockResolvedValue([
      { domain: '.example.com' },
      { domain: 'example.com' },
      { domain: '.openai.com' },
    ]);
    mocks.countHistory.mockReturnValue({ count: 3, latestOrigin: 'example.com' });
    mocks.countDownloads.mockReturnValue(2);
    mocks.countCredentials.mockReturnValue(1);
    mocks.clearHistory.mockReturnValue(3);
    mocks.clearDownloads.mockReturnValue(2);
    mocks.clearCredentials.mockReturnValue(1);
    mocks.listProfiles.mockReturnValue([]);
  });

  it('resolves bounded ranges and preserves all-time as an unbounded query', () => {
    expect(browserClearDataSince('hour', 10_000_000)).toBe(6_400_000);
    expect(browserClearDataSince('all', 10_000_000)).toBeNull();
  });

  it('rejects malformed requests and empty selections', async () => {
    expect(isBrowserClearDataRequest({ range: 'forever', selection: {} })).toBe(false);
    await expect(
      clearBrowserData({
        range: 'all',
        selection: {
          history: false,
          cookiesAndSiteData: false,
          cache: false,
          downloads: false,
          autofill: false,
        },
      }),
    ).resolves.toEqual({ success: false, errorCode: 'invalid-request' });
  });

  it('summarizes records for the selected range and deduplicates cookie sites', async () => {
    const result = await getBrowserClearDataSummary('week');

    expect(result).toEqual({
      success: true,
      summary: {
        history: 3,
        latestHistoryOrigin: 'example.com',
        cookieSites: 2,
        downloads: 2,
        autofill: 1,
      },
    });
    expect(mocks.countHistory).toHaveBeenCalledWith(expect.any(Number));
  });

  it('clears only selected record stores and Chromium data types', async () => {
    const result = await clearBrowserData({
      range: 'day',
      selection: {
        history: true,
        cookiesAndSiteData: true,
        cache: true,
        downloads: false,
        autofill: true,
      },
    });

    expect(result).toEqual({
      success: true,
      cleared: {
        history: 3,
        latestHistoryOrigin: '',
        cookieSites: 2,
        downloads: 0,
        autofill: 1,
      },
    });
    expect(mocks.clearStorageData).toHaveBeenCalledWith({
      storages: [
        'cookies',
        'filesystem',
        'indexdb',
        'localstorage',
        'websql',
        'serviceworkers',
        'cachestorage',
      ],
    });
    expect(mocks.clearData).toHaveBeenCalledWith({ dataTypes: ['cache'] });
    expect(mocks.clearFaviconData).toHaveBeenCalledWith(mocks.clearHistory.mock.calls[0][0]);
    expect(mocks.clearHistory).toHaveBeenCalledWith(expect.any(Number));
    expect(mocks.clearDownloads).not.toHaveBeenCalled();
    expect(mocks.clearCredentials).toHaveBeenCalledWith(expect.any(Number));
  });

  it('continues clearing independent categories and reports partial failure', async () => {
    mocks.clearData.mockRejectedValueOnce(new Error('cache busy'));

    const result = await clearBrowserData({
      range: 'all',
      selection: {
        history: true,
        cookiesAndSiteData: false,
        cache: true,
        downloads: true,
        autofill: false,
      },
    });

    expect(result).toEqual({
      success: false,
      errorCode: 'clear-failed',
      cleared: {
        history: 3,
        latestHistoryOrigin: '',
        cookieSites: 0,
        downloads: 2,
        autofill: 0,
      },
      failedCategories: ['cache'],
    });
    expect(mocks.clearHistory).toHaveBeenCalledWith(null);
    expect(mocks.clearDownloads).toHaveBeenCalledWith(null);
  });

  it('does not report cookie sites as cleared when storage deletion fails', async () => {
    mocks.clearStorageData.mockRejectedValueOnce(new Error('storage busy'));

    const result = await clearBrowserData({
      range: 'all',
      selection: {
        history: false,
        cookiesAndSiteData: true,
        cache: false,
        downloads: false,
        autofill: false,
      },
    });

    expect(result).toMatchObject({
      success: false,
      cleared: { cookieSites: 0 },
      failedCategories: ['cookiesAndSiteData'],
    });
  });
});
