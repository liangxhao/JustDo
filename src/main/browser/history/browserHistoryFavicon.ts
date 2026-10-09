import { session } from 'electron';

import {
  BROWSER_PANEL_PARTITION,
  type BrowserHistoryFaviconResult,
  isBrowserFaviconDataUrl,
} from '../../../shared/browser/browser';
import { isAllowedBrowserPanelUrl } from '../../core/window/browserPanelSecurity';
import {
  readBrowserHistoryFavicon,
  updateBrowserHistoryFaviconData,
} from '../data/browserDataImportService';
import { loadBrowserFavicon } from './browserFavicon';
import { getBrowserFaviconCacheSignal } from './browserFaviconCache';

const pending = new Map<
  string,
  { cacheSignal: AbortSignal; operation: Promise<BrowserHistoryFaviconResult> }
>();
const MAX_CONCURRENT_HISTORY_FAVICONS = 4;
const MAX_PENDING_HISTORY_FAVICONS = 16;
const failure = (): BrowserHistoryFaviconResult => ({
  success: false,
  errorCode: 'load_failed',
});

type QueuedFavicon = {
  signal: AbortSignal;
  run: () => Promise<BrowserHistoryFaviconResult>;
  resolve: (result: BrowserHistoryFaviconResult) => void;
  cancel: () => void;
};
const queue: QueuedFavicon[] = [];
let activeRequests = 0;

function startQueuedFavicons(): void {
  while (activeRequests < MAX_CONCURRENT_HISTORY_FAVICONS && queue.length) {
    const request = queue.shift()!;
    request.signal.removeEventListener('abort', request.cancel);
    if (request.signal.aborted) {
      request.resolve(failure());
      continue;
    }
    activeRequests += 1;
    void request
      .run()
      .then(request.resolve, () => request.resolve(failure()))
      .finally(() => {
        activeRequests -= 1;
        startQueuedFavicons();
      });
  }
}

function scheduleFavicon(
  signal: AbortSignal,
  run: () => Promise<BrowserHistoryFaviconResult>,
): Promise<BrowserHistoryFaviconResult> {
  if (signal.aborted || activeRequests + queue.length >= MAX_PENDING_HISTORY_FAVICONS) {
    return Promise.resolve(failure());
  }
  const operation = new Promise<BrowserHistoryFaviconResult>(resolve => {
    const request: QueuedFavicon = {
      signal,
      run,
      resolve,
      cancel: () => {
        const index = queue.indexOf(request);
        if (index < 0) return;
        queue.splice(index, 1);
        resolve(failure());
      },
    };
    queue.push(request);
    signal.addEventListener('abort', request.cancel, { once: true });
  });
  startQueuedFavicons();
  return operation;
}

export async function loadBrowserHistoryFavicon(
  url: unknown,
  retry: unknown = false,
): Promise<BrowserHistoryFaviconResult> {
  if (
    typeof url !== 'string' ||
    url.length > 4_096 ||
    !/^https?:\/\//iu.test(url) ||
    !isAllowedBrowserPanelUrl(url) ||
    typeof retry !== 'boolean'
  ) {
    return { success: false, errorCode: 'invalid_request' };
  }
  const parsed = new URL(url);
  if (parsed.username || parsed.password) return { success: false, errorCode: 'invalid_request' };
  const record = readBrowserHistoryFavicon(url);
  if (!record) return { success: false, errorCode: 'not_found' };
  if (!retry && isBrowserFaviconDataUrl(record.faviconDataUrl)) {
    return { success: true, dataUrl: record.faviconDataUrl };
  }
  const cacheSignal = getBrowserFaviconCacheSignal();
  const existing = pending.get(url);
  if (existing?.cacheSignal === cacheSignal) return existing.operation;
  const signal = AbortSignal.any([cacheSignal, AbortSignal.timeout(10_000)]);
  const operation = scheduleFavicon(signal, async (): Promise<BrowserHistoryFaviconResult> => {
    const dataUrl = await loadBrowserFavicon(
      session.fromPartition(BROWSER_PANEL_PARTITION),
      url,
      !retry && record.faviconUrl ? [record.faviconUrl] : [],
      signal,
    );
    if (signal.aborted) return failure();
    const latest = readBrowserHistoryFavicon(url);
    if (!latest) return { success: false, errorCode: 'not_found' };
    if (
      latest.faviconDataUrl !== record.faviconDataUrl &&
      isBrowserFaviconDataUrl(latest.faviconDataUrl)
    ) {
      return { success: true, dataUrl: latest.faviconDataUrl };
    }
    if (
      latest.faviconUrl !== record.faviconUrl ||
      latest.faviconDataUrl !== record.faviconDataUrl
    ) {
      return failure();
    }
    if (!dataUrl) return failure();
    updateBrowserHistoryFaviconData(url, dataUrl);
    return { success: true, dataUrl };
  }).finally(() => {
    if (pending.get(url)?.operation === operation) pending.delete(url);
  });
  pending.set(url, { cacheSignal, operation });
  return operation;
}
