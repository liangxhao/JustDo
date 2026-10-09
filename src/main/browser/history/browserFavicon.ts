import type { Session, WebContents } from 'electron';

import {
  BROWSER_FAVICON_MAX_DATA_URL_LENGTH,
  type BrowserPanelFaviconUpdatedEvent,
  isBrowserFaviconDataUrl,
} from '../../../shared/browser/browser';
import { isAllowedBrowserPanelUrl } from '../../core/window/browserPanelSecurity';
import { getBrowserFaviconCacheSignal } from './browserFaviconCache';
import { fetchBrowserFavicon } from './browserFaviconRequest';

const MAX_FAVICON_BYTES = 256 * 1024;
const FAVICON_TIMEOUT_MS = 10_000;
const MAX_FAVICON_CANDIDATES = 3;
const MAX_FAVICON_REDIRECTS = 3;
const IMAGE_CONTENT_TYPE =
  /^image\/(?:png|jpeg|gif|webp|avif|bmp|svg\+xml|x-icon|vnd\.microsoft\.icon)$/iu;

async function readFavicon(response: Response): Promise<string | undefined> {
  let contentType = response.headers.get('content-type')?.split(';', 1)[0].trim() ?? '';
  const length = Number(response.headers.get('content-length'));
  if (!response.ok || length > MAX_FAVICON_BYTES) {
    await response.body?.cancel();
    return;
  }
  if (!response.body) return;
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_FAVICON_BYTES) {
        await reader.cancel();
        return;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (!bytes) return;
  const data = Buffer.concat(chunks);
  if (!IMAGE_CONTENT_TYPE.test(contentType)) {
    // Some servers serve ICO/PNG files as application/octet-stream or omit MIME.
    const signature = data.subarray(0, 4).toString('hex');
    if (signature === '00000100') contentType = 'image/x-icon';
    else if (data.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') contentType = 'image/png';
    else if (signature.startsWith('ffd8ff')) contentType = 'image/jpeg';
    else if (/^GIF8[79]a$/u.test(data.subarray(0, 6).toString())) contentType = 'image/gif';
    else if (
      data.subarray(0, 4).toString() === 'RIFF' &&
      data.subarray(8, 12).toString() === 'WEBP'
    )
      contentType = 'image/webp';
    else return;
  }
  return `data:${contentType.toLowerCase()};base64,${data.toString('base64')}`;
}

const isAllowedFaviconUrl = (url: string): boolean => {
  if (url.length > 4_096 || !/^https?:\/\//iu.test(url) || !isAllowedBrowserPanelUrl(url))
    return false;
  const parsed = new URL(url);
  return !parsed.username && !parsed.password;
};

// Candidates come from native guest events or stored history, never renderer URLs.
export async function loadBrowserFavicon(
  browserSession: Session,
  pageUrl: string,
  favicons: string[],
  signal: AbortSignal,
  allowResource: (url: string) => boolean = () => true,
): Promise<string | undefined> {
  const allowUrl = (url: string) => isAllowedFaviconUrl(url) && allowResource(url);
  if (signal.aborted || !allowUrl(pageUrl)) return;
  const candidates = [...new Set(favicons)]
    .filter(url => url.length <= BROWSER_FAVICON_MAX_DATA_URL_LENGTH)
    .filter(url => isBrowserFaviconDataUrl(url) || allowUrl(url))
    .slice(0, MAX_FAVICON_CANDIDATES);
  const fallback = new URL('/favicon.ico', pageUrl).href;
  if (!candidates.includes(fallback) && allowUrl(fallback)) candidates.push(fallback);
  for (const candidate of candidates) {
    if (signal.aborted) return;
    if (isBrowserFaviconDataUrl(candidate)) return candidate;
    try {
      let url: string = candidate;
      for (let redirects = 0; redirects <= MAX_FAVICON_REDIRECTS; redirects += 1) {
        if (signal.aborted || !allowUrl(url)) break;
        const response = await fetchBrowserFavicon(browserSession, url, signal);
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location) break;
          url = new URL(location, url).href;
          continue;
        }
        const dataUrl = await readFavicon(response);
        if (signal.aborted) return;
        if (dataUrl) return dataUrl;
        break;
      }
    } catch {
      // Failed or unsupported website icons fall through to the next candidate.
    }
  }
}

// Fetching through the guest session preserves its browser proxy and cookies.
export function trackBrowserFavicon(
  guest: Pick<WebContents, 'id' | 'on' | 'getURL' | 'isDestroyed' | 'session'>,
  publish: (event: BrowserPanelFaviconUpdatedEvent, cacheSignal?: AbortSignal) => void,
  allowResource: (url: string) => boolean = () => true,
): void {
  let controller: AbortController | undefined;
  let attempted = false;
  let lastCandidates = '';
  const cancel = () => {
    controller?.abort();
    controller = undefined;
  };
  const load = (favicons: string[]) => {
    if (guest.isDestroyed()) return;
    const pageUrl = guest.getURL();
    const candidateKey = JSON.stringify(favicons);
    if (attempted && candidateKey === lastCandidates) return;
    attempted = true;
    lastCandidates = candidateKey;
    cancel();
    const current = new AbortController();
    controller = current;
    const cacheSignal = getBrowserFaviconCacheSignal();
    const signal = AbortSignal.any([current.signal, cacheSignal]);
    const timeout = setTimeout(() => current.abort(), FAVICON_TIMEOUT_MS);
    void (async () => {
      const faviconUrl = await loadBrowserFavicon(
        guest.session,
        pageUrl,
        favicons,
        signal,
        allowResource,
      );
      if (faviconUrl && !signal.aborted && !guest.isDestroyed()) {
        publish({ guestId: guest.id, url: guest.getURL(), faviconUrl }, cacheSignal);
      }
    })()
      .catch(() => {
        // A disappearing guest or failed consumer must not reject an event task.
      })
      .finally(() => {
        clearTimeout(timeout);
        if (controller === current) controller = undefined;
      });
  };
  guest.on('did-start-navigation', details => {
    if (details.isMainFrame && !details.isSameDocument) cancel();
  });
  guest.on('did-navigate', (_event, url) => {
    cancel();
    attempted = false;
    lastCandidates = '';
    publish({ guestId: guest.id, url });
  });
  guest.on('page-favicon-updated', (_event, favicons) => load(favicons));
  guest.on('did-stop-loading', () => {
    if (!attempted) load([]);
  });
  guest.on('destroyed', cancel);
}
